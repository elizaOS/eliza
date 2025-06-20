import type { IAgentRuntime, UUID } from '@elizaos/core';
import { logger, ModelType, validateUuid } from '@elizaos/core';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanupUploadedFile } from '../shared/file-utils';
import { sendError, sendSuccess } from '../shared/response-utils';
import { agentAudioUpload, validateAudioFile } from '../shared/uploads';
import { createFileSystemRateLimit, createUploadRateLimit } from '../shared/middleware';
import { MAX_FILE_SIZE, MAX_FILE_SIZE_DISPLAY } from '../shared/constants';
import type fileUpload from 'express-fileupload';

// Using express-fileupload file type
type UploadedFile = fileUpload.UploadedFile;

interface AudioRequest extends Omit<express.Request, 'files'> {
  files?: { [fieldname: string]: UploadedFile | UploadedFile[] } | UploadedFile[];
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

  // Resolve and normalize the path
  const resolvedPath = path.resolve(filePath);
  const normalizedPath = path.normalize(resolvedPath);

  // Ensure the path doesn't contain directory traversal attempts
  if (normalizedPath.includes('..') || normalizedPath !== resolvedPath) {
    throw new Error('Invalid file path: path traversal detected');
  }

  // Ensure the path is within the current working directory or system temp
  const allowedBasePaths = [process.cwd(), os.tmpdir(), os.homedir()];

  const isPathAllowed = allowedBasePaths.some((basePath) =>
    normalizedPath.startsWith(path.resolve(basePath))
  );

  if (!isPathAllowed) {
    throw new Error('Invalid file path: path outside allowed directories');
  }

  // Additional security: ensure file exists and is a regular file
  try {
    const stats = fs.statSync(normalizedPath);
    if (!stats.isFile()) {
      throw new Error('Path does not point to a regular file');
    }
  } catch (error) {
    throw new Error(`File access error: ${error instanceof Error ? error.message : String(error)}`);
  }

  return normalizedPath;
}

/**
 * Helper function to get uploaded file from express-fileupload request
 */
function getUploadedFile(req: AudioRequest): UploadedFile | null {
  if (req.files && !Array.isArray(req.files)) {
    // files is an object with field names
    return req.files.file as UploadedFile;
  } else if (Array.isArray(req.files) && req.files.length > 0) {
    // files is an array
    return req.files[0];
  }
  return null;
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
  router.post(
    '/:agentId/audio-messages',
    agentAudioUpload(), // Use agentAudioUpload
    async (req, res) => {
      const audioReq = req as AudioRequest;
      logger.debug('[AUDIO MESSAGE] Processing audio message');
      const agentId = validateUuid(req.params.agentId);
      if (!agentId) {
        return sendError(res, 400, 'INVALID_ID', 'Invalid agent ID format');
      }

      const audioFile = getUploadedFile(audioReq);
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

        // Validate file path security before any file operations
        let securePath: string;
        try {
          const filePath = audioFile.tempFilePath || '';
          securePath = validateSecureFilePath(filePath);
        } catch (pathError) {
          cleanupUploadedFile(audioFile);
          return sendError(
            res,
            403,
            'INVALID_PATH',
            `Invalid file path: ${pathError instanceof Error ? pathError.message : String(pathError)}`
          );
        }

        // Additional file validation using secure path
        const stats = await fs.promises.stat(securePath);
        if (stats.size > MAX_FILE_SIZE) {
          cleanupUploadedFile(audioFile);
          return sendError(
            res,
            413,
            'FILE_TOO_LARGE',
            `Audio file too large (max ${MAX_FILE_SIZE_DISPLAY})`
          );
        }

        const audioBuffer = await fs.promises.readFile(securePath);
        const transcription = await runtime.useModel(ModelType.TRANSCRIPTION, audioBuffer);

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
    }
  );

  // Transcription endpoint
  router.post(
    '/:agentId/transcriptions',
    agentAudioUpload(), // Use agentAudioUpload
    async (req, res) => {
      const audioReq = req as AudioRequest;
      logger.debug('[TRANSCRIPTION] Request to transcribe audio');
      const agentId = validateUuid(req.params.agentId);
      if (!agentId) {
        return sendError(res, 400, 'INVALID_ID', 'Invalid agent ID format');
      }

      const audioFile = getUploadedFile(audioReq);
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

        // Validate file path security before any file operations
        let securePath: string;
        try {
          const filePath = audioFile.tempFilePath || '';
          securePath = validateSecureFilePath(filePath);
        } catch (pathError) {
          cleanupUploadedFile(audioFile);
          return sendError(
            res,
            403,
            'INVALID_PATH',
            `Invalid file path: ${pathError instanceof Error ? pathError.message : String(pathError)}`
          );
        }

        const stats = await fs.promises.stat(securePath);
        if (stats.size > MAX_FILE_SIZE) {
          cleanupUploadedFile(audioFile);
          return sendError(
            res,
            413,
            'FILE_TOO_LARGE',
            `Audio file too large (max ${MAX_FILE_SIZE_DISPLAY})`
          );
        }

        const audioBuffer = await fs.promises.readFile(securePath);

        logger.debug('[TRANSCRIPTION] Transcribing audio');
        const transcription = await runtime.useModel(ModelType.TRANSCRIPTION, audioBuffer);

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
    }
  );

  return router;
}
