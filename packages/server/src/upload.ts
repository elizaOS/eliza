import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { validateUuid, logger } from '@elizaos/core';
import { createSecureUploadDir, sanitizeFilename } from './api/shared/file-utils.js';
import {
  MAX_FILE_SIZE,
  ALLOWED_AUDIO_MIME_TYPES,
  ALLOWED_MEDIA_MIME_TYPES,
} from './api/shared/constants.js';

// Helper function to generate secure filename
export function generateSecureFilename(originalName: string): string {
  const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
  const sanitizedName = sanitizeFilename(originalName);
  return `${uniqueSuffix}-${sanitizedName}`;
}

// Helper function to create upload directory
export function ensureUploadDir(id: string, type: 'agents' | 'channels'): string {
  if (!validateUuid(id)) {
    throw new Error(`Invalid ${type.slice(0, -1)} ID format`);
  }

  const uploadDir = createSecureUploadDir(id, type);

  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }

  logger.debug(`[UPLOAD] Secure ${type.slice(0, -1)} upload directory created: ${uploadDir}`);
  return uploadDir;
}

// Multer memory storage
const storage = multer.memoryStorage();

// --- Agent-Specific Upload Configuration ---
export const agentAudioUpload = () =>
  multer({
    storage,
    limits: {
      fileSize: MAX_FILE_SIZE,
      files: 1,
    },
    fileFilter: (req, file, cb) => {
      if (ALLOWED_AUDIO_MIME_TYPES.includes(file.mimetype as any)) {
        cb(null, true);
      } else {
        cb(new Error('Invalid audio file type'), false);
      }
    },
  });

export const agentMediaUpload = () =>
  multer({
    storage,
    limits: {
      fileSize: MAX_FILE_SIZE,
      files: 1,
    },
    fileFilter: (req, file, cb) => {
      if (ALLOWED_MEDIA_MIME_TYPES.includes(file.mimetype as any)) {
        cb(null, true);
      } else {
        cb(new Error('Invalid media file type'), false);
      }
    },
  });

// --- Channel-Specific Upload Configuration ---
export const channelUpload = () =>
  multer({
    storage,
    limits: {
      fileSize: MAX_FILE_SIZE,
      files: 1,
    },
    fileFilter: (req, file, cb) => {
      if (ALLOWED_MEDIA_MIME_TYPES.includes(file.mimetype as any)) {
        cb(null, true);
      } else {
        cb(new Error('Invalid file type'), false);
      }
    },
  });

// --- Generic Upload Configuration ---
export const genericUpload = () =>
  multer({
    storage,
    limits: {
      fileSize: MAX_FILE_SIZE,
      files: 1,
    },
  });

// Original generic upload (kept for compatibility)
export const upload = genericUpload;

// File validation functions using multer file type
export function validateAudioFile(file: Express.Multer.File): boolean {
  return ALLOWED_AUDIO_MIME_TYPES.includes(file.mimetype as any);
}

export function validateMediaFile(file: Express.Multer.File): boolean {
  return ALLOWED_MEDIA_MIME_TYPES.includes(file.mimetype as any);
}

// Process and save uploaded file to final destination
export async function processUploadedFile(
  file: Express.Multer.File,
  targetId: string,
  type: 'agents' | 'channels'
): Promise<{ filename: string; path: string; url: string }> {
  try {
    // Ensure upload directory exists
    const uploadDir = ensureUploadDir(targetId, type);

    // Generate secure filename
    const filename = generateSecureFilename(file.originalname);
    const finalPath = path.join(uploadDir, filename);

    // Write file buffer to final destination
    await fs.promises.writeFile(finalPath, file.buffer);

    // Construct URL
    const url = `/media/uploads/${type}/${targetId}/${filename}`;

    logger.debug(`[UPLOAD] File processed successfully: ${filename}`);

    return { filename, path: finalPath, url };
  } catch (error) {
    logger.error('[UPLOAD] Error processing uploaded file:', error);
    throw error;
  }
}
