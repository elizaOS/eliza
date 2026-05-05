/**
 * System scanner — uses unimport to discover BabylonSystem exports from a directory.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { logger } from '@babylon/shared';
import { type Import, scanDirExports } from 'unimport';
import type { BabylonSystem } from './types';

export interface ScanResult {
  systems: BabylonSystem[];
  files: string[];
}

/**
 * Scan a directory for files exporting BabylonSystem instances.
 * Each file should export a default or named object that satisfies the BabylonSystem interface.
 */
export async function scanSystems(
  systemsDir: string,
  rootDir: string
): Promise<ScanResult> {
  const absoluteDir = resolve(rootDir, systemsDir);
  const systems: BabylonSystem[] = [];
  const files: string[] = [];

  if (!existsSync(absoluteDir)) {
    logger.warn(
      `No systems directory found at ${absoluteDir}`,
      undefined,
      'Runtime'
    );
    return { systems: [], files: [] };
  }

  let exports: Import[];
  try {
    exports = await scanDirExports([absoluteDir], {
      filePatterns: ['*.ts', '*.js', '*.mts', '*.mjs'],
    });
  } catch (err) {
    logger.error(
      `Failed to scan systems directory at ${absoluteDir}`,
      err instanceof Error ? err : new Error(String(err)),
      'Runtime'
    );
    return { systems: [], files: [] };
  }

  // Group exports by file
  const fileExports = new Map<string, Import[]>();
  for (const exp of exports) {
    const from = exp.from;
    if (!fileExports.has(from)) fileExports.set(from, []);
    fileExports.get(from)!.push(exp);
  }

  for (const [filePath, fileExps] of fileExports) {
    files.push(filePath);

    try {
      const mod = await import(filePath);

      // Try default export first, then named exports
      const candidates: unknown[] = [];
      if (mod.default) candidates.push(mod.default);
      for (const exp of fileExps) {
        if (exp.name !== 'default' && mod[exp.name]) {
          candidates.push(mod[exp.name]);
        }
      }

      const seen = new Set<string>();
      for (const candidate of candidates) {
        const instance = resolveSystem(candidate);
        if (instance && !seen.has(instance.id)) {
          seen.add(instance.id);
          systems.push(instance);
          logger.info(
            `Discovered system "${instance.id}" from ${filePath}`,
            undefined,
            'Runtime'
          );
        }
      }
    } catch (err) {
      logger.error(
        `Failed to load system from ${filePath}`,
        err instanceof Error ? err : new Error(String(err)),
        'Runtime'
      );
    }
  }

  return { systems, files };
}

/**
 * Resolve a candidate export to a BabylonSystem instance.
 * Handles both class constructors and pre-instantiated objects.
 */
function resolveSystem(candidate: unknown): BabylonSystem | null {
  if (!candidate) return null;

  // Already an instance with the right shape
  if (isBabylonSystem(candidate)) return candidate;

  // Class constructor — instantiate it
  if (typeof candidate === 'function') {
    try {
      const instance = new (candidate as new () => unknown)();
      if (isBabylonSystem(instance)) return instance;
    } catch (err) {
      logger.warn(
        `Failed to instantiate candidate constructor: ${err instanceof Error ? err.message : String(err)}`,
        undefined,
        'Runtime'
      );
    }
  }

  return null;
}

function isBabylonSystem(obj: unknown): obj is BabylonSystem {
  if (!obj || typeof obj !== 'object') return false;
  const m = obj as Record<string, unknown>;
  return (
    typeof m.id === 'string' &&
    typeof m.name === 'string' &&
    typeof m.phase === 'number' &&
    typeof m.onTick === 'function'
  );
}
