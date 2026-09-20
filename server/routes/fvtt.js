import { Router } from 'express';
import crypto from 'node:crypto';

import config from '../config.js';
import cacheManager from '../utils/cache.js';
import logger from '../utils/logger.js';
import {
    getOwnedPackageNames,
    rewritePackageUrls,
    toLegacyRepositoryResponse,
    toProxyUrl
} from '../utils/fvtt-packages.js';

const router = Router();
const INDEX_CACHE_KEY = 'fvtt_package_index_v14';
const DETAILS_CACHE_PREFIX = 'fvtt_package_details_v14_';

function getProxyBase() {
    return String(config.server.publicUrl || '').replace(/\/+$/, '');
}

function getTimeoutSignal() {
    return AbortSignal.timeout(Math.max(1000, Number(config.fvtt.timeout) || 15000));
}

async function fetchJson(url, options = {}) {
    const response = await fetch(url, {...options, signal: options.signal ?? getTimeoutSignal()});
    const text = await response.text();
    let data;
    try {
        data = text ? JSON.parse(text) : null;
    } catch {
        const error = new Error(`Upstream returned invalid JSON (${response.status})`);
        error.status = response.status;
        throw error;
    }
    if (!response.ok) {
        const error = new Error(data?.message || data?.error || `Upstream request failed (${response.status})`);
        error.status = response.status;
        error.data = data;
        throw error;
    }
    return data;
}

function getIndexDetailsTemplate(index) {
    return typeof index?.details === 'string' && index.details.includes('{id}') ? index.details : null;
}

async function fetchRawPackageIndex() {
    const cached = config.cache.enabled ? cacheManager.get(INDEX_CACHE_KEY) : null;
    if (cached?.raw) return cached;

    let lastError;
    for (const url of [config.fvtt.packageIndexUrl, config.fvtt.packageIndexFallbackUrl]) {
        try {
            const raw = await fetchJson(url, {method: 'GET', headers: {Accept: 'application/json'}});
            if (!raw || !Array.isArray(raw.packages)) throw new Error('Package index has no packages array');
            const detailsProxy = `${getProxyBase()}/api/fvtt/details/{id}`;
            const transformed = rewritePackageUrls(raw, {
                proxyBase: getProxyBase(),
                detailsProxy
            });
            const result = {raw, transformed, detailsTemplate: getIndexDetailsTemplate(raw)};
            if (config.cache.enabled) cacheManager.set(INDEX_CACHE_KEY, result, config.cache.ttl);
            return result;
        } catch (error) {
            lastError = error;
            logger.warn(`Package index request failed for ${url}: ${error.message}`);
        }
    }
    throw lastError || new Error('Could not retrieve the FVTT package index');
}

async function fetchEntitlements({license, authorization} = {}) {
    if (!license && !authorization) return {purchases: [], subscriptions: []};
    return fetchJson(config.fvtt.entitlementsUrl, {
        method: 'POST',
        headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            ...(authorization ? {Authorization: authorization} : {})
        },
        body: JSON.stringify({license})
    });
}

function getLegacyCacheKey(body) {
    const digest = crypto.createHash('sha256')
        .update(JSON.stringify({type: body?.type || 'system', version: body?.version || '', license: body?.license || null}))
        .digest('hex');
    return `fvtt_packages_legacy_${digest}`;
}

/**
 * GET /api/fvtt/index
 * v14.368 public package index, with package transport URLs rewritten to the
 * local GitHub/GitLab proxy.
 */
router.get('/index', async (req, res) => {
    try {
        const {transformed} = await fetchRawPackageIndex();
        res.set('Cache-Control', 'public, max-age=300');
        res.json(transformed);
    } catch (error) {
        logger.error(`Failed to proxy FVTT package index: ${error.message}`);
        res.status(error.status && error.status >= 400 ? error.status : 502).json({
            error: 'Failed to proxy FVTT package index',
            message: error.message
        });
    }
});

/**
 * GET /api/fvtt/details/:id
 * Retrieve a package's detailed version data from the template advertised by
 * the public index.
 */
