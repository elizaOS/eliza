import { execa } from 'execa';
import * as fs from 'fs-extra';
import * as path from 'node:path';
import { logger } from '@elizaos/core';



/**
 * Get available disk space in GB
 */
export async function getAvailableDiskSpace(): Promise<number> {
  try {
    const result = await execa('df', ['-k', tmpdir()]);
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


