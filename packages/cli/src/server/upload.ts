import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { validateUuid, logger } from '@elizaos/core';
import { createSecureUploadDir, sanitizeFilename } from './api/shared/file-utils';
import {
  MAX_FILE_SIZE,
  ALLOWED_AUDIO_MIME_TYPES,
  ALLOWED_MEDIA_MIME_TYPES,
} from './api/shared/constants';

// --- Agent-Specific Upload Storage ---
export const agentStorage = multer.diskStorage({
  destination: (req, _file, cb) => {
    try {
      const agentId = req.params?.agentId;
      if (!agentId) {
        return cb(new Error('Agent ID is required for agent file uploads'), '');
      }
      if (!validateUuid(agentId)) {
        return cb(new Error('Invalid agent ID format'), '');
      }

      const uploadDir = createSecureUploadDir(process.cwd(), agentId, 'agents');

      if (!fs.existsSync(uploadDir)) {
        fs.mkdirSync(uploadDir, { recursive: true });
      }

      logger.debug(`[UPLOAD] Secure agent upload directory created: ${uploadDir}`);
      cb(null, uploadDir);
    } catch (error) {
      logger.error('[UPLOAD] Error creating agent upload directory:', error);
      cb(error as Error, '');
    }
  },
  filename: (_req, file, cb) => {
    try {
      const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
      const sanitizedName = sanitizeFilename(file.originalname);
      const filename = `${uniqueSuffix}-${sanitizedName}`;

      logger.debug(`[UPLOAD] Generated secure agent filename: ${filename}`);
      cb(null, filename);
    } catch (error) {
      logger.error('[UPLOAD] Error generating agent filename:', error);
      cb(error as Error, '');
    }
  },
});

export const agentUpload = multer({
  storage: agentStorage,
  limits: {
    fileSize: MAX_FILE_SIZE, // 50MB max file size
    files: 1, // Only allow 1 file per request
  },
  fileFilter: (req, file, cb) => {
    // Only allow specific file types for security
    if (ALLOWED_AUDIO_MIME_TYPES.includes(file.mimetype as any)) {
      cb(null, true);
    } else {
      cb(new Error(`Invalid file type. Only audio files are allowed. Received: ${file.mimetype}`));
    }
  },
});

// --- Channel-Specific Upload Storage ---
export const channelStorage = multer.diskStorage({
  destination: (req, _file, cb) => {
    try {
      const channelId = req.params?.channelId; // Expect channelId in route params
      if (!channelId) {
        return cb(new Error('Channel ID is required for channel file uploads'), '');
      }
      if (!validateUuid(channelId)) {
        return cb(new Error('Invalid channel ID format'), '');
      }

      const uploadDir = createSecureUploadDir(process.cwd(), channelId, 'channels');

      if (!fs.existsSync(uploadDir)) {
        fs.mkdirSync(uploadDir, { recursive: true });
      }

      logger.debug(`[UPLOAD] Secure channel upload directory created: ${uploadDir}`);
      cb(null, uploadDir);
    } catch (error) {
      logger.error('[UPLOAD] Error creating channel upload directory:', error);
      cb(error as Error, '');
    }
  },
  filename: (_req, file, cb) => {
    try {
      const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
      const sanitizedName = sanitizeFilename(file.originalname);
      const filename = `${uniqueSuffix}-${sanitizedName}`;

      logger.debug(`[UPLOAD] Generated secure channel filename: ${filename}`);
      cb(null, filename);
    } catch (error) {
      logger.error('[UPLOAD] Error generating channel filename:', error);
      cb(error as Error, '');
    }
  },
});

export const channelUpload = multer({
  storage: channelStorage,
  limits: {
    fileSize: MAX_FILE_SIZE, // 50MB max file size
    files: 1, // Only allow 1 file per request
  },
  fileFilter: (req, file, cb) => {
    // Only allow specific file types for security
    if (ALLOWED_MEDIA_MIME_TYPES.includes(file.mimetype as any)) {
      cb(null, true);
    } else {
      cb(new Error(`Invalid file type. Received: ${file.mimetype}`));
    }
  },
});

// --- Generic Upload Storage (if ever needed, less specific) ---
export const genericStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    try {
      const uploadDir = path.resolve(process.cwd(), 'data', 'uploads', 'generic');
      if (!fs.existsSync(uploadDir)) {
        fs.mkdirSync(uploadDir, { recursive: true });
      }

      logger.debug(`[UPLOAD] Generic upload directory created: ${uploadDir}`);
      cb(null, uploadDir);
    } catch (error) {
      logger.error('[UPLOAD] Error creating generic upload directory:', error);
      cb(error as Error, '');
    }
  },
  filename: (_req, file, cb) => {
    try {
      const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
      const sanitizedName = sanitizeFilename(file.originalname);
      const filename = `${uniqueSuffix}-${sanitizedName}`;

      logger.debug(`[UPLOAD] Generated secure generic filename: ${filename}`);
      cb(null, filename);
    } catch (error) {
      logger.error('[UPLOAD] Error generating generic filename:', error);
      cb(error as Error, '');
    }
  },
});

export const genericUpload = multer({ storage: genericStorage });

// Original generic upload (kept for compatibility if used elsewhere, but prefer specific ones)
export const upload = multer({ storage: genericStorage }); // Defaulting to generic if 'upload' is directly used
