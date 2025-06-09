import type { IAgentRuntime, UUID } from '@elizaos/core';
import { validateUuid, logger, ModelType } from '@elizaos/core';
import express from 'express';
import fs from 'node:fs';
import type { AgentServer } from '../../index';
import { sendError, sendSuccess } from '../shared/response-utils';
import { cleanupFile } from '../shared/file-utils';
import { agentUpload } from '../shared/uploads';

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
  serverInstance?: AgentServer
): express.Router {
  const router = express.Router();

  // Audio messages endpoints
  router.post(
    '/:agentId/audio-messages',
    agentUpload.single('file'), // Use agentUpload
    async (req: AudioRequest, res) => {
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