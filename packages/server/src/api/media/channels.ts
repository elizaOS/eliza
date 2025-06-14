import { validateUuid, logger, type UUID } from '@elizaos/core';
import express from 'express';
import rateLimit from 'express-rate-limit';
import type { AgentServer } from '../../index';
import { channelUpload } from '../shared/uploads';
import fs from 'fs';
import path from 'path';

// Using Express.Multer.File type instead of importing from multer directly
type MulterFile = Express.Multer.File;

interface ChannelMediaRequest extends express.Request {
  file?: MulterFile;
  params: {
    channelId: string;
  };
}

/**
 * Channel media upload functionality
 */
export function createChannelMediaRouter(serverInstance: AgentServer): express.Router {
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
    channelUpload.single('file'),
    async (req: ChannelMediaRequest, res) => {
      const channelId = validateUuid(req.params.channelId);
      if (!channelId) {
        res.status(400).json({ success: false, error: 'Invalid channelId format' });
        return;
      }

      const mediaFile = req.file;
      if (!mediaFile) {
        res.status(400).json({ success: false, error: 'No media file provided' });
        return;
      }

      // Basic validation (can be expanded)
      const validMimeTypes = [
        'image/jpeg',
        'image/png',
        'image/gif',
        'image/webp',
        'video/mp4',
        'video/webm',
        'audio/mpeg',
        'audio/wav',
        'audio/ogg',
        'application/pdf',
        'text/plain',
      ];

      if (!validMimeTypes.includes(mediaFile.mimetype)) {
        try {
          const UPLOADS_ROOT = path.resolve('/media/uploads/channels');
          const normalizedPath = path.resolve(mediaFile.path);
          if (!normalizedPath.startsWith(UPLOADS_ROOT)) {
            throw new Error('Invalid file path detected during cleanup');
          }
          await fs.promises.unlink(normalizedPath);
        } catch (cleanupError) {
          logger.error('[Channel Media Upload] Failed to clean up invalid file:', cleanupError);
        }
        res.status(400).json({ success: false, error: `Invalid file type: ${mediaFile.mimetype}` });
        return;
      }

      try {
        // Construct file URL based on where channelUpload saves files
        // e.g., /media/uploads/channels/:channelId/:filename
        // This requires a static serving route for /media/uploads/channels too.
        const fileUrl = `/media/uploads/channels/${channelId}/${mediaFile.filename}`;

        logger.info(
          `[Channel Media Upload] File uploaded for channel ${channelId}: ${mediaFile.filename}. URL: ${fileUrl}`
        );

        res.json({
          success: true,
          data: {
            url: fileUrl, // Relative URL, client prepends server origin
            type: mediaFile.mimetype, // More specific type from multer
            filename: mediaFile.filename,
            originalName: mediaFile.originalname,
            size: mediaFile.size,
          },
        });
      } catch (error: any) {
        logger.error(
          `[Channel Media Upload] Error processing upload for channel ${channelId}: ${error.message}`,
          error
        );
        // fs.unlinkSync(mediaFile.path); // Attempt cleanup on error
        res.status(500).json({ success: false, error: 'Failed to process media upload' });
      }
    }
  );

  return router;
}
