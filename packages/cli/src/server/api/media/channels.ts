import { validateUuid, logger, type UUID } from '@elizaos/core';
import express from 'express';
import type { AgentServer } from '../../index';
import { channelUpload } from '../shared/uploads';

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

  // Upload media to channel
  router.post(
    '/:channelId/upload-media',
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
        // fs.unlinkSync(mediaFile.path); // Clean up multer's temp file if invalid
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