/**
 * Global setup for E2E tests
 *
 * Ensures Chroma wallet extensions are downloaded before tests run.
 */

import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const chromaDir = path.resolve(__dirname, '.chroma');
const metamaskDir = path.join(chromaDir, 'metamask-extension-13.17.0');

async function ensureExtensionsDownloaded(): Promise<void> {
  try {
    await access(metamaskDir);
    return;
  } catch {}
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      'npx',
      ['chroma', 'download-extensions', '--wallets', 'metamask'],
      {
        cwd: __dirname,
        env: process.env,
        stdio: 'inherit',
      }
    );

    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      resolve();
    });
    child.on('error', (err) => {
      resolve();
    });
  });
}

export default async function globalSetup(): Promise<void> {
  await ensureExtensionsDownloaded();
}
