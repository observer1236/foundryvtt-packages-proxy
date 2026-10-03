import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readArchiveFile} from './helpers/zip.js';
import {getProxiedUrl} from '../../client/proxy-routing.mjs';
import {createProxiedFetch, setProxyServer} from '../../client/proxy-helper.mjs';

const raw = 'https://github.com/example/repo/releases/download/v1/package.zip';
const base = 'https://backend.example';

for (const archive of ['client.zip', 'client v12.zip', 'client v13.zip']) {
    for (const file of ['package.mjs', 'views.mjs']) {
        test(`${archive}/${file} routes transport through the failover backend`, () => {
            const source = readArchiveFile(new URL(`../../${archive}`, import.meta.url), file);
            const start = source.indexOf('/** Client transport entry point.');
            const end = source.indexOf(file === 'package.mjs' ? 'class PackageAssetField' : 'export async function getPackages', start);
            assert.ok(start >= 0 && end > start);
            const context = vm.createContext({URL, process: {env: {FVTT_PACKAGE_PROXY_URL: base + '/'}}});
            vm.runInContext(source.slice(start, end), context);
            context.raw = raw;
            assert.equal(vm.runInContext('getProxiedUrl(raw)', context), `${base}/proxy/github/${raw}`);
            context.raw = 'https://gitlab.com/example/repo/-/archive/main/repo.zip';
            assert.equal(vm.runInContext('getProxiedUrl(raw)', context), `${base}/proxy/gitlab/${context.raw}`);
            context.raw = `${base}/proxy/github/${raw}`;
            assert.equal(vm.runInContext('getProxiedUrl(raw)', context), context.raw);
            context.raw = 'https://release-assets.githubusercontent.com/example/package.zip';
            assert.equal(vm.runInContext('getProxiedUrl(raw)', context), `${base}/proxy/github/${context.raw}`);
        });
    }
}

test('shared client routing preserves unrelated URLs', () => {
    const url = 'https://r2.foundryvtt.com/package.zip';
    assert.equal(getProxiedUrl(url), url);
});

test('helper fetch uses the backend without first selecting an external mirror', async t => {
    const calls = [];
    const response = {ok: true};
    t.mock.method(globalThis, 'fetch', async (...args) => { calls.push(args); return response; });
    setProxyServer(base);
    const options = {method: 'GET', headers: {Range: 'bytes=0-100'}};
    assert.equal(await createProxiedFetch()(raw, options), response);
    assert.deepEqual(calls, [[`${base}/proxy/github/${raw}`, options]]);
});
