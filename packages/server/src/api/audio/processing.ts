import type { IAgentRuntime, UUID } from '@elizaos/core';
import { logger, ModelType, validateUuid } from '@elizaos/core';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanupUploadedFile } from '../shared/file-utils.js';
import { sendError, sendSuccess } from '../shared/response-utils.js';
import { agentAudioUpload, validateAudioFile } from '../shared/uploads/index.js';
import { createFileSystemRateLimit, createUploadRateLimit } from '../shared/middleware.js';
import { MAX_FILE_SIZE, MAX_FILE_SIZE_DISPLAY } from '../shared/constants.js';

interface AudioRequest extends express.Request {
  file?: Express.Multer.File;
  params: {
    agentId: string;
  };
}

/**
 * Securely validates a file path to prevent path traversal attacks
 */
function validateSecureFilePath(filePath: string): string {
  if (!filePath) {
    throw new Error('File path is required');
  }

  // Normalize and resolve the path to handle any ".." or other path issues
  const normalizedPath = path.normalize(filePath);
  const resolvedPath = path.resolve(normalizedPath);

  // Additional security checks
  if (normalizedPath.includes('..')) {
    throw new Error('Path traversal attempt detected');
  }

  // Ensure the file is within system temp directory or upload directory
  const systemTemp = path.resolve(os.tmpdir());
  const projectUpload = path.resolve(process.cwd(), '.eliza', 'data', 'uploads');

  if (!resolvedPath.startsWith(systemTemp) && !resolvedPath.startsWith(projectUpload)) {
    throw new Error('File path outside allowed directories');
  }

  // Check if file exists and is readable
  try {
    const stats = fs.statSync(resolvedPath);
    if (!stats.isFile()) {
      throw new Error('Path does not point to a file');
    }
  } catch (error) {
    throw new Error(`File access error: ${error instanceof Error ? error.message : String(error)}`);
  }

  return normalizedPath;
}

/**
 * Audio processing functionality - upload and transcription
 */
export function createAudioProcessingRouter(agents: Map<UUID, IAgentRuntime>): express.Router {
  const router = express.Router();

  // Apply rate limiting to all audio processing routes
  router.use(createUploadRateLimit());
  router.use(createFileSystemRateLimit());

  // Audio messages endpoints
  router.post('/:agentId/audio-messages', agentAudioUpload().single('file'), async (req, res) => {
    const audioReq = req as AudioRequest;
    logger.debug('[AUDIO MESSAGE] Processing audio message');
    const agentId = validateUuid(req.params.agentId);
    if (!agentId) {
      return sendError(res, 400, 'INVALID_ID', 'Invalid agent ID format');
    }

    const audioFile = audioReq.file;
    if (!audioFile) {
      return sendError(res, 400, 'INVALID_REQUEST', 'No audio file provided');
    }

    const runtime = agents.get(agentId);

    if (!runtime) {
      cleanupUploadedFile(audioFile);
      return sendError(res, 404, 'NOT_FOUND', 'Agent not found');
    }

    try {
      // Validate file type
      if (!validateAudioFile(audioFile)) {
        cleanupUploadedFile(audioFile);
        return sendError(res, 400, 'INVALID_FILE_TYPE', 'Invalid audio file type');
      }

      // Validate file size
      if (audioFile.size > MAX_FILE_SIZE) {
        cleanupUploadedFile(audioFile);
        return sendError(
          res,
          413,
          'FILE_TOO_LARGE',
          `Audio file too large (max ${MAX_FILE_SIZE_DISPLAY})`
        );
      }

      // Use file buffer directly for transcription
      const transcription = await runtime.useModel(ModelType.TRANSCRIPTION, audioFile.buffer);

      // Placeholder: This part needs to be updated to align with message creation.
      logger.info(`[AUDIO MESSAGE] Transcription for agent ${agentId}: ${transcription}`);
      cleanupUploadedFile(audioFile);
      sendSuccess(res, { transcription, message: 'Audio transcribed, further processing TBD.' });
    } catch (error) {
      logger.error('[AUDIO MESSAGE] Error processing audio:', error);
      cleanupUploadedFile(audioFile);
      sendError(
        res,
        500,
        'PROCESSING_ERROR',
        'Error processing audio message',
        error instanceof Error ? error.message : String(error)
      );
    }
  });

  // Transcription endpoint
  router.post('/:agentId/transcriptions', agentAudioUpload().single('file'), async (req, res) => {
    const audioReq = req as AudioRequest;
    logger.debug('[TRANSCRIPTION] Request to transcribe audio');
    const agentId = validateUuid(req.params.agentId);
    if (!agentId) {
      return sendError(res, 400, 'INVALID_ID', 'Invalid agent ID format');
    }

    const audioFile = audioReq.file;
    if (!audioFile) {
      return sendError(res, 400, 'INVALID_REQUEST', 'No audio file provided');
    }

    const runtime = agents.get(agentId);

    if (!runtime) {
      cleanupUploadedFile(audioFile);
      return sendError(res, 404, 'NOT_FOUND', 'Agent not found');
    }

    try {
      logger.debug('[TRANSCRIPTION] Reading audio file');

      // Validate file type
      if (!validateAudioFile(audioFile)) {
        cleanupUploadedFile(audioFile);
        return sendError(res, 400, 'INVALID_FILE_TYPE', 'Invalid audio file type');
      }

      // Validate file size
      if (audioFile.size > MAX_FILE_SIZE) {
        cleanupUploadedFile(audioFile);
        return sendError(
          res,
          413,
          'FILE_TOO_LARGE',
          `Audio file too large (max ${MAX_FILE_SIZE_DISPLAY})`
        );
      }

      // Use file buffer directly for transcription
      logger.debug('[TRANSCRIPTION] Transcribing audio');
      const transcription = await runtime.useModel(ModelType.TRANSCRIPTION, audioFile.buffer);

      cleanupUploadedFile(audioFile);

      if (!transcription) {
        return sendError(res, 500, 'PROCESSING_ERROR', 'Failed to transcribe audio');
      }

      logger.success('[TRANSCRIPTION] Successfully transcribed audio');
      sendSuccess(res, { text: transcription });
    } catch (error) {
      logger.error('[TRANSCRIPTION] Error transcribing audio:', error);
      cleanupUploadedFile(audioFile);
      sendError(
        res,
        500,
        'PROCESSING_ERROR',
        'Error transcribing audio',
        error instanceof Error ? error.message : String(error)
      );
    }
  });

  return router;
}
