/** Fresh subject-owned tool metadata only. Never import SDK or compiler code. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
const root = '/workspace';
const hash = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function bin(shim, dependencyOwner, dependencyKey, actualName, expectedVersion) {
  const owner = JSON.parse(fs.readFileSync(root + '/' + dependencyOwner, 'utf8'));
  const declared = owner.dependencies?.[dependencyKey] ?? owner.devDependencies?.[dependencyKey];
  if (!declared) throw new Error('Tool lacks canonical declaring owner: ' + dependencyKey);
  const file = fs.realpathSync(root + '/' + shim);
  if (!file.startsWith(root + '/node_modules/')) throw new Error('Borrowed or external tool');
  let directory = path.dirname(file), metadata, manifest;
  while (directory.startsWith(root + '/node_modules/')) {
    const candidate = path.join(directory, 'package.json');
    if (fs.existsSync(candidate)) {
      const data = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      if (data.name === actualName) { metadata = data; manifest = candidate; break; }
    }
    directory = path.dirname(directory);
  }
  if (!metadata || (expectedVersion && metadata.version !== expectedVersion)) throw new Error('Unexpected tool package/version');
  return { shim: root + '/' + shim, file, sha256: hash(file), dependencyOwner, dependencyKey,
    declared, packageName: metadata.name, version: metadata.version, manifest, manifestSHA256: hash(manifest) };
}
const owners = {
  apiTsc: bin('packages/cloud/api/node_modules/.bin/tsc', 'packages/cloud/api/package.json', '@typescript/native', 'typescript', '7.0.2'),
  sharedTsc: bin('packages/cloud/shared/node_modules/.bin/tsc', 'packages/cloud/shared/package.json', '@typescript/native', 'typescript', '7.0.2'),
  emitTsc6: bin('node_modules/.bin/tsc6', 'package.json', '@typescript/typescript6', '@typescript/typescript6', '6.0.2'),
  turbo: bin('node_modules/.bin/turbo', 'package.json', 'turbo', 'turbo', '2.11.10'),
  wrangler: bin('packages/cloud/api/node_modules/.bin/wrangler', 'packages/cloud/api/package.json', 'wrangler', 'wrangler'),
  rollup: bin('plugins/plugin-native-secure-store/node_modules/.bin/rollup', 'plugins/plugin-native-secure-store/package.json', 'rollup', 'rollup'),
};
const library = root + '/node_modules/typescript/package.json';
const metadata = JSON.parse(fs.readFileSync(library, 'utf8'));
if (metadata.name !== 'typescript' || metadata.version !== '6.0.3') throw new Error('Unexpected declaration bundler TypeScript library');
owners.declarationLibrary = { file: fs.realpathSync(library), sha256: hash(library), version: metadata.version,
  scope: 'DTS bundler library metadata; not the normal API tsc executable or compatibility emitter' };
fs.writeFileSync('/results/COMPILER-OWNERS.json', JSON.stringify(owners, null, 2) + '\n');
