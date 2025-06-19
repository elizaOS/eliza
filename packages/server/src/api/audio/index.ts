import type { IAgentRuntime, UUID } from '@elizaos/core';
import express from 'express';
import { createAudioProcessingRouter } from './processing';
import { createSynthesisRouter } from './synthesis';
import { createConversationRouter } from './conversation';

/**
 * Creates the audio router for speech and audio processing
 */
export function audioRouter(agents: Map<UUID, IAgentRuntime>): express.Router {
  const router = express.Router();

  // Mount audio processing (upload, transcription)
  router.use('/', createAudioProcessingRouter(agents));

  // Mount text-to-speech synthesis
  router.use('/', createSynthesisRouter(agents));

  // Mount speech conversation functionality
  router.use('/', createConversationRouter(agents));

  return router;
}
