import fs from 'node:fs';
import path from 'node:path';
import fileUpload from 'express-fileupload';
import { validateUuid, logger } from '@elizaos/core';
import { createSecureUploadDir, sanitizeFilename } from './api/shared/file-utils';
import {
  MAX_FILE_SIZE,
  ALLOWED_AUDIO_MIME_TYPES,
  ALLOWED_MEDIA_MIME_TYPES,
} from './api/shared/constants';

// Helper function to generate secure filename
function generateSecureFilename(originalName: string): string {
  const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
  const sanitizedName = sanitizeFilename(originalName);
  return `${uniqueSuffix}-${sanitizedName}`;
}

// Helper function to create upload directory
function ensureUploadDir(id: string, type: 'agents' | 'channels'): string {
  if (!validateUuid(id)) {
    throw new Error(`Invalid ${type.slice(0, -1)} ID format`);
  }

  const uploadDir = createSecureUploadDir(process.cwd(), id, type);

  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }

  logger.debug(`[UPLOAD] Secure ${type.slice(0, -1)} upload directory created: ${uploadDir}`);
  return uploadDir;
}

// --- Agent-Specific Upload Configuration ---
export const agentAudioUpload = () =>
  fileUpload({
    limits: {
      fileSize: MAX_FILE_SIZE, // 50MB max file size
      files: 1, // Only allow 1 file per request
    },
    useTempFiles: true,
    tempFileDir: '/tmp/',
    parseNested: true,
    abortOnLimit: true,
    createParentPath: true,
    preserveExtension: true,
    safeFileNames: true,
    uploadTimeout: 60000, // 60 seconds timeout
  });

export const agentMediaUpload = () =>
  fileUpload({
    limits: {
      fileSize: MAX_FILE_SIZE, // 50MB max file size
      files: 1, // Only allow 1 file per request
    },
    useTempFiles: true,
    tempFileDir: '/tmp/',
    parseNested: true,
    abortOnLimit: true,
    createParentPath: true,
    preserveExtension: true,
    safeFileNames: true,
    uploadTimeout: 60000, // 60 seconds timeout
  });

// --- Channel-Specific Upload Configuration ---
export const channelUpload = () =>
  fileUpload({
    limits: {
      fileSize: MAX_FILE_SIZE, // 50MB max file size
      files: 1, // Only allow 1 file per request
    },
    useTempFiles: true,
    tempFileDir: '/tmp/',
    parseNested: true,
    abortOnLimit: true,
    createParentPath: true,
    preserveExtension: true,
    safeFileNames: true,
    uploadTimeout: 60000, // 60 seconds timeout
  });

// --- Generic Upload Configuration (if ever needed, less specific) ---
export const genericUpload = () =>
  fileUpload({
    limits: {
      fileSize: MAX_FILE_SIZE, // 50MB max file size
      files: 1, // Only allow 1 file per request
    },
    useTempFiles: true,
    tempFileDir: '/tmp/',
    parseNested: true,
    abortOnLimit: true,
    createParentPath: true,
    preserveExtension: true,
    safeFileNames: true,
    uploadTimeout: 60000, // 60 seconds timeout
  });

// Original generic upload (kept for compatibility if used elsewhere, but prefer specific ones)
export const upload = genericUpload; // Defaulting to generic if 'upload' is directly used

// Export helper functions for use in route handlers
export { generateSecureFilename, ensureUploadDir };

// File validation functions
export function validateAudioFile(file: fileUpload.UploadedFile): boolean {
  return ALLOWED_AUDIO_MIME_TYPES.includes(file.mimetype as any);
}

export function validateMediaFile(file: fileUpload.UploadedFile): boolean {
  return ALLOWED_MEDIA_MIME_TYPES.includes(file.mimetype as any);
}

// Process and move uploaded file to final destination
export async function processUploadedFile(
  file: fileUpload.UploadedFile,
  targetId: string,
  type: 'agents' | 'channels'
): Promise<{ filename: string; path: string; url: string }> {
  try {
    // Ensure upload directory exists
    const uploadDir = ensureUploadDir(targetId, type);

    // Generate secure filename
    const filename = generateSecureFilename(file.name);
    const finalPath = path.join(uploadDir, filename);

    // Move file from temp location to final destination
    await file.mv(finalPath);

    // Construct URL
    const url = `/media/uploads/${type}/${targetId}/${filename}`;

    logger.debug(`[UPLOAD] File processed successfully: ${filename}`);

    return { filename, path: finalPath, url };
  } catch (error) {
    logger.error('[UPLOAD] Error processing uploaded file:', error);
    throw error;
  }
}
