import { execa } from 'execa';
import * as fs from 'fs-extra';
import * as path from 'node:path';
import { logger } from '@elizaos/core';

/**
 * Check if dependencies are installed and install them if needed
 */
export async function ensureDependenciesInstalled(repoPath: string): Promise<void> {
  // Check if package.json exists
  const packageJsonPath = path.join(repoPath, 'package.json');
  if (!(await fs.pathExists(packageJsonPath))) {
    throw new Error('No package.json found in repository. Cannot install dependencies.');
  }

  // First ensure dependencies are installed
  logger.info('Installing dependencies...');
  try {
    await execa('bun', ['install'], {
      cwd: repoPath,
      stdio: 'pipe',
      timeout: 300000, // 5 minute timeout for bun install
    });
  } catch (installError: unknown) {
    const error = installError as { timedOut?: boolean; message?: string };
    if (error.timedOut) {
      throw new Error('bun install timed out after 5 minutes. Check network connection.');
    }
    logger.warn(`bun install failed: ${error.message || 'Unknown error'}`);
    // Continue anyway - some operations might still work
  }
}

/**
 * Get available disk space in GB
 */
export async function getAvailableDiskSpace(): Promise<number> {
  try {
    const result = await execa('df', ['-k', require('node:os').tmpdir()]);
    const lines = result.stdout.split('\n');
    const dataLine = lines[1]; // Second line contains the data
    const parts = dataLine.split(/\s+/);
    const availableKB = Number.parseInt(parts[3]);
    return availableKB / 1024 / 1024; // Convert to GB
  } catch (error) {
    logger.warn('Could not check disk space, proceeding anyway');
    return 10; // Assume enough space if check fails
  }
}

/**
 * Check if a command is available
 */
export async function isCommandAvailable(command: string): Promise<boolean> {
  try {
    await execa(command, ['--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}
