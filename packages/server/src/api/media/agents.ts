import { validateUuid, logger, getContentTypeFromMimeType } from '@elizaos/core';
import express from 'express';
import { sendError, sendSuccess } from '../shared/response-utils';
import { cleanupUploadedFile } from '../shared/file-utils';
import { agentMediaUpload, validateMediaFile, processUploadedFile } from '../shared/uploads';
import type fileUpload from 'express-fileupload';

// Using express-fileupload file type
type UploadedFile = fileUpload.UploadedFile;

interface AgentMediaRequest extends Omit<express.Request, 'files'> {
  files?: { [fieldname: string]: UploadedFile | UploadedFile[] } | UploadedFile[];
  params: {
    agentId: string;
  };
}

/**
 * Agent media upload functionality
 */
export function createAgentMediaRouter(): express.Router {
  const router = express.Router();

  // Media upload endpoint for images and videos
  router.post('/:agentId/upload-media', agentMediaUpload(), async (req, res) => {
    const agentMediaReq = req as AgentMediaRequest;

    logger.debug('[MEDIA UPLOAD] Processing media upload');
    const agentId = validateUuid(agentMediaReq.params.agentId);

    if (!agentId) {
      return sendError(res, 400, 'INVALID_ID', 'Invalid agent ID format');
    }

    // Get the uploaded file from express-fileupload
    let mediaFile: UploadedFile;
    if (agentMediaReq.files && !Array.isArray(agentMediaReq.files)) {
      // files is an object with field names
      mediaFile = agentMediaReq.files.file as UploadedFile;
    } else if (Array.isArray(agentMediaReq.files) && agentMediaReq.files.length > 0) {
      // files is an array
      mediaFile = agentMediaReq.files[0];
    } else {
      return sendError(res, 400, 'INVALID_REQUEST', 'No media file provided');
    }

    if (!mediaFile) {
      return sendError(res, 400, 'INVALID_REQUEST', 'No media file provided');
    }

    const mimetype = mediaFile.mimetype;

    if (!validateMediaFile(mediaFile)) {
      cleanupUploadedFile(mediaFile);
      return sendError(res, 400, 'INVALID_FILE_TYPE', 'Unsupported media file type');
    }

    const mediaType = getContentTypeFromMimeType(mimetype);

    if (!mediaType) {
      cleanupUploadedFile(mediaFile);
      return sendError(
        res,
        400,
        'UNSUPPORTED_MEDIA_TYPE',
        `Unsupported media MIME type: ${mimetype}`
      );
    }

    try {
      // Process and move the uploaded file
      const result = await processUploadedFile(mediaFile, agentId, 'agents');

      logger.info(
        `[MEDIA UPLOAD] Successfully uploaded ${mediaType}: ${result.filename}. URL: ${result.url}`
      );

      sendSuccess(res, {
        url: result.url,
        type: mediaType,
        filename: result.filename,
        originalName: mediaFile.name,
        size: mediaFile.size,
      });
    } catch (error) {
      logger.error(`[MEDIA UPLOAD] Error processing upload: ${error}`);
      cleanupUploadedFile(mediaFile);
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
