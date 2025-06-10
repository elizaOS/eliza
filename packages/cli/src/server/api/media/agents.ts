import type { IAgentRuntime, UUID } from '@elizaos/core';
import { validateUuid, logger } from '@elizaos/core';
import express from 'express';
import type { AgentServer } from '../../index';
import { sendError, sendSuccess } from '../shared/response-utils';
import { cleanupFile } from '../shared/file-utils';
import { agentUpload } from '../shared/uploads';

// Using Express.Multer.File type instead of importing from multer directly
type MulterFile = Express.Multer.File;

interface AgentMediaRequest extends express.Request {
  file?: MulterFile;
  params: {
    agentId: string;
  };
}

/**
 * Agent media upload functionality
 */
export function createAgentMediaRouter(
  agents: Map<UUID, IAgentRuntime>,
  serverInstance: AgentServer
): express.Router {
  const router = express.Router();

  // Media upload endpoint for images and videos
  router.post(
    '/:agentId/upload-media',
    agentUpload.single('file'),
    async (req: AgentMediaRequest, res) => {
      logger.debug('[MEDIA UPLOAD] Processing media upload');
      const agentId = validateUuid(req.params.agentId);

      if (!agentId) {
        return sendError(res, 400, 'INVALID_ID', 'Invalid agent ID format');
      }

      const mediaFile = req.file;
      if (!mediaFile) {
        return sendError(res, 400, 'INVALID_REQUEST', 'No media file provided');
      }

      const validImageTypes = [
        'image/jpeg',
        'image/png',
        'image/gif',
        'image/webp',
        'image/svg+xml',
        'image/bmp',
      ];
      const validVideoTypes = [
        'video/mp4',
        'video/webm',
        'video/mov',
        'video/avi',
        'video/mkv',
        'video/quicktime',
      ];
      const allValidTypes = [...validImageTypes, ...validVideoTypes];

      if (!allValidTypes.includes(mediaFile.mimetype)) {
        cleanupFile(mediaFile.path);
        return sendError(res, 400, 'INVALID_FILE_TYPE', 'File must be an image or video');
      }

      try {
        const fileUrl = `/media/uploads/agents/${agentId}/${mediaFile.filename}`;
        const mediaType = validImageTypes.includes(mediaFile.mimetype) ? 'image' : 'video';

        logger.info(
          `[MEDIA UPLOAD] Successfully uploaded ${mediaType}: ${mediaFile.filename}. URL: ${fileUrl}`
        );

        sendSuccess(res, {
          url: fileUrl,
          type: mediaType,
          filename: mediaFile.filename,
          originalName: mediaFile.originalname,
          size: mediaFile.size,
        });
      } catch (error) {
        logger.error(`[MEDIA UPLOAD] Error processing upload: ${error}`);
        cleanupFile(mediaFile.path);
        sendError(res, 500, 'UPLOAD_ERROR', 'Failed to process media upload', error.message);
      }
    }
  );

  return router;
}
