import fs from 'node:fs';
import path from 'node:path';
import { logger } from '@elizaos/core';
import type fileUpload from 'express-fileupload';

// Using express-fileupload file type
type UploadedFile = fileUpload.UploadedFile;

/**
 * Safely constructs and validates upload directory paths to prevent path traversal attacks
 */
export function createSecureUploadDir(
  baseDir: string,
  id: string,
  type: 'agents' | 'channels'
): string {
  // Additional validation beyond UUID to ensure no path traversal
  if (id.includes('..') || id.includes('/') || id.includes('\\') || id.includes('\0')) {
    throw new Error(`Invalid ${type.slice(0, -1)} ID: contains illegal characters`);
  }

  const basePath = path.resolve(process.cwd(), '.eliza', 'data', 'uploads', type);
  const targetPath = path.join(basePath, id);

  // Ensure the resolved path is still within the expected base directory
  if (!targetPath.startsWith(basePath)) {
    throw new Error(`Invalid ${type.slice(0, -1)} ID: path traversal detected`);
  }

  return targetPath;
}

/**
 * Safely sanitizes filenames to prevent security issues
 */
export function sanitizeFilename(filename: string): string {
  // Remove null bytes and path separators
  let sanitized = filename.replace(/[\0\/\\:*?"<>|]/g, '_');

  // Remove leading dots and spaces
  sanitized = sanitized.replace(/^[.\s]+/, '');

  // Limit length to prevent filesystem issues
  if (sanitized.length > 255) {
    const ext = path.extname(sanitized);
    const name = path.basename(sanitized, ext);
    sanitized = name.substring(0, 255 - ext.length) + ext;
  }

  // Ensure filename is not empty after sanitization
  if (!sanitized || sanitized.trim() === '') {
    sanitized = 'file';
  }

  return sanitized;
}

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
 * Cleans up multiple files from express-fileupload
 */
export const cleanupFiles = (files: UploadedFile[]) => {
  if (files) {
    files.forEach((file) => cleanupFile(file.tempFilePath || ''));
  }
};

/**
 * Cleans up an uploaded file by removing it from temp location
 */
export const cleanupUploadedFile = (file: UploadedFile) => {
  if (file.tempFilePath) {
    cleanupFile(file.tempFilePath);
  }
};
