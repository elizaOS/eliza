import express from 'express';
import { createAgentMediaRouter } from './agents';
import { createChannelMediaRouter } from './channels';

/**
 * Creates the media router for file uploads and media handling
 */
export function mediaRouter(): express.Router {
  const router = express.Router();

  // Mount agent media uploads under /agents
  router.use('/agents', createAgentMediaRouter());

  // Mount channel media uploads under /channels
  router.use('/channels', createChannelMediaRouter());

  return router;
}