router.get('/details/:id', async (req, res) => {
    try {
        const {detailsTemplate} = await fetchRawPackageIndex();
        if (!detailsTemplate) return res.status(404).json({error: 'Package details endpoint is not advertised'});
        const targetUrl = detailsTemplate.replace('{id}', encodeURIComponent(req.params.id));
        const cacheKey = `${DETAILS_CACHE_PREFIX}${req.params.id}`;
        const cached = config.cache.enabled ? cacheManager.get(cacheKey) : null;
        if (cached) return res.json(cached);
        const data = await fetchJson(targetUrl, {method: 'GET', headers: {Accept: 'application/json'}});
        const transformed = rewritePackageUrls(data, {proxyBase: getProxyBase()});
        if (config.cache.enabled) cacheManager.set(cacheKey, transformed, config.cache.ttl);
        res.json(transformed);
    } catch (error) {
        logger.error(`Failed to proxy FVTT package details: ${error.message}`);
        res.status(error.status && error.status >= 400 ? error.status : 502).json({
            error: 'Failed to proxy FVTT package details',
            message: error.message
        });
    }
});

/**
 * POST /api/fvtt/entitlements
 * v14.368 entitlement endpoint. The license and Authorization header are
 * forwarded without being cached in the public index cache.
 */
router.post('/entitlements', async (req, res) => {
    try {
        const data = await fetchEntitlements({
            license: req.body?.license,
            authorization: req.headers.authorization
        });
        res.json(data);
    } catch (error) {
        logger.error(`Failed to proxy FVTT entitlements: ${error.message}`);
        if (error.data && typeof error.data === 'object') {
            return res.status(error.status && error.status >= 400 ? error.status : 502).json(error.data);
        }
        res.status(error.status && error.status >= 400 ? error.status : 502).json({
            error: 'Failed to proxy FVTT entitlements',
            message: error.message
        });
    }
});

/**
 * POST /api/fvtt/packages
 * Compatibility endpoint for the older client patches. It adapts the new
 * v14.368 index and entitlement responses to the former `/packages/get`
 * response shape.
 */
router.post('/packages', async (req, res) => {
    const cacheKey = getLegacyCacheKey(req.body);
    if (config.cache.enabled) {
        const cached = cacheManager.get(cacheKey);
        if (cached) {
            res.set('X-Cache', 'HIT');
            return res.json(cached);
        }
    }

    try {
        const {transformed} = await fetchRawPackageIndex();
        let entitlements = {purchases: [], subscriptions: []};
        try {
            entitlements = await fetchEntitlements({
                license: req.body?.license,
                authorization: req.headers.authorization
            });
        } catch (error) {
            // Free packages remain usable if license entitlement lookup fails.
            logger.warn(`Could not retrieve package entitlements: ${error.message}`);
        }
        const data = toLegacyRepositoryResponse(
            transformed,
            getOwnedPackageNames(entitlements),
            req.body?.type || 'system',
            req.body?.version || ''
        );
        if (config.cache.enabled) cacheManager.set(cacheKey, data);
        res.set('X-Cache', 'MISS');
        res.json(data);
    } catch (error) {
        logger.error(`Failed to proxy FVTT packages: ${error.message}`);
        res.status(error.status && error.status >= 400 ? error.status : 502).json({
            error: 'Failed to proxy FVTT packages',
            message: error.message
        });
    }
});

/**
 * POST /api/fvtt/auth
 * Proxy protected package download authorization. Download URLs pointing to
 * GitHub/GitLab are rewritten to the local proxy as well.
 */
router.post('/auth', async (req, res) => {
    try {
        const data = await fetchJson(config.fvtt.authUrl, {
            method: 'POST',
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
                ...(req.headers.authorization ? {Authorization: req.headers.authorization} : {})
            },
            body: JSON.stringify(req.body)
        });
        if (data && typeof data === 'object' && typeof data.download === 'string') {
            data.download = toProxyUrl(data.download, getProxyBase());
        }
        res.json(data);
    } catch (error) {
        logger.error(`Failed to proxy FVTT auth: ${error.message}`);
        if (error.data && typeof error.data === 'object') {
            return res.status(error.status && error.status >= 400 ? error.status : 502).json(error.data);
        }
        res.status(error.status && error.status >= 400 ? error.status : 502).json({
            error: 'Failed to proxy FVTT auth',
            message: error.message
        });
    }
});

export {fetchEntitlements, fetchRawPackageIndex};
export default router;
