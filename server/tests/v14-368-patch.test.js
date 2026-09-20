import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../v14.368');

test('v14.368 patch contains the native package contract and proxy hooks', () => {
    const packageSource = fs.readFileSync(path.join(root, 'package.mjs'), 'utf8');
    const viewsSource = fs.readFileSync(path.join(root, 'views.mjs'), 'utf8');
    assert.match(packageSource, /FOUNDRY_PACKAGE_INDEX_URL/);
    assert.match(packageSource, /FOUNDRY_PACKAGE_OWNED_URL/);
    assert.match(packageSource, /FOUNDRY_PACKAGE_DETAILS_URL/);
    assert.match(packageSource, /FOUNDRY_PACKAGE_AUTH_URL/);
    assert.match(packageSource, /fvttProxyUrl/);
    assert.match(packageSource, /e=fvttProxyUrl\(e\)/);
    assert.match(packageSource, /#r\(e,fvttProxyUrl\(i\)/);
    assert.match(viewsSource, /export async function getPackages/);
    assert.doesNotMatch(viewsSource, /getRepositoryPackages\(\)/);
});
