import fs from 'node:fs';
import path from 'node:path';
import { logger } from '@elizaos/core';

/**
 * Safely constructs and validates upload directory paths to prevent path traversal attacks
 */
export function createSecureUploadDir(id: string, type: 'agents' | 'channels'): string {
  // Additional validation beyond UUID to ensure no path traversal
  if (id.includes('..') || id.includes('/') || id.includes('\\') || id.includes('\0')) {
    throw new Error(`Invalid ${type.slice(0, -1)} ID: contains illegal characters`);
  }

  // Use CLI data directory structure consistently
  const baseUploadDir = path.join(process.cwd(), '.eliza', 'data', 'uploads');
  const finalDir = path.join(baseUploadDir, type, id);

  // Ensure the resolved path is still within the expected directory
  const resolvedPath = path.resolve(finalDir);
  const expectedBase = path.resolve(baseUploadDir);

  if (!resolvedPath.startsWith(expectedBase)) {
    throw new Error(`Invalid ${type.slice(0, -1)} upload path: outside allowed directory`);
  }

  return resolvedPath;
}

/**
 * Sanitizes a filename by removing dangerous characters and normalizing it
 */
export function sanitizeFilename(filename: string): string {
  if (!filename) {
    return 'unnamed';
  }

  // Remove path separators and null bytes
  const sanitized = filename
    .replace(/[/\\:*?"<>|]/g, '_')
    .replace(/\0/g, '')
    .replace(/\.+/g, '.')
    .trim();

  // Ensure filename isn't empty after sanitization
  if (!sanitized || sanitized === '.') {
    return 'unnamed';
  }

  // Limit filename length
  const maxLength = 255;
  if (sanitized.length > maxLength) {
    const ext = path.extname(sanitized);
    const nameWithoutExt = path.basename(sanitized, ext);
    const truncatedName = nameWithoutExt.substring(0, maxLength - ext.length - 1);
    return truncatedName + ext;
  }

  return sanitized;
}

/**
 * Safely cleans up a file by removing it from the filesystem
 */
export const cleanupFile = (filePath: string) => {
  try {
    if (filePath && fs.existsSync(filePath)) {
      // Additional path validation
      const normalizedPath = path.normalize(filePath);
      fs.unlinkSync(normalizedPath);
      logger.debug(`[FILE] Successfully cleaned up file: ${normalizedPath}`);
    }
  } catch (error) {
    logger.error(`Error cleaning up file ${filePath}:`, error);
  }
};

/**
 * Cleans up multiple multer files
 */
export const cleanupFiles = (files: Express.Multer.File[]) => {
  if (files) {
    files.forEach((file) => {
      // For multer memory storage, no temp files to clean up
      // This function is kept for compatibility
      logger.debug(`[FILE] Multer file ${file.originalname} in memory, no cleanup needed`);
    });
  }
};

/**
 * Cleans up a multer file (no-op for memory storage)
 */
export const cleanupUploadedFile = (file: Express.Multer.File) => {
  // For multer memory storage, no temp files to clean up
  logger.debug(`[FILE] Multer file ${file.originalname} in memory, no cleanup needed`);
};
