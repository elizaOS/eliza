import type { ElizaOS } from '@elizaos/core';
import express from 'express';
import { createAudioProcessingRouter } from './processing';
import { createSynthesisRouter } from './synthesis';
import { createConversationRouter } from './conversation';

/**
 * Creates the audio router for speech and audio processing
 */
export function audioRouter(elizaOS: ElizaOS): express.Router {
  const router = express.Router();

  // Mount audio processing (upload, transcription)
  router.use('/', createAudioProcessingRouter(elizaOS));

  // Mount text-to-speech synthesis
  router.use('/', createSynthesisRouter(elizaOS));

  // Mount speech conversation functionality
  router.use('/', createConversationRouter(elizaOS));

  return router;
}
