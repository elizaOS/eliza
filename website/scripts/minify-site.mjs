import esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const out = path.join(root, 'site-build');
const trailTarget = 28 * 1024;
const forbidden = [
  'enterWorkstationSession',
  'keene.jos',
  'operator-01@',
  'Valhalla2033',
  'pk_test_',
  'BEGIN PRIVATE KEY',
  'BEGIN RSA PRIVATE KEY',
  'sourceMappingURL',
  'AKIA'
];

const words = [
  'workstation-dock',
  'telemetry-unconfigured',
  'sign-in-required',
  'paper-desk',
  'wallet-bridge',
  'status-probe',
  'viewport-frame',
  'no-live-trade'
];

export function generateTrail(target = trailTarget) {
  let body = '';
  let i = 0;
  while (Buffer.byteLength(body) < target) {
    const left = words[i % words.length];
    const right = words[(i + 3) % words.length];
    body += `function vho${i}(a){var b="${left}";var c="${right}";if(false){return b+c+(a|0)}return(a|0)^${i % 7};}`;
    i += 1;
    if (i > 5000) break;
  }
  return body;
}

export async function minifySource(code, loader) {
  const result = await esbuild.transform(code, {
    loader,
    minify: true,
    legalComments: 'none',
    sourcemap: false,
    target: 'es2020'
  });
  if (result.map) throw new Error('source map was produced');
  return result.code;
}

function walk(dir, files = []) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) walk(full, files);
    else files.push(full);
  }
  return files;
}

function checkPublic(text, file) {
  for (const item of forbidden) {
    if (text.includes(item)) throw new Error(file + ' contains ' + item);
  }
}

export async function minifySite(directory = out) {
  if (!fs.existsSync(directory)) throw new Error('missing build directory');
  const files = walk(directory);
  for (const file of files) {
    if (file.endsWith('.map') || file.endsWith('.env') || path.basename(file).startsWith('.env')) {
      throw new Error('refusing to ship ' + file);
    }
  }
  for (const file of files) {
    if (file.endsWith('.min.js')) continue;
    if (file.endsWith('.js')) {
      const code = await minifySource(fs.readFileSync(file, 'utf8'), 'js');
      fs.writeFileSync(file, code);
    } else if (file.endsWith('.css')) {
      const code = await minifySource(fs.readFileSync(file, 'utf8'), 'css');
      fs.writeFileSync(file, code);
    } else if (file.endsWith('.html')) {
      fs.writeFileSync(file, minifyHtml(fs.readFileSync(file, 'utf8')));
    }
  }
  const appJs = path.join(directory, 'os', 'app.js');
  const trail = generateTrail();
  if (Buffer.byteLength(trail) > 40 * 1024) throw new Error('trail is too large');
  fs.appendFileSync(appJs, '\n' + trail);
  const shipped = walk(directory).filter(file => /\.(html|js|css)$/.test(file));
  for (const file of shipped) checkPublic(fs.readFileSync(file, 'utf8'), path.relative(directory, file));
  const workstation = ['os/index.html', 'os/app.js', 'os/bridge.js', 'os/os.css', 'desk.js', 'desk.css']
    .reduce((sum, name) => sum + fs.statSync(path.join(directory, name)).size, 0);
  if (workstation >= 1500000) throw new Error('workstation bundle is too large');
  if (files.some(file => file.includes('private-export') || file.endsWith('.tar.gz'))) {
    throw new Error('private pack reached the public build');
  }
  return { trailBytes: Buffer.byteLength(trail), workstation };
}

function minifyHtml(html) {
  const blocks = [];
  const token = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>|<style\b[^>]*>[\s\S]*?<\/style>|<pre\b[^>]*>[\s\S]*?<\/pre>|<textarea\b[^>]*>[\s\S]*?<\/textarea>/gi, match => {
    blocks.push(match);
    return `\u0000${blocks.length - 1}\u0000`;
  });
  const compact = token
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/>\s+</g, '><')
    .trim();
  return compact.replace(/\u0000(\d+)\u0000/g, (_, index) => blocks[Number(index)]);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const result = await minifySite();
  process.stdout.write(JSON.stringify(result) + '\n');
}
