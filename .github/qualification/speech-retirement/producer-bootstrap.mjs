/** Fresh subject-owned tool metadata only. Never import SDK or compiler code. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
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
// Bun's official image supplies bunx as an argv0 entry to this same binary.
probe('bunx', () => {
  const bun = '/usr/local/bin/bun', bunx = '/usr/local/bin/bunx';
  const actual = { bun, bunx, expectedLinkTarget: bun, expectedVersion: '1.4.2' };
  currentEvidence = actual; partial('PROBING', actual);
  actual.isSymbolicLink = fs.lstatSync(bunx).isSymbolicLink();
  if (!actual.isSymbolicLink) throw new Error('Pinned Bunx entry is not the official symlink');
  actual.linkTarget = fs.readlinkSync(bunx);
  if (actual.linkTarget !== bun) throw new Error('Pinned Bunx link target mismatch');
  actual.resolvedFile = fs.realpathSync(bunx);
  if (actual.resolvedFile !== bun || !fs.lstatSync(bun).isFile() || (fs.statSync(bun).mode & 0o111) === 0) {
    throw new Error('Pinned Bunx does not resolve to the executable regular Bun file');
  }
  actual.versions = JSON.parse(fs.readFileSync('/results/versions.log', 'utf8'));
  actual.binarySHA256 = hash(bunx);
  if (actual.versions.bun !== '1.4.2' || actual.binarySHA256 !== actual.versions.bunSHA256 ||
      actual.binarySHA256 !== hash(bun)) throw new Error('Pinned official Bun/bunx entrypoint ownership mismatch');
  const a = fs.statSync(bun), b = fs.statSync(bunx);
  if (a.dev !== b.dev || a.ino !== b.ino) throw new Error('Bunx does not resolve to the same actual Bun file');
  return { shim: bunx, linkTarget: actual.linkTarget, file: actual.resolvedFile,
    sha256: actual.binarySHA256, version: actual.versions.bun,
    supplier: 'docker.io/oven/bun@sha256:296a79bbc988bb0a91ef11099af70a78a8cba98b73fd53f7b2a7715b7c86ced2',
    vendorLayer: 'sha256:995f23d6717fb18d9e3ee7901ce64cf02d5386f0358688dcb35682d362a9fa11',
    scope: 'Read-only metadata; executable was not run by this probe' };
});
probe('emitTsc6', () => bin('node_modules/.bin/tsc6', 'package.json', '@typescript/typescript6', '@typescript/typescript6', '6.0.2'));
probe('turbo', () => bin('node_modules/.bin/turbo', 'package.json', 'turbo', 'turbo', '2.11.10'));

probe('assistantTsup', () => bin('plugins/plugin-assistant/node_modules/.bin/tsup','plugins/plugin-assistant/package.json','tsup','tsup','9.0.0'));
probe('sqlTsup', () => bin('plugins/plugin-sql/node_modules/.bin/tsup','plugins/plugin-sql/package.json','tsup','tsup','9.0.0'));
probe('assistantEsbuild', () => bin('plugins/plugin-assistant/node_modules/.bin/esbuild','plugins/plugin-assistant/package.json','esbuild','esbuild'));
// tsup imports Rollup and TypeScript as package libraries; resolve from each actual tsup owner.
for(const label of ['assistantTsup','sqlTsup']){
 const owner=owners[label],req=createRequire(owner.manifest);
 for(const name of ['typescript','rollup']){
  const manifest=fs.realpathSync(req.resolve(name+'/package.json'));
  if(!manifest.startsWith(root+'/node_modules/'))throw new Error('Borrowed producer library');
  const data=JSON.parse(fs.readFileSync(manifest,'utf8'));
  if(name==='typescript'&&(data.name!=='typescript'||data.version!=='6.0.3'))throw new Error('Wrong declaration TypeScript');
  if(name==='rollup'&&(data.name!=='@rollup/wasm-node'||data.version!=='4.64.9'||rootManifest.overrides?.rollup!=='npm:@rollup/wasm-node@4.64.9'))throw new Error('Wrong normal Rollup supplier');
  owners[label+':'+name]={manifest,sha256:hash(manifest),packageName:data.name,version:data.version,resolvedFrom:owner.manifest};
 }
}
partial('COMPLETE_TOOL_METADATA_ONLY');
fs.writeFileSync('/results/COMPILER-OWNERS.json',JSON.stringify(owners,null,2)+'\n');
