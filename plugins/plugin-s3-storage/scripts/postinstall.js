import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';

const platform = os.platform();
const rel = os.release();

if (platform !== 'linux') {
  console.log('Skipping [patchright] installation: non-Linux platform detected:', platform);
  process.exit(0);
}

function getDistroName() {
  try {
    const osReleaseContent = fs.readFileSync('/etc/os-release', 'utf8');
    const lines = osReleaseContent.split('\n');
    const info = {};
    for (const line of lines) {
      const [key, value] = line.split('=');
      if (key && value) {
        info[key.toLowerCase()] = value.replace(/"/g, '').toLowerCase().trim();
      }
    }
    return info.id || info.id_like || null;
  } catch (err) {
    console.error('Error reading /etc/os-release:', err.message);
  }
  return null;
}

const distro = getDistroName();
console.log('Detected Linux distribution:', distro || 'unknown');

const supportedDistros = [
  'ubuntu',
  'debian',
  'pve',
  'raspbian',
  'pop',
  'zorin',
  'linuxmint',
  'elementary',
  'pureos',
  'kali',
];

if (!distro || !supportedDistros.some((name) => distro.includes(name))) {
  console.log(
    'Skipping [patchright] installation on unsupported platform:',
    platform,
    rel,
    distro || 'unknown distro'
  );
  process.exit(0);
}

try {
  execSync('npx patchright install', {
    stdio: 'inherit',
  });
} catch (err) {
  console.error(
    "Failed to install [patchright] you may need to install [patchright] deps with 'sudo npx patchright install-deps'. Error: ",
    err.message
  );
  process.exit(1);
}
