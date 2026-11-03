/** Hash only fresh same-subject normal producer outputs; never copy outputs. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
const mode = process.argv[2];
const graph = JSON.parse(fs.readFileSync('/results/EXPECTED-GRAPH.json', 'utf8'));
const roots = [...new Set(Object.values(graph.nodes).filter(x => x.script && x.task === 'build')
  .map(x => x.path + '/dist').concat('packages/cloud/api/.wrangler-dry-run'))].sort();
const records = []; let bytes = 0;
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name), stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error('Unowned/special generated output');
    if (stat.isDirectory()) walk(file);
    else {
      bytes += stat.size;
      if (bytes > 4294967296 || records.length >= 100000) throw new Error('Output fingerprint bound');
      const h = createHash('sha256'), fd = fs.openSync(file, 'r'), chunk = Buffer.alloc(1048576);
      try { let length; while ((length = fs.readSync(fd, chunk, 0, chunk.length, null))) h.update(chunk.subarray(0, length)); }
      finally { fs.closeSync(fd); }
      records.push({ path: path.relative('/workspace', file), bytes: stat.size, sha256: h.digest('hex') });
    }
  }
}
for (const root of roots) {
  const directory = '/workspace/' + root;
  if (!fs.existsSync(directory)) {
    if (mode === 'after') throw new Error('Required normal producer output absent: ' + root);
    continue;
  }
  if (fs.lstatSync(directory).isSymbolicLink() || !fs.statSync(directory).isDirectory()) throw new Error('Output root is not owned directory');
  if (mode === 'before' && fs.readdirSync(directory).length) throw new Error('Preexisting outputs not admitted');
  walk(directory);
}
const data = JSON.stringify({ mode, sourceCommit: graph.source, roots, bytes, files: records.length, records });
if (Buffer.byteLength(data) > 16777216) throw new Error('Output receipt cap');
fs.writeFileSync('/results/OUTPUTS-' + mode + '.json', data + '\n');
