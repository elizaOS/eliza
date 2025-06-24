import { validateUuid, logger, getContentTypeFromMimeType } from '@elizaos/core';
import express from 'express';
import { sendError, sendSuccess } from '../shared/response-utils';
import { ALLOWED_MEDIA_MIME_TYPES, MAX_FILE_SIZE } from '../shared/constants';
import multer from 'multer';
import fs from 'fs';
import path from 'path';

// Configure multer for file uploads
const storage = multer.memoryStorage();
const upload = multer({
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

// Helper function to save uploaded file
async function saveUploadedFile(
  file: Express.Multer.File,
  agentId: string
): Promise<{ filename: string; url: string }> {
  const uploadDir = path.join(process.cwd(), '.eliza/data/uploads/agents', agentId);

  // Ensure directory exists
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }

  // Generate unique filename
  const timestamp = Date.now();
  const random = Math.round(Math.random() * 1e9);
  const ext = path.extname(file.originalname);
  const filename = `${timestamp}-${random}${ext}`;
  const filePath = path.join(uploadDir, filename);

  // Write file to disk
  fs.writeFileSync(filePath, file.buffer);

  const url = `/media/uploads/agents/${agentId}/${filename}`;
  return { filename, url };
}

/**
 * Agent media upload functionality
 */
export function createAgentMediaRouter(): express.Router {
  const router = express.Router();

  // Media upload endpoint for images and videos using multer
  router.post('/:agentId/upload-media', upload.single('file'), async (req, res) => {
    logger.debug('[MEDIA UPLOAD] Processing media upload with multer');

    const agentId = validateUuid(req.params.agentId);
    if (!agentId) {
      return sendError(res, 400, 'INVALID_ID', 'Invalid agent ID format');
    }

    if (!req.file) {
      return sendError(res, 400, 'INVALID_REQUEST', 'No media file provided');
    }

    const mediaType = getContentTypeFromMimeType(req.file.mimetype);
    if (!mediaType) {
      return sendError(
        res,
        400,
        'UNSUPPORTED_MEDIA_TYPE',
        `Unsupported media MIME type: ${req.file.mimetype}`
      );
    }

    try {
      // Save the uploaded file
      const result = await saveUploadedFile(req.file, agentId);

      logger.info(
        `[MEDIA UPLOAD] Successfully uploaded ${mediaType}: ${result.filename}. URL: ${result.url}`
      );

      sendSuccess(res, {
        url: result.url,
        type: mediaType,
        filename: result.filename,
        originalName: req.file.originalname,
        size: req.file.size,
      });
    } catch (error) {
      logger.error(`[MEDIA UPLOAD] Error processing upload: ${error}`);
      sendError(
        res,
        500,
        'UPLOAD_ERROR',
        'Failed to process media upload',
        error instanceof Error ? error.message : String(error)
      );
    }
  });

  return router;
}
