import test from 'node:test';
import assert from 'node:assert/strict';

import {
    getOwnedPackageNames,
    getProxyKind,
    rewritePackageUrls,
    toLegacyRepositoryResponse,
    toProxyUrl
} from '../utils/fvtt-packages.js';

const proxyBase = 'https://proxy.example.test';

test('only GitHub and GitLab transport URLs are proxied', () => {
    assert.equal(getProxyKind('https://github.com/a/b/releases/download/v1/mod.zip'), 'github');
    assert.equal(getProxyKind('https://raw.githubusercontent.com/a/b/main/module.json'), 'github');
    assert.equal(getProxyKind('https://gitlab.com/a/b/-/raw/main/module.json'), 'gitlab');
    assert.equal(getProxyKind('https://r2.foundryvtt.com/package.zip'), null);
    assert.equal(toProxyUrl('https://r2.foundryvtt.com/package.zip', proxyBase), 'https://r2.foundryvtt.com/package.zip');
});

test('rewrites manifests, downloads and details without rewriting package homepages', () => {
    const input = {
        details: 'https://packages.example.test/details/{id}',
        packages: [{
            type: 'module',
            id: 'demo.module',
            url: 'https://github.com/demo/module',
            manifest: 'https://raw.githubusercontent.com/demo/module/main/module.json',
            download: 'https://github.com/demo/module/releases/download/v1/module.zip'
        }]
    };
    const output = rewritePackageUrls(input, {
        proxyBase,
        detailsProxy: `${proxyBase}/api/fvtt/details/{id}`
    });
    assert.equal(output.details, `${proxyBase}/api/fvtt/details/{id}`);
    assert.equal(output.packages[0].url, input.packages[0].url);
    assert.equal(output.packages[0].manifest, `${proxyBase}/proxy/github/${input.packages[0].manifest}`);
    assert.equal(output.packages[0].download, `${proxyBase}/proxy/github/${input.packages[0].download}`);
});

test('maps the v14.368 index to the legacy package response', () => {
    const response = toLegacyRepositoryResponse({
        packages: [{
            type: 'module',
            id: 'demo.module',
            title: 'Demo Module',
            version: '1.2.3',
            manifest: 'https://proxy.example.test/module.json',
            protected: true,
            compatibility: {minimum: '14.0', verified: '14.368'},
            relationships: {systems: [{id: 'demo.system'}]},
            authors: [{name: 'Author'}],
            tags: ['demo'],
            exclusive: true
        }]
    }, new Set(['demo.module']), 'module');

    assert.deepEqual(response.owned, ['demo.module']);
    assert.equal(response.packages[0].name, 'demo.module');
    assert.equal(response.packages[0].version.version, '1.2.3');
    assert.equal(response.packages[0].version.required_core_version, '14.0');
    assert.deepEqual(response.packages[0].requires, ['demo.system']);
    assert.equal(response.packages[0].owned, true);
});

test('selects the release-compatible segment from the public index schema', () => {
    const response = toLegacyRepositoryResponse({
        packages: [{
            type: 'module',
            id: 'compat.module',
            title: 'Compat Module',
            provider: {name: 'Provider'},
            premium: false,
            requires: ['demo.system'],
            compatibility: [
                {from: '13.0', to: '13.999', version: '1.0.0', manifest: 'old.json'},
                {from: '14.0', version: '2.0.0', manifest: 'new.json'}
            ]
        }]
    }, new Set(), 'module', '14.368');
    assert.equal(response.packages[0].version.version, '2.0.0');
    assert.equal(response.packages[0].version.manifest, 'new.json');
});

test('extracts entitlement names from purchases and subscriptions', () => {
    assert.deepEqual(
        [...getOwnedPackageNames({purchases: [{name: 'one'}], subscriptions: [{name: 'two'}, {}]})].sort(),
        ['one', 'two']
    );
});
