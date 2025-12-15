import type { ElizaOS, UUID, Content, Memory } from '@elizaos/core';
import {
  validateUuid,
  logger,
  ModelType,
  ChannelType,
  createUniqueUuid,
  composePromptFromState,
  messageHandlerTemplate,
} from '@elizaos/core';
import express from 'express';
import { sendError } from '../shared/response-utils';
import { convertToAudioBuffer } from './audioBuffer';

/**
 * Speech conversation functionality
 */
export function createConversationRouter(elizaOS: ElizaOS): express.Router {
  const router = express.Router();

  // Speech conversation endpoint
  router.post('/:agentId/speech/conversation', async (req, res) => {
    const agentId = validateUuid(req.params.agentId);
    if (!agentId) {
      return sendError(res, 400, 'INVALID_ID', 'Invalid agent ID format');
    }

    const { text, roomId: rawRoomId, entityId: rawUserId, worldId: rawWorldId } = req.body;
    if (!text) {
      return sendError(res, 400, 'INVALID_REQUEST', 'Text is required for conversation');
    }

    const runtime = elizaOS.getAgent(agentId);

    if (!runtime) {
      return sendError(res, 404, 'NOT_FOUND', 'Agent not found');
    }

    try {
      const roomId = createUniqueUuid(runtime, rawRoomId ?? `default-room-${agentId}`);
      const entityId = createUniqueUuid(runtime, rawUserId ?? 'Anon');
      const worldId = rawWorldId ?? createUniqueUuid(runtime, 'direct');

      logger.debug({ src: 'http', agentId }, 'Ensuring connection');
      await runtime.ensureConnection({
        entityId,
        roomId,
        userName: req.body.userName,
        name: req.body.name,
        source: 'direct',
        type: ChannelType.API,
        worldId,
        worldName: 'Direct',
      });

      const messageId = createUniqueUuid(runtime, Date.now().toString());
      const content: Content = {
        text,
        attachments: [],
        source: 'direct',
        inReplyTo: undefined,
        channelType: ChannelType.API,
      };

      const userMessageMemory: Memory = {
        id: messageId,
        entityId,
        roomId,
        worldId,
        agentId: runtime.agentId,
        content,
        createdAt: Date.now(),
      };

      logger.debug({ src: 'http', agentId }, 'Creating memory');
      await runtime.createMemory(userMessageMemory, 'messages');

      logger.debug({ src: 'http', agentId }, 'Composing state');
      const state = await runtime.composeState(userMessageMemory);

      logger.debug({ src: 'http', agentId }, 'Creating context');
      const prompt = composePromptFromState({
        state,
        template: messageHandlerTemplate,
      });

      logger.debug({ src: 'http', agentId }, 'Using LLM for response');
      const llmResponse = await runtime.useModel(ModelType.TEXT_LARGE, {
        prompt,
      });

      if (!llmResponse) {
        return sendError(res, 500, 'MODEL_ERROR', 'No response from model');
      }

      logger.debug({ src: 'http', agentId }, 'Creating response memory');

      const responseMessage: Memory = {
        // Explicitly type as Memory
        id: createUniqueUuid(runtime, `resp-${messageId}`), // Ensure new ID for response
        entityId: runtime.agentId, // Agent is sender
        agentId: runtime.agentId,
        roomId: roomId as UUID,
        worldId,
        content: { text: llmResponse, inReplyTo: messageId }, // Use llmResponse
        createdAt: Date.now(),
      };

      await runtime.createMemory(responseMessage, 'messages');
      await runtime.evaluate(userMessageMemory, state);

      await runtime.processActions(
        userMessageMemory,
        [responseMessage],
        state,
        async () => [userMessageMemory] // Callback should return relevant memories
      );

      logger.debug({ src: 'http', agentId }, 'Generating speech response');

      const speechAudioResponse = await runtime.useModel(ModelType.TEXT_TO_SPEECH, llmResponse); // Use llmResponse for TTS
      const audioResult = await convertToAudioBuffer(speechAudioResponse, true);

      logger.debug({ src: 'http', agentId }, 'Setting response headers');

      res.set({
        'Content-Type': audioResult.mimeType,
        'Content-Length': audioResult.buffer.length.toString(),
      });

      res.send(audioResult.buffer);

      logger.success(
        { src: 'http', path: req.path, agentId, agentName: runtime.character.name },
        'Successfully processed conversation'
      );
    } catch (error) {
      logger.error(
        {
          src: 'http',
          path: req.path,
          agentId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Error processing conversation'
      );
      sendError(
        res,
        500,
        'PROCESSING_ERROR',
        'Error processing conversation',
        error instanceof Error ? error.message : String(error)
      );
    }
  });

  return router;
}
