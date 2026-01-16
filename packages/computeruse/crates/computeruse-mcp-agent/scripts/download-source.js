#!/usr/bin/env node

const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const os = require('os');

// Get platform-specific app data directory
function getAppDataDir() {
  switch (process.platform) {
    case 'win32':
      return process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'Application Support');
    default: // linux and others
      return process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  }
}

const MEDIAR_DIR = path.join(getAppDataDir(), 'mediar');
const SOURCE_DIR = path.join(MEDIAR_DIR, 'computeruse-source');
const MARKER_FILE = path.join(SOURCE_DIR, '.computeruse-source-meta.json');
const REPO = 'mediar-ai/computeruse';

// Simple fetch using https module (no dependencies)
function fetch(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: { 'User-Agent': 'computeruse-mcp-agent' }
    }, (response) => {
      // Handle redirects
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        return fetch(response.headers.location).then(resolve).catch(reject);
      }

      if (response.statusCode !== 200) {
        reject(new Error(`HTTP ${response.statusCode}`));
        return;
      }

      let data = '';
      response.on('data', chunk => data += chunk);
      response.on('end', () => resolve({ data, headers: response.headers }));
    });
    request.on('error', reject);
  });
}

// Download file to disk
function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);

    const request = https.get(url, {
      headers: { 'User-Agent': 'computeruse-mcp-agent' }
    }, (response) => {
      // Handle redirects
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        file.close();
        fs.unlinkSync(destPath);
        return downloadFile(response.headers.location, destPath).then(resolve).catch(reject);
      }

      if (response.statusCode !== 200) {
        file.close();
        fs.unlinkSync(destPath);
        reject(new Error(`HTTP ${response.statusCode}`));
        return;
      }

      response.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve();
      });
    });

    request.on('error', (err) => {
      file.close();
      fs.unlinkSync(destPath);
      reject(err);
    });
  });
}

async function getLatestRelease() {
  const { data } = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`);
  const release = JSON.parse(data);
  return {
    tag: release.tag_name,
    zipUrl: release.zipball_url
  };
}

function needsUpdate() {
  if (!fs.existsSync(SOURCE_DIR) || !fs.existsSync(MARKER_FILE)) {
    return { needed: true, reason: 'not installed' };
  }

  try {
    const meta = JSON.parse(fs.readFileSync(MARKER_FILE, 'utf8'));
    const hoursSince = (Date.now() - new Date(meta.updated).getTime()) / (1000 * 60 * 60);

    if (hoursSince > 24) {
      return { needed: true, reason: 'older than 24h', currentTag: meta.tag };
    }

    return { needed: false, tag: meta.tag };
  } catch {
    return { needed: true, reason: 'invalid metadata' };
  }
}

async function downloadAndExtract(zipUrl, tag) {
  // Ensure mediar directory exists
  if (!fs.existsSync(MEDIAR_DIR)) {
    fs.mkdirSync(MEDIAR_DIR, { recursive: true });
  }

  const zipPath = path.join(MEDIAR_DIR, 'computeruse-source.zip');
  const tempExtractDir = path.join(MEDIAR_DIR, 'computeruse-source-temp');

  console.error(`Downloading computeruse source (${tag})...`);
  await downloadFile(zipUrl, zipPath);

  console.error('Extracting...');

  // Clean up temp dir if exists
  if (fs.existsSync(tempExtractDir)) {
    fs.rmSync(tempExtractDir, { recursive: true, force: true });
  }
  fs.mkdirSync(tempExtractDir, { recursive: true });

  // Extract zip
  try {
    if (process.platform === 'win32') {
      execSync(`powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${tempExtractDir}' -Force"`, { stdio: 'pipe' });
    } else {
      execSync(`unzip -q "${zipPath}" -d "${tempExtractDir}"`, { stdio: 'pipe' });
    }
  } catch (err) {
    throw new Error(`Failed to extract: ${err.message}`);
  }

  // Find extracted folder (mediar-ai-computeruse-<hash>)
  const extracted = fs.readdirSync(tempExtractDir).find(f => f.startsWith('mediar-ai-computeruse-'));
  if (!extracted) {
    throw new Error('Could not find extracted folder');
  }

  // Remove old source dir and rename extracted
  if (fs.existsSync(SOURCE_DIR)) {
    fs.rmSync(SOURCE_DIR, { recursive: true, force: true });
  }
  fs.renameSync(path.join(tempExtractDir, extracted), SOURCE_DIR);

  // Cleanup
  fs.rmSync(tempExtractDir, { recursive: true, force: true });
  fs.unlinkSync(zipPath);

  // Write metadata
  fs.writeFileSync(MARKER_FILE, JSON.stringify({
    tag,
    updated: new Date().toISOString(),
    source: 'github-release'
  }, null, 2));

  console.error(`ComputerUse source ${tag} installed to ${SOURCE_DIR}`);
}

async function main() {
  try {
    const check = needsUpdate();

    if (!check.needed) {
      console.error(`ComputerUse source ${check.tag} is up to date`);
      return;
    }

    console.error(`ComputerUse source update needed: ${check.reason}`);

    const { tag, zipUrl } = await getLatestRelease();

    // Skip if same version (just update timestamp)
    if (check.currentTag === tag) {
      console.error(`Already have ${tag}, updating timestamp`);
      const meta = JSON.parse(fs.readFileSync(MARKER_FILE, 'utf8'));
      meta.updated = new Date().toISOString();
      fs.writeFileSync(MARKER_FILE, JSON.stringify(meta, null, 2));
      return;
    }

    await downloadAndExtract(zipUrl, tag);
  } catch (err) {
    // Non-fatal - MCP agent can still work without search tools
    console.error(`Warning: Failed to download computeruse source: ${err.message}`);
    console.error('Search tools will not be available until source is downloaded.');
  }
}

// Run if called directly
if (require.main === module) {
  main();
}

module.exports = { main, needsUpdate, getAppDataDir, SOURCE_DIR };
