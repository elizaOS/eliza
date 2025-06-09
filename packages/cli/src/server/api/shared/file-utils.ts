import fs from 'node:fs';
import { logger } from '@elizaos/core';

// Using Express.Multer.File type instead of importing from multer directly
type MulterFile = Express.Multer.File;

/**
 * Safely cleans up a single file by path
 */
export const cleanupFile = (filePath: string) => {
  if (filePath && fs.existsSync(filePath)) {
    try {
      fs.unlinkSync(filePath);
    } catch (error) {
      logger.error(`Error cleaning up file ${filePath}:`, error);
    }
  }
};

/**
 * Cleans up multiple files from multer upload
 */
export const cleanupFiles = (files: MulterFile[]) => {
  if (files) {
    files.forEach((file) => cleanupFile(file.path));
  }
};