import { validateUuid, logger } from '@elizaos/core';
import express from 'express';
import rateLimit from 'express-rate-limit';
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
  channelId: string
): Promise<{ filename: string; url: string }> {
  const uploadDir = path.join(process.cwd(), '.eliza/data/uploads/channels', channelId);

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

  const url = `/media/uploads/channels/${channelId}/${filename}`;
  return { filename, url };
}

/**
 * Channel media upload functionality
 */
export function createChannelMediaRouter(): express.Router {
  const router = express.Router();

  // Define rate limiter: maximum 100 requests per 15 minutes
  const uploadMediaRateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // Limit each IP to 100 requests per windowMs
    message: { success: false, error: 'Too many requests, please try again later.' },
  });

  // Upload media to channel
  router.post(
    '/:channelId/upload-media',
    uploadMediaRateLimiter, // Apply rate limiter
    upload.single('file'),
    async (req, res) => {
      const channelId = validateUuid(req.params.channelId);
      if (!channelId) {
        res.status(400).json({ success: false, error: 'Invalid channelId format' });
        return;
      }

      if (!req.file) {
        res.status(400).json({ success: false, error: 'No media file provided' });
        return;
      }

      try {
        // Save the uploaded file
        const result = await saveUploadedFile(req.file, channelId);

        logger.info(
          `[Channel Media Upload] File uploaded for channel ${channelId}: ${result.filename}. URL: ${result.url}`
        );

        res.json({
          success: true,
          data: {
            url: result.url, // Relative URL, client prepends server origin
            type: req.file.mimetype,
            filename: result.filename,
            originalName: req.file.originalname,
            size: req.file.size,
          },
        });
      } catch (error: any) {
        logger.error(
          `[Channel Media Upload] Error processing upload for channel ${channelId}: ${error.message}`,
          error
        );
        res.status(500).json({ success: false, error: 'Failed to process media upload' });
      }
    }
  );

  return router;
}
