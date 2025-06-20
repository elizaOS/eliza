import { validateUuid, logger } from '@elizaos/core';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { channelUpload, validateMediaFile, processUploadedFile } from '../shared/uploads';
import { cleanupUploadedFile } from '../shared/file-utils';
import type fileUpload from 'express-fileupload';

// Using express-fileupload file type
type UploadedFile = fileUpload.UploadedFile;

interface ChannelMediaRequest extends Omit<express.Request, 'files'> {
  files?: { [fieldname: string]: UploadedFile | UploadedFile[] } | UploadedFile[];
  params: {
    channelId: string;
  };
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
    channelUpload(),
    async (req, res) => {
      const channelMediaReq = req as ChannelMediaRequest;
      const channelId = validateUuid(channelMediaReq.params.channelId);
      if (!channelId) {
        res.status(400).json({ success: false, error: 'Invalid channelId format' });
        return;
      }

      // Get the uploaded file from express-fileupload
      let mediaFile: UploadedFile;
      if (channelMediaReq.files && !Array.isArray(channelMediaReq.files)) {
        // files is an object with field names
        mediaFile = channelMediaReq.files.file as UploadedFile;
      } else if (Array.isArray(channelMediaReq.files) && channelMediaReq.files.length > 0) {
        // files is an array
        mediaFile = channelMediaReq.files[0];
      } else {
        res.status(400).json({ success: false, error: 'No media file provided' });
        return;
      }

      if (!mediaFile) {
        res.status(400).json({ success: false, error: 'No media file provided' });
        return;
      }

      // Validate file type using the helper function
      if (!validateMediaFile(mediaFile)) {
        cleanupUploadedFile(mediaFile);
        res.status(400).json({ success: false, error: `Invalid file type: ${mediaFile.mimetype}` });
        return;
      }

      try {
        // Process and move the uploaded file
        const result = await processUploadedFile(mediaFile, channelId, 'channels');

        logger.info(
          `[Channel Media Upload] File uploaded for channel ${channelId}: ${result.filename}. URL: ${result.url}`
        );

        res.json({
          success: true,
          data: {
            url: result.url, // Relative URL, client prepends server origin
            type: mediaFile.mimetype,
            filename: result.filename,
            originalName: mediaFile.name,
            size: mediaFile.size,
          },
        });
      } catch (error: any) {
        logger.error(
          `[Channel Media Upload] Error processing upload for channel ${channelId}: ${error.message}`,
          error
        );
        cleanupUploadedFile(mediaFile);
        res.status(500).json({ success: false, error: 'Failed to process media upload' });
      }
    }
  );

  return router;
}
