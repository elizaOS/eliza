/**
 * @module utils
 * @description Utility functions for the gmail-watch plugin.
 */

import { execFile } from 'node:child_process';

/**
 * Find a binary in PATH, returning its full path or null.
 */
export function which(binary: string): Promise<string | null> {
  return new Promise((resolve) => {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    execFile(cmd, [binary], (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }
      const result = stdout.trim().split('\n')[0]?.trim();
      resolve(result || null);
    });
  });
}
