import type { IAgentRuntime, UUID } from '@elizaos/core';
import { logger, ModelType, validateUuid } from '@elizaos/core';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import type { AgentServer } from '../../index';
import { cleanupFile } from '../shared/file-utils';
import { sendError, sendSuccess } from '../shared/response-utils';
import { agentUpload } from '../shared/uploads';

// Enhanced rate limiting per IP for file uploads with more restrictions
const uploadAttempts = new Map<string, { count: number; resetTime: number; blockedUntil?: number }>();
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const MAX_UPLOADS_PER_WINDOW = 5; // Reduced to 5 uploads per minute per IP
const BLOCK_DURATION = 300000; // 5 minutes block for excessive attempts

function checkRateLimit(req: express.Request): boolean {
  const clientIP = req.ip || req.connection.remoteAddress || 'unknown';
  const now = Date.now();
  const limit = uploadAttempts.get(clientIP);

  // Check if IP is currently blocked
  if (limit?.blockedUntil && now < limit.blockedUntil) {
    logger.warn(`[RATE_LIMIT] Blocked IP ${clientIP} attempted access`);
    return false;
  }

  if (!limit || now > limit.resetTime) {
    uploadAttempts.set(clientIP, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
    return true;
  }

  if (limit.count >= MAX_UPLOADS_PER_WINDOW) {
    // Block the IP for repeated violations
    limit.blockedUntil = now + BLOCK_DURATION;
    logger.warn(`[RATE_LIMIT] IP ${clientIP} blocked for ${BLOCK_DURATION}ms due to excessive requests`);
    return false;
  }

  limit.count++;
  return true;
}

// Using Express.Multer.File type instead of importing from multer directly
type MulterFile = Express.Multer.File;

interface AudioRequest extends express.Request {
  file?: MulterFile;
  params: {
    agentId: string;
  };
}

/**
 * Audio processing functionality - upload and transcription
 */
export function createAudioProcessingRouter(
  agents: Map<UUID, IAgentRuntime>,
  serverInstance: AgentServer
): express.Router {
  const router = express.Router();

  // Audio messages endpoints
  router.post(
    '/:agentId/audio-messages',
    agentUpload.single('file'), // Use agentUpload
    async (req: AudioRequest, res) => {
      // Check rate limit
      if (!checkRateLimit(req)) {
        return sendError(res, 429, 'RATE_LIMIT_EXCEEDED', 'Too many upload attempts. Please try again later.');
      }

      logger.debug('[AUDIO MESSAGE] Processing audio message');
      const agentId = validateUuid(req.params.agentId);
      if (!agentId) {
        return sendError(res, 400, 'INVALID_ID', 'Invalid agent ID format');
      }

      const audioFile = req.file;
      if (!audioFile) {
        return sendError(res, 400, 'INVALID_REQUEST', 'No audio file provided');
      }

      const runtime = agents.get(agentId);

      if (!runtime) {
        return sendError(res, 404, 'NOT_FOUND', 'Agent not found');
      }

      try {
        // Additional file validation
        const stats = await fs.promises.stat(audioFile.path);
        if (stats.size > 50 * 1024 * 1024) { // 50MB limit
          cleanupFile(audioFile.path);
          return sendError(res, 413, 'FILE_TOO_LARGE', 'Audio file too large (max 50MB)');
        }

        const audioBuffer = await fs.promises.readFile(audioFile.path);
        const transcription = await runtime.useModel(ModelType.TRANSCRIPTION, audioBuffer);

        // Placeholder: This part needs to be updated to align with message creation.
        logger.info(`[AUDIO MESSAGE] Transcription for agent ${agentId}: ${transcription}`);
        cleanupFile(audioFile.path);
        sendSuccess(res, { transcription, message: 'Audio transcribed, further processing TBD.' });
      } catch (error) {
        logger.error('[AUDIO MESSAGE] Error processing audio:', error);
        cleanupFile(audioFile?.path);
        sendError(res, 500, 'PROCESSING_ERROR', 'Error processing audio message', error.message);
      }
    }
  );

  // Transcription endpoint
  router.post(
    '/:agentId/transcriptions',
    agentUpload.single('file'), // Use agentUpload
    async (req: AudioRequest, res) => {
      // Check rate limit
      if (!checkRateLimit(req)) {
        return sendError(res, 429, 'RATE_LIMIT_EXCEEDED', 'Too many upload attempts. Please try again later.');
      }

      logger.debug('[TRANSCRIPTION] Request to transcribe audio');
      const agentId = validateUuid(req.params.agentId);
      if (!agentId) {
        return sendError(res, 400, 'INVALID_ID', 'Invalid agent ID format');
      }

      const audioFile = req.file;
      if (!audioFile) {
        return sendError(res, 400, 'INVALID_REQUEST', 'No audio file provided');
      }

      const runtime = agents.get(agentId);

      if (!runtime) {
        return sendError(res, 404, 'NOT_FOUND', 'Agent not found');
      }

      try {
        logger.debug('[TRANSCRIPTION] Reading audio file');

        if (!audioFile.path.startsWith(os.homedir())) {
          cleanupFile(audioFile.path);
          return sendError(res, 403, 'INVALID_PATH', 'Invalid file path');
        }

        const stats = await fs.promises.stat(audioFile.path);
        if (stats.size > 50 * 1024 * 1024) { // 50MB limit
          cleanupFile(audioFile.path);
          return sendError(res, 413, 'FILE_TOO_LARGE', 'Audio file too large (max 50MB)');
        }

        const audioBuffer = await fs.promises.readFile(audioFile.path);

        logger.debug('[TRANSCRIPTION] Transcribing audio');
        const transcription = await runtime.useModel(ModelType.TRANSCRIPTION, audioBuffer);

        cleanupFile(audioFile.path);

        if (!transcription) {
          return sendError(res, 500, 'PROCESSING_ERROR', 'Failed to transcribe audio');
        }

        logger.success('[TRANSCRIPTION] Successfully transcribed audio');
        sendSuccess(res, { text: transcription });
      } catch (error) {
        logger.error('[TRANSCRIPTION] Error transcribing audio:', error);
        cleanupFile(audioFile?.path);
        sendError(res, 500, 'PROCESSING_ERROR', 'Error transcribing audio', error.message);
      }
    }
  );

  return router;
}