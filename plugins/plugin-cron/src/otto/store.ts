/**
 * @module otto/store
 * @description Cron job store management
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CronStoreFile } from './types.js';

/**
 * Resolves the cron store path.
 * If a path is provided, it will be resolved (with ~ expansion).
 * If no path is provided, returns undefined (caller should use their own default).
 */
export function resolveCronStorePath(storePath?: string): string | undefined {
  if (storePath?.trim()) {
    const raw = storePath.trim();
    if (raw.startsWith('~')) {
      return path.resolve(raw.replace('~', os.homedir()));
    }
    return path.resolve(raw);
  }
  return undefined;
}

export async function loadCronStore(storePath: string): Promise<CronStoreFile> {
  try {
    const raw = await fs.promises.readFile(storePath, 'utf-8');
    // Use dynamic import for JSON5 to avoid adding it as a dependency
    // Fall back to JSON.parse if JSON5 is not available
    let parsed: unknown;
    try {
      const JSON5 = await import('json5').then((m) => m.default);
      parsed = JSON5.parse(raw);
    } catch {
      parsed = JSON.parse(raw);
    }
    const jobs = Array.isArray((parsed as Record<string, unknown>)?.jobs)
      ? ((parsed as Record<string, unknown>)?.jobs as never[])
      : [];
    return {
      version: 1,
      jobs: jobs.filter(Boolean) as never as CronStoreFile['jobs'],
    };
  } catch {
    return { version: 1, jobs: [] };
  }
}

export async function saveCronStore(storePath: string, store: CronStoreFile) {
  await fs.promises.mkdir(path.dirname(storePath), { recursive: true });
  const tmp = `${storePath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  const json = JSON.stringify(store, null, 2);
  await fs.promises.writeFile(tmp, json, 'utf-8');
  await fs.promises.rename(tmp, storePath);
  try {
    await fs.promises.copyFile(storePath, `${storePath}.bak`);
  } catch {
    // best-effort
  }
}
