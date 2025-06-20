import type { IAgentRuntime, UUID } from '@elizaos/core';
import { validateUuid, logger, ModelType } from '@elizaos/core';
import express from 'express';
import { sendError } from '../shared/response-utils';
import { convertToAudioBuffer } from './audioBuffer';

/**
 * Text-to-speech synthesis functionality
 */
export function createSynthesisRouter(agents: Map<UUID, IAgentRuntime>): express.Router {
  const router = express.Router();

  // Text-to-Speech endpoint
  router.post('/:agentId/audio-messages/synthesize', async (req, res) => {
    const agentId = validateUuid(req.params.agentId);
    if (!agentId) {
      return sendError(res, 400, 'INVALID_ID', 'Invalid agent ID format');
    }

    const { text } = req.body;
    if (!text) {
      return sendError(res, 400, 'INVALID_REQUEST', 'Text is required for speech synthesis');
    }

    const runtime = agents.get(agentId);

    if (!runtime) {
      return sendError(res, 404, 'NOT_FOUND', 'Agent not found');
    }

    try {
      const speechResponse = await runtime.useModel(ModelType.TEXT_TO_SPEECH, text);
      const audioResult = await convertToAudioBuffer(speechResponse, true);

      logger.debug('[TTS] Setting response headers');
      res.set({
        'Content-Type': audioResult.mimeType,
        'Content-Length': audioResult.buffer.length.toString(),
      });

      res.send(audioResult.buffer);
    } catch (error) {
      logger.error('[TTS] Error generating speech:', error);
      sendError(
        res,
        500,
        'PROCESSING_ERROR',
        'Error generating speech',
        error instanceof Error ? error.message : String(error)
      );
    }
  });

  // Speech generation endpoint
  router.post('/:agentId/speech/generate', async (req, res) => {
    logger.debug('[SPEECH GENERATE] Request to generate speech from text');
    const agentId = validateUuid(req.params.agentId);
    if (!agentId) {
      return sendError(res, 400, 'INVALID_ID', 'Invalid agent ID format');
    }

    const { text } = req.body;
    if (!text) {
      return sendError(res, 400, 'INVALID_REQUEST', 'Text is required for speech synthesis');
    }

    const runtime = agents.get(agentId);

    if (!runtime) {
      return sendError(res, 404, 'NOT_FOUND', 'Agent not found');
    }

    try {
      logger.debug('[SPEECH GENERATE] Using text-to-speech model');
      const speechResponse = await runtime.useModel(ModelType.TEXT_TO_SPEECH, text);
      const audioResult = await convertToAudioBuffer(speechResponse, true);
      logger.debug('[SPEECH GENERATE] Detected audio MIME type:', audioResult.mimeType);

      logger.debug('[SPEECH GENERATE] Setting response headers');
      res.set({
        'Content-Type': audioResult.mimeType,
        'Content-Length': audioResult.buffer.length.toString(),
      });

      res.send(audioResult.buffer);
      logger.success(
        `[SPEECH GENERATE] Successfully generated speech for: ${runtime.character.name}`
      );
    } catch (error) {
      logger.error('[SPEECH GENERATE] Error generating speech:', error);
      sendError(
        res,
        500,
        'PROCESSING_ERROR',
        'Error generating speech',
        error instanceof Error ? error.message : String(error)
      );
    }
  });

  return router;
}
