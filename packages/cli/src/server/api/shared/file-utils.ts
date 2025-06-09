import fs from 'node:fs';
import path from 'node:path';
import { logger } from '@elizaos/core';

// Using Express.Multer.File type instead of importing from multer directly
type MulterFile = Express.Multer.File;

/**
 * Safely cleans up a single file by path with path validation
 */
export const cleanupFile = (filePath: string) => {
  if (!filePath) return;
  
  try {
    // Validate and resolve the path to prevent directory traversal
    const resolvedPath = path.resolve(filePath);
    const normalizedPath = path.normalize(resolvedPath);
    
    // Ensure the path doesn't contain directory traversal attempts
    if (normalizedPath.includes('..') || !normalizedPath.startsWith(process.cwd())) {
      logger.warn(`[SECURITY] Potentially unsafe file path blocked: ${filePath}`);
      return;
    }
    
    if (fs.existsSync(normalizedPath)) {
      fs.unlinkSync(normalizedPath);
      logger.debug(`[FILE] Successfully cleaned up file: ${normalizedPath}`);
    }
  } catch (error) {
    logger.error(`Error cleaning up file ${filePath}:`, error);
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