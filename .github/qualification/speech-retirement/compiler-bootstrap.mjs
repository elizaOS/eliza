/** Fresh subject-owned tool metadata only. Never import SDK or compiler code. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
const root = '/workspace';
const rootManifest = JSON.parse(fs.readFileSync(root + '/package.json', 'utf8'));
const owners = {};
let currentTool, currentEvidence;
const partial = (state, failure) => fs.writeFileSync('/results/COMPILER-OWNERS-PARTIAL.json', JSON.stringify({ state, currentTool, owners, failure: failure ?? null, scope: 'Metadata probes only; no compiler/typecheck PASS' }, null, 2) + '\n');
const hash = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function bin(shim, dependencyOwner, dependencyKey, actualName, expectedVersion) {
  const owner = JSON.parse(fs.readFileSync(root + '/' + dependencyOwner, 'utf8'));
  const declared = owner.dependencies?.[dependencyKey] ?? owner.devDependencies?.[dependencyKey];
  if (!declared) throw new Error('Tool lacks canonical declaring owner: ' + dependencyKey);
  const evidence = { shim: root + '/' + shim, dependencyOwner, dependencyKey, declared, expectedPackageName: actualName, expectedVersion: expectedVersion ?? null, rootOverride: rootManifest.overrides?.[dependencyKey] ?? null, examinedManifests: [] };
  currentEvidence = evidence;
  partial('PROBING', evidence);
  const file = fs.realpathSync(root + '/' + shim);
  evidence.resolvedFile = file;
  if (!file.startsWith(root + '/node_modules/')) throw new Error('Borrowed or external tool');
  let directory = path.dirname(file), metadata, manifest;
  while (directory.startsWith(root + '/node_modules/')) {
    const candidate = path.join(directory, 'package.json');
    if (fs.existsSync(candidate)) {
      const data = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      evidence.examinedManifests.push({ path: candidate, packageName: data.name ?? null, version: data.version ?? null, sha256: hash(candidate) });
      if (data.name === actualName) { metadata = data; manifest = candidate; break; }
    }
    directory = path.dirname(directory);
  }
  if (!metadata || (expectedVersion && metadata.version !== expectedVersion)) {
    partial('FAILED_OWNER_OR_VERSION', evidence);
    throw new Error('Unexpected tool package/version for ' + dependencyKey + '; source expected ' + actualName + '@' + (expectedVersion ?? 'frozen-lock'));
  }
  return { shim: root + '/' + shim, file, sha256: hash(file), dependencyOwner, dependencyKey,
    declared, rootOverride: evidence.rootOverride, packageName: metadata.name, version: metadata.version, manifest, manifestSHA256: hash(manifest) };
}
function probe(label, operation) {
  currentTool = label; currentEvidence = null;
  try { owners[label] = operation(); partial('PARTIAL_TOOL_METADATA_ONLY'); }
  catch (error) { partial('FAILED_METADATA_PROBE', { message: error.message, expectedAndObserved: currentEvidence }); throw error; }
}
probe('apiTsc', () => bin('packages/cloud/api/node_modules/.bin/tsc', 'packages/cloud/api/package.json', '@typescript/native', 'typescript', '7.0.2'));
probe('sharedTsc', () => bin('packages/cloud/shared/node_modules/.bin/tsc', 'packages/cloud/shared/package.json', '@typescript/native', 'typescript', '7.0.2'));
probe('emitTsc6', () => bin('node_modules/.bin/tsc6', 'package.json', '@typescript/typescript6', '@typescript/typescript6', '6.0.2'));
probe('turbo', () => bin('node_modules/.bin/turbo', 'package.json', 'turbo', 'turbo', '2.11.10'));
probe('wrangler', () => bin('packages/cloud/api/node_modules/.bin/wrangler', 'packages/cloud/api/package.json', 'wrangler', 'wrangler'));
// The declaring dependency key stays "rollup". Its effective supplier is fixed
// by the canonical ROOT override and matching frozen lock, not observed output.
probe('rollup', () => {
  if (rootManifest.overrides?.rollup !== 'npm:@rollup/wasm-node@4.64.9' || rootManifest.overrides?.['@rollup/wasm-node'] !== '4.64.9') throw new Error('Canonical Rollup override changed');
  const lock = fs.readFileSync(root + '/bun.lock', 'utf8');
  if (!/"rollup"\s*:\s*\[\s*"@rollup\/wasm-node@4\.64\.9"/.test(lock)) throw new Error('Canonical Rollup lock supplier changed');
  return bin('plugins/plugin-native-secure-store/node_modules/.bin/rollup', 'plugins/plugin-native-secure-store/package.json', 'rollup', '@rollup/wasm-node', '4.64.9');
});
currentTool = 'declarationLibrary';
const library = root + '/node_modules/typescript/package.json';
const metadata = JSON.parse(fs.readFileSync(library, 'utf8'));
if (metadata.name !== 'typescript' || metadata.version !== '6.0.3') { partial('FAILED_DECLARATION_LIBRARY', { expectedName: 'typescript', expectedVersion: '6.0.3', actualName: metadata.name, actualVersion: metadata.version }); throw new Error('Unexpected declaration bundler TypeScript library'); }
owners.declarationLibrary = { file: fs.realpathSync(library), sha256: hash(library), version: metadata.version,
  scope: 'DTS bundler library metadata; not the normal API tsc executable or compatibility emitter' };
partial('COMPLETE_TOOL_METADATA_ONLY');
fs.writeFileSync('/results/COMPILER-OWNERS.json', JSON.stringify(owners, null, 2) + '\n');
