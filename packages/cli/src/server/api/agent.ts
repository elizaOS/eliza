import type { Agent, Character, Content, IAgentRuntime, Memory, UUID } from '@elizaos/core';
import {
  ChannelType,
  ModelType,
  composePrompt,
  composePromptFromState,
  createUniqueUuid,
  logger,
  messageHandlerTemplate,
  validateUuid,
} from '@elizaos/core';
import express from 'express';
import fs from 'node:fs';
import { Readable } from 'node:stream';
import type { AgentServer } from '..';
import { WebSocketFactory } from '../socketio/WebSocketFactory';
import { upload } from '../loader';

/**
 * Interface representing a custom request object that extends the express.Request interface.
 * @interface CustomRequest
 * @extends express.Request
 * @property {Express.Multer.File} [file] - Optional property representing a file uploaded with the request
 * @property {Object} params - Object representing parameters included in the request
 * @property {string} params.agentId - The unique identifier for the agent associated with the request
 */
interface CustomRequest extends express.Request {
  file?: Express.Multer.File;
  params: {
    agentId: string;
  };
}

/**
 * Creates an express Router for handling agent-related routes.
 *
 * @param agents - Map of UUID to agent runtime instances.
 * @param server - Optional AgentServer instance.
 * @returns An express Router for agent routes.
 */
export function agentRouter(
  agents: Map<UUID, IAgentRuntime>,
  server?: AgentServer
): express.Router {
  const router = express.Router();
  const db = server?.database;

  // List all agents
  router.get('/', async (_, res) => {
    logger.debug('[AGENTS LIST] Retrieving list of all agents');
    try {
      const allAgents = await db.getAgents();

      // find running agents
      const runtimes = Array.from(agents.keys());

      // returns minimal agent data
      const response = allAgents
        .map((agent: Agent) => ({
          ...agent,
          status: runtimes.includes(agent.id) ? 'active' : 'inactive',
        }))
        .sort((a: any, b: any) => {
          if (a.status === b.status) {
            return a.name.localeCompare(b.name);
          }
          return a.status === 'active' ? -1 : 1;
        });

      res.json({
        success: true,
        data: { agents: response },
      });
    } catch (error) {
      logger.error('[AGENTS LIST] Error retrieving agents:', error);
      res.status(500).json({
        success: false,
        error: {
          code: 500,
          message: 'Error retrieving agents',
          details: error.message,
        },
      });
    }
  });

  // Get specific agent details
  router.get('/:agentId', async (req, res) => {
    const agentId = validateUuid(req.params.agentId);
    if (!agentId) {
      res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_ID',
          message: 'Invalid agent ID format',
        },
      });
      return;
    }

    try {
      const agent = await db.getAgent(agentId);
      if (!agent) {
        logger.warn('[AGENT GET] Agent not found');
        res.status(404).json({
          success: false,
          error: {
            code: 'NOT_FOUND',
            message: 'Agent not found',
          },
        });
        return;
      }

      const runtime = agents.get(agentId);

      // check if agent is running
      const status = runtime ? 'active' : 'inactive';

      res.json({
        success: true,
        data: { ...agent, status },
      });
    } catch (error) {
      logger.error('[AGENT GET] Error getting agent:', error);
      res.status(500).json({
        success: false,
        error: {
          code: 500,
          message: 'Error getting agent',
          details: error.message,
        },
      });
    }
  });

  // Create new agent
  router.post('/', async (req, res) => {
    logger.info('[AGENT CREATE] Creating new agent');
    const { characterPath, characterJson } = req.body;

    try {
      let character: Character;

      if (characterJson) {
        logger.debug('[AGENT CREATE] Parsing character from JSON');
        character = await server?.jsonToCharacter(characterJson);
      } else if (characterPath) {
        logger.debug(`[AGENT CREATE] Loading character from path: ${characterPath}`);
        character = await server?.loadCharacterTryPath(characterPath);
      } else {
        throw new Error('No character configuration provided');
      }

      if (!character) {
        throw new Error('Failed to create character configuration');
      }

      await db.ensureAgentExists(character);

      res.status(201).json({
        success: true,
        data: {
          character: character,
        },
      });
      logger.success(`[AGENT CREATE] Successfully created agent: ${character.name}`);
    } catch (error) {
      logger.error('[AGENT CREATE] Error creating agent:', error);
      res.status(400).json({
        success: false,
        error: {
          code: 'CREATE_ERROR',
          message: 'Error creating agent',
          details: error.message,
        },
      });
    }
  });

  // Update agent
  router.patch('/:agentId', async (req, res) => {
    const agentId = validateUuid(req.params.agentId);
    if (!agentId) {
      res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_ID',
          message: 'Invalid agent ID format',
        },
      });
      return;
    }

    const updates = req.body;

    try {
      // Handle other updates if any
      if (Object.keys(updates).length > 0) {
        await db.updateAgent(agentId, updates);
      }

      const updatedAgent = await db.getAgent(agentId);

      const isActive = !!agents.get(agentId);
      if (isActive) {
        // stop existing runtime
        server?.unregisterAgent(agentId);
        // start new runtime
        await server?.startAgent(updatedAgent);
      }

      // check if agent got started successfully
      const runtime = agents.get(agentId);
      const status = runtime ? 'active' : 'inactive';

      res.json({
        success: true,
        data: { ...updatedAgent, status },
      });
    } catch (error) {
      logger.error('[AGENT UPDATE] Error updating agent:', error);
      res.status(500).json({
        success: false,
        error: {
          code: 'UPDATE_ERROR',
          message: 'Error updating agent',
          details: error.message,
        },
      });
    }
  });

  // Stop an existing agent
  router.put('/:agentId', async (req, res) => {
    const agentId = validateUuid(req.params.agentId);
    if (!agentId) {
      logger.warn('[AGENT STOP] Invalid agent ID format');
      res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_ID',
          message: 'Invalid agent ID format',
        },
      });
      return;
    }

    // get agent runtime
    const runtime = agents.get(agentId);
    if (!runtime) {
      res.status(404).json({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: 'Agent not found',
        },
      });
      return;
    }

    // Disconnect agent from WebSocket
    try {
      const serverUrl = `http://localhost:${process.env.PORT || 3000}`;
      const webSocketFactory = WebSocketFactory.getInstance(serverUrl);

      // Get a list of rooms for this agent
      const rooms = await runtime.getRoomsForParticipant(agentId);

      // Disconnect from each room
      for (const roomId of rooms) {
        webSocketFactory.removeService(agentId, roomId as string);
        logger.info(`[AGENT STOP] Agent ${agentId} disconnected from room ${roomId} via WebSocket`);
      }
    } catch (error) {
      logger.error(`[AGENT STOP] Error disconnecting agent ${agentId} from WebSocket:`, error);
      // Don't fail the agent stop if WebSocket disconnection fails
    }

    // stop existing runtime
    server?.unregisterAgent(agentId);

    // return success
    res.json({
      success: true,
      data: {
        message: 'Agent stopped',
      },
    });
  });

  // Start an existing agent
  router.post('/:agentId', async (req, res) => {
    const agentId = validateUuid(req.params.agentId);
    if (!agentId) {
      res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_ID',
          message: 'Invalid agent ID format',
        },
      });
      return;
    }

    try {
      // Check if agent exists
      const agent = await db.getAgent(agentId);

      if (!agent) {
        logger.warn('[AGENT START] Agent not found');
        res.status(404).json({
          success: false,
          error: {
            code: 'NOT_FOUND',
            message: 'Agent not found',
          },
        });
        return;
      }

      const isActive = !!agents.get(agentId);

      // Check if agent is already running
      if (isActive) {
        logger.info(`[AGENT START] Agent ${agentId} is already running`);
        res.json({
          success: true,
          data: {
            id: agentId,
            name: agent.name,
            status: 'active',
          },
        });
        return;
      }

      // Start the agent
      await server?.startAgent(agent);

      // Verify agent started successfully
      const runtime = agents.get(agentId);
      if (!runtime) {
        throw new Error('Failed to start agent');
      }

      // Connect agent to the WebSocket server
      try {
        const serverUrl = `http://localhost:${process.env.PORT || 3000}`;
        const webSocketFactory = WebSocketFactory.getInstance(serverUrl);

        // Get a list of rooms for this agent
        const rooms = await runtime.getRoomsForParticipant(agentId);
        logger.info(`[AGENT START] Found ${rooms.length} rooms for agent ${agentId}`);

        // Connect the agent to each room
        for (const roomId of rooms) {
          const webSocketService = webSocketFactory.createAgentService(
            agentId,
            roomId as string,
            runtime
          );
          webSocketService
            .connect()
            .then(() => {
              logger.info(
                `[AGENT START] Agent ${agentId} connected to room ${roomId} via WebSocket`
              );
            })
            .catch((error) => {
              logger.error(
                `[AGENT START] Failed to connect agent ${agentId} to room ${roomId} via WebSocket:`,
                error
              );
            });
        }
      } catch (error) {
        logger.error(`[AGENT START] Error connecting agent ${agentId} to WebSocket:`, error);
        // Don't fail the agent start if WebSocket connection fails
      }

      logger.success(`[AGENT START] Successfully started agent: ${agent.name}`);
      res.json({
        success: true,
        data: {
          id: agentId,
          name: agent.name,
          status: 'active',
        },
      });
    } catch (error) {
      logger.error('[AGENT START] Error starting agent:', error);
      res.status(500).json({
        success: false,
        error: {
          code: 'START_ERROR',
          message: 'Error starting agent',
          details: error instanceof Error ? error.message : String(error),
        },
      });
    }
  });

  // Delete agent
  router.delete('/:agentId', async (req, res) => {
    const agentId = validateUuid(req.params.agentId);
    if (!agentId) {
      res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_ID',
          message: 'Invalid agent ID format',
        },
      });
      return;
    }

    try {
      const runtime = agents.get(agentId);

      // Disconnect agent from WebSocket if running
      if (runtime) {
        try {
          const serverUrl = `http://localhost:${process.env.PORT || 3000}`;
          const webSocketFactory = WebSocketFactory.getInstance(serverUrl);

          // Get a list of rooms for this agent
          const rooms = await runtime.getRoomsForParticipant(agentId);

          // Disconnect from each room
          for (const roomId of rooms) {
            webSocketFactory.removeService(agentId, roomId as string);
            logger.info(
              `[AGENT DELETE] Agent ${agentId} disconnected from room ${roomId} via WebSocket`
            );
          }
        } catch (error) {
          logger.error(
            `[AGENT DELETE] Error disconnecting agent ${agentId} from WebSocket:`,
            error
          );
          // Don't fail the agent deletion if WebSocket disconnection fails
        }

        // if agent is running, stop it
        server?.unregisterAgent(agentId);
      }

      await db.deleteAgent(agentId);
      res.status(204).send();
    } catch (error) {
      logger.error('[AGENT DELETE] Error deleting agent:', error);
      res.status(500).json({
        success: false,
        error: {
          code: 'DELETE_ERROR',
          message: 'Error deleting agent',
          details: error.message,
        },
      });
    }
  });

  // Get Agent Logs
  router.get('/:agentId/logs', async (req, res) => {
    const agentId = validateUuid(req.params.agentId);
    const { roomId, type, count, offset } = req.query;
    if (!agentId) {
      res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_ID',
          message: 'Invalid agent ID format',
        },
      });
      return;
    }

    const runtime = agents.get(agentId);
    if (!runtime) {
      res.status(404).json({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: 'Agent not found',
        },
      });
      return;
    }

    if (roomId) {
      const roomIdValidated = validateUuid(roomId);
      if (!roomIdValidated) {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_ID',
            message: 'Invalid room ID format',
          },
        });
        return;
      }
    }

    const logs = await runtime.getLogs({
      entityId: agentId,
      roomId: roomId ? (roomId as UUID) : undefined,
      type: type ? (type as string) : undefined,
      count: count ? Number(count) : undefined,
      offset: offset ? Number(offset) : undefined,
    });

    res.json({
      success: true,
      data: logs,
    });
  });

  router.delete('/:agentId/logs/:logId', async (req, res) => {
    const agentId = validateUuid(req.params.agentId);
    const logId = validateUuid(req.params.logId);
    if (!agentId || !logId) {
      res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_ID',
          message: 'Invalid agent or log ID format',
        },
      });
      return;
    }

    const runtime = agents.get(agentId);
    if (!runtime) {
      res.status(404).json({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: 'Agent not found',
        },
      });
      return;
    }

    await runtime.deleteLog(logId);

    res.status(204).send();
  });

  // Audio messages endpoints
  router.post(
    '/:agentId/audio-messages',
    upload.single('file'),
    async (req: CustomRequest, res) => {
      logger.info('[AUDIO MESSAGE] Processing audio message');
      const agentId = validateUuid(req.params.agentId);
      if (!agentId) {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_ID',
            message: 'Invalid agent ID format',
          },
        });
        return;
      }

      const audioFile = req.file;
      if (!audioFile) {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_REQUEST',
            message: 'No audio file provided',
          },
        });
        return;
      }

      const runtime = agents.get(agentId);

      if (!runtime) {
        res.status(404).json({
          success: false,
          error: {
            code: 'NOT_FOUND',
            message: 'Agent not found',
          },
        });
        return;
      }

      try {
        const audioBuffer = fs.readFileSync(audioFile.path);
        const transcription = await runtime.useModel(ModelType.TRANSCRIPTION, audioBuffer);

        // Process the transcribed text as a message
        const messageRequest = {
          ...req,
          body: {
            ...req.body,
            text: transcription,
          },
        };

        // Reuse the message endpoint logic
        await this.post('/:agentId/messages')(messageRequest, res);
      } catch (error) {
        logger.error('[AUDIO MESSAGE] Error processing audio:', error);
        res.status(500).json({
          success: false,
          error: {
            code: 'PROCESSING_ERROR',
            message: 'Error processing audio message',
            details: error.message,
          },
        });
      }
    }
  );

  // Text-to-Speech endpoint
  router.post('/:agentId/audio-messages/synthesize', async (req, res) => {
    const agentId = validateUuid(req.params.agentId);
    if (!agentId) {
      res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_ID',
          message: 'Invalid agent ID format',
        },
      });
      return;
    }

    const { text } = req.body;
    if (!text) {
      res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_REQUEST',
          message: 'Text is required for speech synthesis',
        },
      });
      return;
    }

    const runtime = agents.get(agentId);

    if (!runtime) {
      res.status(404).json({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: 'Agent not found',
        },
      });
      return;
    }

    try {
      const speechResponse = await runtime.useModel(ModelType.TEXT_TO_SPEECH, text);

      // Convert to Buffer if not already a Buffer
      const audioBuffer = Buffer.isBuffer(speechResponse)
        ? speechResponse
        : await new Promise<Buffer>((resolve, reject) => {
            if (!(speechResponse instanceof Readable)) {
              return reject(new Error('Unexpected response type from TEXT_TO_SPEECH model'));
            }

            const chunks: Buffer[] = [];
            speechResponse.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
            speechResponse.on('end', () => resolve(Buffer.concat(chunks)));
            speechResponse.on('error', (err) => reject(err));
          });

      logger.debug('[TTS] Setting response headers');
      res.set({
        'Content-Type': 'audio/mpeg',
        'Transfer-Encoding': 'chunked',
      });

      res.send(Buffer.from(audioBuffer));
    } catch (error) {
      logger.error('[TTS] Error generating speech:', error);
      res.status(500).json({
        success: false,
        error: {
          code: 'PROCESSING_ERROR',
          message: 'Error generating speech',
          details: error.message,
        },
      });
    }
  });

  // Speech-related endpoints
  router.post('/:agentId/speech/generate', async (req, res) => {
    logger.info('[SPEECH GENERATE] Request to generate speech from text');
    const agentId = validateUuid(req.params.agentId);
    if (!agentId) {
      res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_ID',
          message: 'Invalid agent ID format',
        },
      });
      return;
    }

    const { text } = req.body;
    if (!text) {
      res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_REQUEST',
          message: 'Text is required for speech synthesis',
        },
      });
      return;
    }

    const runtime = agents.get(agentId);

    if (!runtime) {
      res.status(404).json({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: 'Agent not found',
        },
      });
      return;
    }

    try {
      logger.info('[SPEECH GENERATE] Using text-to-speech model');
      const speechResponse = await runtime.useModel(ModelType.TEXT_TO_SPEECH, text);

      // Convert to Buffer if not already a Buffer
      const audioBuffer = Buffer.isBuffer(speechResponse)
        ? speechResponse
        : await new Promise<Buffer>((resolve, reject) => {
            if (!(speechResponse instanceof Readable)) {
              return reject(new Error('Unexpected response type from TEXT_TO_SPEECH model'));
            }

            const chunks: Buffer[] = [];
            speechResponse.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
            speechResponse.on('end', () => resolve(Buffer.concat(chunks)));
            speechResponse.on('error', (err) => reject(err));
          });

      logger.debug('[SPEECH GENERATE] Setting response headers');
      res.set({
        'Content-Type': 'audio/mpeg',
        'Transfer-Encoding': 'chunked',
      });

      res.send(Buffer.from(audioBuffer));
      logger.success(
        `[SPEECH GENERATE] Successfully generated speech for: ${runtime.character.name}`
      );
    } catch (error) {
      logger.error('[SPEECH GENERATE] Error generating speech:', error);
      res.status(500).json({
        success: false,
        error: {
          code: 'PROCESSING_ERROR',
          message: 'Error generating speech',
          details: error.message,
        },
      });
    }
  });

  router.post('/:agentId/speech/conversation', async (req, res) => {
    const agentId = validateUuid(req.params.agentId);
    if (!agentId) {
      res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_ID',
          message: 'Invalid agent ID format',
        },
      });
      return;
    }

    const { text, roomId: rawRoomId, entityId: rawUserId } = req.body;
    if (!text) {
      res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_REQUEST',
          message: 'Text is required for conversation',
        },
      });
      return;
    }

    const runtime = agents.get(agentId);

    if (!runtime) {
      res.status(404).json({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: 'Agent not found',
        },
      });
      return;
    }

    try {
      const roomId = createUniqueUuid(runtime, rawRoomId ?? `default-room-${agentId}`);
      const entityId = createUniqueUuid(runtime, rawUserId ?? 'Anon');

      logger.debug('[SPEECH CONVERSATION] Ensuring connection');
      await runtime.ensureConnection({
        entityId,
        roomId,
        userName: req.body.userName,
        name: req.body.name,
        source: 'direct',
        type: ChannelType.API,
      });

      const messageId = createUniqueUuid(runtime, Date.now().toString());
      const content: Content = {
        text,
        attachments: [],
        source: 'direct',
        inReplyTo: undefined,
        channelType: ChannelType.API,
      };

      const userMessage = {
        content,
        entityId,
        roomId,
        agentId: runtime.agentId,
      };

      const memory: Memory = {
        id: messageId,
        agentId: runtime.agentId,
        entityId,
        roomId,
        content,
        createdAt: Date.now(),
      };

      logger.debug('[SPEECH CONVERSATION] Creating memory');
      await runtime.createMemory(memory, 'messages');

      logger.debug('[SPEECH CONVERSATION] Composing state');
      const state = await runtime.composeState(userMessage);

      logger.debug('[SPEECH CONVERSATION] Creating context');
      const prompt = composePrompt({
        state,
        template: messageHandlerTemplate,
      });

      logger.info('[SPEECH CONVERSATION] Using LLM for response');
      const response = await runtime.useModel(ModelType.TEXT_LARGE, {
        messages: [
          {
            role: 'system',
            content: messageHandlerTemplate,
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
      });

      if (!response) {
        res.status(500).json({
          success: false,
          error: {
            code: 'MODEL_ERROR',
            message: 'No response from model',
          },
        });
        return;
      }

      logger.debug('[SPEECH CONVERSATION] Creating response memory');

      const responseMessage = {
        ...userMessage,
        content: { text: response },
        roomId: roomId as UUID,
        agentId: runtime.agentId,
      };

      await runtime.createMemory(responseMessage, 'messages');
      await runtime.evaluate(memory, state);

      await runtime.processActions(memory, [responseMessage as Memory], state, async () => [
        memory,
      ]);

      logger.info('[SPEECH CONVERSATION] Generating speech response');

      const speechResponse = await runtime.useModel(ModelType.TEXT_TO_SPEECH, text);

      // Convert to Buffer if not already a Buffer
      const audioBuffer = Buffer.isBuffer(speechResponse)
        ? speechResponse
        : await new Promise<Buffer>((resolve, reject) => {
            if (!(speechResponse instanceof Readable)) {
              return reject(new Error('Unexpected response type from TEXT_TO_SPEECH model'));
            }

            const chunks: Buffer[] = [];
            speechResponse.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
            speechResponse.on('end', () => resolve(Buffer.concat(chunks)));
            speechResponse.on('error', (err) => reject(err));
          });

      logger.debug('[SPEECH CONVERSATION] Setting response headers');

      res.set({
        'Content-Type': 'audio/mpeg',
        'Transfer-Encoding': 'chunked',
      });

      res.send(Buffer.from(audioBuffer));

      logger.success(
        `[SPEECH CONVERSATION] Successfully processed conversation for: ${runtime.character.name}`
      );
    } catch (error) {
      logger.error('[SPEECH CONVERSATION] Error processing conversation:', error);
      res.status(500).json({
        success: false,
        error: {
          code: 'PROCESSING_ERROR',
          message: 'Error processing conversation',
          details: error.message,
        },
      });
    }
  });

  router.post(
    '/:agentId/transcriptions',
    upload.single('file'),
    async (req: CustomRequest, res) => {
      logger.info('[TRANSCRIPTION] Request to transcribe audio');
      const agentId = validateUuid(req.params.agentId);
      if (!agentId) {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_ID',
            message: 'Invalid agent ID format',
          },
        });
        return;
      }

      const audioFile = req.file;
      if (!audioFile) {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_REQUEST',
            message: 'No audio file provided',
          },
        });
        return;
      }

      const runtime = agents.get(agentId);

      if (!runtime) {
        res.status(404).json({
          success: false,
          error: {
            code: 'NOT_FOUND',
            message: 'Agent not found',
          },
        });
        return;
      }

      try {
        logger.debug('[TRANSCRIPTION] Reading audio file');
        const audioBuffer = fs.readFileSync(audioFile.path);

        logger.info('[TRANSCRIPTION] Transcribing audio');
        const transcription = await runtime.useModel(ModelType.TRANSCRIPTION, audioBuffer);

        // Clean up the temporary file
        fs.unlinkSync(audioFile.path);

        if (!transcription) {
          res.status(500).json({
            success: false,
            error: {
              code: 'PROCESSING_ERROR',
              message: 'Failed to transcribe audio',
            },
          });
          return;
        }

        logger.success('[TRANSCRIPTION] Successfully transcribed audio');
        res.json({
          success: true,
          data: {
            text: transcription,
          },
        });
      } catch (error) {
        logger.error('[TRANSCRIPTION] Error transcribing audio:', error);
        // Clean up the temporary file in case of error
        if (audioFile.path && fs.existsSync(audioFile.path)) {
          fs.unlinkSync(audioFile.path);
        }

        res.status(500).json({
          success: false,
          error: {
            code: 'PROCESSING_ERROR',
            message: 'Error transcribing audio',
            details: error.message,
          },
        });
      }
    }
  );

  // Rooms endpoints
  router.get('/:agentId/rooms', async (req, res) => {
    const agentId = validateUuid(req.params.agentId);
    if (!agentId) {
      res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_ID',
          message: 'Invalid agent ID format',
        },
      });
      return;
    }

    const runtime = agents.get(agentId);

    if (!runtime) {
      res.status(404).json({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: 'Agent not found',
        },
      });
      return;
    }

    try {
      const worldId = req.query.worldId as string;
      const includeDefaultRooms = req.query.includeDefaultRooms === 'true';
      const rooms = await runtime.getRoomsForParticipant(agentId);

      const roomDetails = await Promise.all(
        rooms.map(async (roomId) => {
          try {
            const roomData = await runtime.getRoom(roomId);
            if (!roomData) return null;

            if (worldId && roomData.worldId !== worldId) {
              return null;
            }

            // Skip default agent rooms (direct 1:1 rooms) unless explicitly requested
            if (!includeDefaultRooms && roomData.type === ChannelType.DM && roomId === agentId) {
              return null;
            }

            const entities = await runtime.getEntitiesForRoom(roomId, true);

            return {
              id: roomId,
              name: roomData.name || new Date().toLocaleString(),
              source: roomData.source,
              type: roomData.type,
              worldId: roomData.worldId,
              entities: entities,
            };
          } catch (error) {
            logger.error(`[ROOMS GET] Error getting details for room ${roomId}:`, error);
            return null;
          }
        })
      );

      const validRooms = roomDetails.filter((room) => room !== null);

      res.json({
        success: true,
        data: validRooms,
      });
    } catch (error) {
      logger.error(`[ROOMS GET] Error retrieving rooms for agent ${agentId}:`, error);
      res.status(500).json({
        success: false,
        error: {
          code: 500,
          message: 'Failed to retrieve rooms',
          details: error.message,
        },
      });
    }
  });

  router.post('/:agentId/rooms', async (req, res) => {
    const agentId = validateUuid(req.params.agentId);
    if (!agentId) {
      res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_ID',
          message: 'Invalid agent ID format',
        },
      });
      return;
    }

    const runtime = agents.get(agentId);

    if (!runtime) {
      res.status(404).json({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: 'Agent not found',
        },
      });
      return;
    }

    try {
      const { name, worldId, roomId: requestedRoomId, entityId } = req.body;
      const roomName = name || `Chat ${new Date().toLocaleString()}`;
      const roomType = req.body.type || ChannelType.GROUP; // Default to GROUP for new rooms

      // Generate a room ID if not provided
      const roomId = requestedRoomId || createUniqueUuid(runtime, `room-${Date.now()}`);

      logger.info(`[ROOM CREATE] Creating room with ID ${roomId}`);

      // Validate the room type (only allow DM or GROUP)
      if (roomType !== ChannelType.DM && roomType !== ChannelType.GROUP) {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_CHANNEL_TYPE',
            message: 'Room type must be DM or GROUP',
          },
        });
        return;
      }

      // Ensure the admin user exists
      const ADMIN_ID = '10000000-0000-0000-0000-000000000000';
      try {
        // Check if admin user exists
        try {
          const entity = await runtime.getEntityById(ADMIN_ID as UUID);
          if (!entity) {
            // Create the admin user with a complete entity object
            logger.info(`[ROOM CREATE] Admin user not found, creating it with ID ${ADMIN_ID}`);

            // Create a complete entity object with required fields
            const adminEntity = {
              id: ADMIN_ID as UUID,
              name: 'Admin User',
              agentId: runtime.agentId,
              metadata: {
                websocket: {
                  username: 'admin',
                  name: 'Administrator',
                },
              },
            };

            // Log the entity being created for debugging
            logger.info(`[ROOM CREATE] Creating admin entity: ${JSON.stringify(adminEntity)}`);

            // Create the entity with all required fields
            await runtime.createEntity(adminEntity as any);
            logger.info(`[ROOM CREATE] Admin user created successfully`);
          }
        } catch (error) {
          // Entity doesn't exist, create it with full entity structure
          logger.info(`[ROOM CREATE] Error checking admin user, creating it with ID ${ADMIN_ID}`);

          // Create a complete entity object with all required fields
          const adminEntity = {
            id: ADMIN_ID as UUID,
            name: 'Admin User',
            agentId: runtime.agentId,
            metadata: {
              websocket: {
                username: 'admin',
                name: 'Administrator',
              },
            },
          };

          // Log the entity being created for debugging
          logger.info(`[ROOM CREATE] Creating admin entity: ${JSON.stringify(adminEntity)}`);

          // Ensure all required fields are present
          await runtime.createEntity(adminEntity as any);
          logger.info(`[ROOM CREATE] Admin user created successfully`);
        }
      } catch (adminError) {
        logger.error(`[ROOM CREATE] Failed to ensure admin user exists: ${adminError.message}`);
        res.status(500).json({
          success: false,
          error: {
            code: 'CREATE_ERROR',
            message: 'Failed to ensure admin user exists',
            details: adminError.message,
          },
        });
        return;
      }

      await runtime.ensureRoomExists({
        id: roomId,
        name: roomName,
        source: 'client',
        type: roomType,
        worldId,
      });

      logger.info(`[ROOM CREATE] Room ${roomId} created successfully`);

      // Add the agent to the room
      await runtime.addParticipant(runtime.agentId, roomId);
      logger.info(`[ROOM CREATE] Agent ${runtime.agentId} added to room ${roomId}`);

      // Always add the requesting user (admin) to the room
      await runtime.ensureParticipantInRoom(entityId, roomId);
      await runtime.setParticipantUserState(roomId, entityId, 'FOLLOWED');
      logger.info(`[ROOM CREATE] User ${entityId} added to room ${roomId}`);

      res.status(201).json({
        success: true,
        data: {
          id: roomId,
          name: roomName,
          type: roomType,
          createdAt: Date.now(),
          source: 'client',
          worldId,
        },
      });
    } catch (error) {
      logger.error(`[ROOM CREATE] Error creating room for agent ${agentId}:`, error);
      res.status(500).json({
        success: false,
        error: {
          code: 'CREATE_ERROR',
          message: 'Failed to create room',
          details: error.message,
        },
      });
    }
  });

  // Add participants to a room
  router.post('/:agentId/rooms/:roomId/participants', async (req, res) => {
    const agentId = validateUuid(req.params.agentId);
    const roomId = validateUuid(req.params.roomId);

    if (!agentId || !roomId) {
      res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_ID',
          message: 'Invalid agent ID or room ID format',
        },
      });
      return;
    }

    const runtime = agents.get(agentId);
    if (!runtime) {
      res.status(404).json({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: 'Agent not found',
        },
      });
      return;
    }

    try {
      const { participantId } = req.body;

      if (!participantId) {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_REQUEST',
            message: 'Participant ID is required',
          },
        });
        return;
      }

      // Validate that the room exists
      const room = await runtime.getRoom(roomId);
      if (!room) {
        res.status(404).json({
          success: false,
          error: {
            code: 'NOT_FOUND',
            message: 'Room not found',
          },
        });
        return;
      }

      // Check if the participant exists; if not, create them
      try {
        // Try to get the entity first to check if it exists
        try {
          const entity = await runtime.getEntityById(participantId as UUID);
          if (!entity) {
            // Create the user entity with complete structure
            logger.info(
              `[ROOM PARTICIPANT ADD] Participant ${participantId} not found, creating it`
            );

            // Create complete participant entity with required fields
            const participantEntity = {
              id: participantId as UUID,
              name: 'User',
              agentId: runtime.agentId,
              metadata: {
                websocket: {
                  username: 'user',
                  name: 'User',
                },
              },
            };

            // Log entity creation for debugging
            logger.info(
              `[ROOM PARTICIPANT ADD] Creating participant entity: ${JSON.stringify(participantEntity)}`
            );

            await runtime.createEntity(participantEntity as any);
            logger.info(`[ROOM PARTICIPANT ADD] Participant created successfully`);
          }
        } catch (error) {
          // Entity doesn't exist, create it with complete structure
          logger.info(
            `[ROOM PARTICIPANT ADD] Error checking participant, creating it with ID ${participantId}`
          );

          // Create complete participant entity with required fields
          const participantEntity = {
            id: participantId as UUID,
            name: 'User',
            agentId: runtime.agentId,
            metadata: {
              websocket: {
                username: 'user',
                name: 'User',
              },
            },
          };

          // Log entity creation for debugging
          logger.info(
            `[ROOM PARTICIPANT ADD] Creating participant entity: ${JSON.stringify(participantEntity)}`
          );

          await runtime.createEntity(participantEntity as any);
          logger.info(`[ROOM PARTICIPANT ADD] Participant created successfully`);
        }
      } catch (entityError) {
        logger.error(
          `[ROOM PARTICIPANT ADD] Failed to ensure participant exists: ${entityError.message}`
        );
        res.status(500).json({
          success: false,
          error: {
            code: 'UPDATE_ERROR',
            message: 'Failed to ensure participant exists',
            details: entityError.message,
          },
        });
        return;
      }

      // Add participant to the room
      await runtime.addParticipant(participantId, roomId);
      await runtime.setParticipantUserState(roomId, participantId, 'FOLLOWED');

      res.status(200).json({
        success: true,
        data: {
          message: `Added participant ${participantId} to room ${roomId}`,
        },
      });
    } catch (error) {
      logger.error(`[ROOM PARTICIPANT ADD] Error adding participant to room ${roomId}:`, error);
      res.status(500).json({
        success: false,
        error: {
          code: 'UPDATE_ERROR',
          message: 'Failed to add participant to room',
          details: error.message,
        },
      });
    }
  });

  // Remove participants from a room
  router.delete('/:agentId/rooms/:roomId/participants/:participantId', async (req, res) => {
    const agentId = validateUuid(req.params.agentId);
    const roomId = validateUuid(req.params.roomId);
    const participantId = validateUuid(req.params.participantId);

    if (!agentId || !roomId || !participantId) {
      res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_ID',
          message: 'Invalid ID format',
        },
      });
      return;
    }

    const runtime = agents.get(agentId);
    if (!runtime) {
      res.status(404).json({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: 'Agent not found',
        },
      });
      return;
    }

    try {
      // Get the user/admin's entityId from query params or headers
      const adminEntityId =
        (req.query.adminEntityId as string) || (req.headers['x-entity-id'] as string);

      // Validate room exists
      const room = await runtime.getRoom(roomId);
      if (!room) {
        res.status(404).json({
          success: false,
          error: {
            code: 'NOT_FOUND',
            message: 'Room not found',
          },
        });
        return;
      }

      // Don't allow removing the admin (current user) from the room
      if (participantId === adminEntityId) {
        res.status(403).json({
          success: false,
          error: {
            code: 'FORBIDDEN',
            message: 'You cannot remove yourself from the room',
          },
        });
        return;
      }

      // Remove participant from the room
      await runtime.removeParticipant(participantId, roomId);

      res.status(200).json({
        success: true,
        data: {
          message: `Removed participant ${participantId} from room ${roomId}`,
        },
      });
    } catch (error) {
      logger.error(
        `[ROOM PARTICIPANT REMOVE] Error removing participant from room ${roomId}:`,
        error
      );
      res.status(500).json({
        success: false,
        error: {
          code: 'UPDATE_ERROR',
          message: 'Failed to remove participant from room',
          details: error.message,
        },
      });
    }
  });

  // Get room participants
  router.get('/:agentId/rooms/:roomId/participants', async (req, res) => {
    const agentId = validateUuid(req.params.agentId);
    const roomId = validateUuid(req.params.roomId);

    if (!agentId || !roomId) {
      res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_ID',
          message: 'Invalid agent ID or room ID format',
        },
      });
      return;
    }

    const runtime = agents.get(agentId);
    if (!runtime) {
      res.status(404).json({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: 'Agent not found',
        },
      });
      return;
    }

    try {
      // Validate room exists
      const room = await runtime.getRoom(roomId);
      if (!room) {
        res.status(404).json({
          success: false,
          error: {
            code: 'NOT_FOUND',
            message: 'Room not found',
          },
        });
        return;
      }

      // Get all participants for this room
      const participants = await runtime.getEntitiesForRoom(roomId, true);

      res.status(200).json({
        success: true,
        data: participants,
      });
    } catch (error) {
      logger.error(`[ROOM PARTICIPANTS GET] Error getting participants for room ${roomId}:`, error);
      res.status(500).json({
        success: false,
        error: {
          code: 'RETRIEVAL_ERROR',
          message: 'Failed to get room participants',
          details: error.message,
        },
      });
    }
  });

  router.get('/:agentId/rooms/:roomId', async (req, res) => {
    const agentId = validateUuid(req.params.agentId);
    if (!agentId) {
      res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_ID',
          message: 'Invalid agent ID format',
        },
      });
      return;
    }

    const runtime = agents.get(agentId);

    const roomId = validateUuid(req.params.roomId);

    if (!agentId || !roomId) {
      res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_ID',
          message: 'Invalid agent ID or room ID format',
        },
      });
      return;
    }

    try {
      const room = await runtime.getRoom(roomId);
      if (!room) {
        res.status(404).json({
          success: false,
          error: {
            code: 'NOT_FOUND',
            message: 'Room not found',
          },
        });
        return;
      }

      const entities = await runtime.getEntitiesForRoom(roomId, true);

      res.json({
        success: true,
        data: {
          id: roomId,
          name: room.name,
          source: room.source,
          type: room.type,
          worldId: room.worldId,
          entities: entities,
        },
      });
    } catch (error) {
      logger.error(`[ROOM GET] Error retrieving room ${roomId}:`, error);
      res.status(500).json({
        success: false,
        error: {
          code: 500,
          message: 'Failed to retrieve room',
          details: error.message,
        },
      });
    }
  });

  router.patch('/:agentId/rooms/:roomId', async (req, res) => {
    const agentId = validateUuid(req.params.agentId);
    if (!agentId) {
      res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_ID',
          message: 'Invalid agent ID format',
        },
      });
      return;
    }

    const runtime = agents.get(agentId);

    const roomId = validateUuid(req.params.roomId);

    if (!agentId || !roomId) {
      res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_ID',
          message: 'Invalid agent ID or room ID format',
        },
      });
      return;
    }

    try {
      const room = await runtime.getRoom(roomId);
      if (!room) {
        res.status(404).json({
          success: false,
          error: {
            code: 'NOT_FOUND',
            message: 'Room not found',
          },
        });
        return;
      }

      const updates = req.body;

      // Validate room type if being updated
      if (updates.type && updates.type !== ChannelType.DM && updates.type !== ChannelType.GROUP) {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_CHANNEL_TYPE',
            message: 'Room type must be DM or GROUP',
          },
        });
        return;
      }

      await runtime.updateRoom({ ...updates, roomId });

      const updatedRoom = await runtime.getRoom(roomId);
      res.json({
        success: true,
        data: updatedRoom,
      });
    } catch (error) {
      logger.error(`[ROOM UPDATE] Error updating room ${roomId}:`, error);
      res.status(500).json({
        success: false,
        error: {
          code: 'UPDATE_ERROR',
          message: 'Failed to update room',
          details: error.message,
        },
      });
    }
  });

  router.delete('/:agentId/rooms/:roomId', async (req, res) => {
    const agentId = validateUuid(req.params.agentId);
    if (!agentId) {
      res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_ID',
          message: 'Invalid agent ID format',
        },
      });
      return;
    }

    const runtime = agents.get(agentId);

    const roomId = validateUuid(req.params.roomId);

    if (!agentId || !roomId) {
      res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_ID',
          message: 'Invalid agent ID or room ID format',
        },
      });
      return;
    }

    try {
      // Don't allow deleting default rooms (when roomId === agentId)
      if (roomId === agentId) {
        res.status(403).json({
          success: false,
          error: {
            code: 'FORBIDDEN',
            message: 'Cannot delete default agent room',
          },
        });
        return;
      }

      await runtime.deleteRoom(roomId);
      res.status(204).send();
    } catch (error) {
      logger.error(`[ROOM DELETE] Error deleting room ${roomId}:`, error);
      res.status(500).json({
        success: false,
        error: {
          code: 'DELETE_ERROR',
          message: 'Failed to delete room',
          details: error.message,
        },
      });
    }
  });

  // Get memories for a specific room
  router.get('/:agentId/rooms/:roomId/memories', async (req, res) => {
    const agentId = validateUuid(req.params.agentId);
    const roomId = validateUuid(req.params.roomId);

    if (!agentId || !roomId) {
      res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_ID',
          message: 'Invalid agent ID or room ID format',
        },
      });
      return;
    }

    const runtime = agents.get(agentId);

    if (!runtime) {
      res.status(404).json({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: 'Agent not found',
        },
      });
      return;
    }

    try {
      const limit = req.query.limit ? Number.parseInt(req.query.limit as string, 10) : 20;
      const before = req.query.before
        ? Number.parseInt(req.query.before as string, 10)
        : Date.now();
      const _worldId = req.query.worldId as string;

      const memories = await runtime.getMemories({
        tableName: 'messages',
        roomId,
        count: limit,
        end: before,
      });

      res.json({
        success: true,
        data: {
          memories,
        },
      });
    } catch (error) {
      logger.error('[MEMORIES GET] Error retrieving memories for room:', error);
      res.status(500).json({
        success: false,
        error: {
          code: 500,
          message: 'Failed to retrieve memories',
          details: error.message,
        },
      });
    }
  });

  router.post('/:agentId/message', async (req: CustomRequest, res) => {
    logger.info('[MESSAGES CREATE] Creating new message');
    const agentId = validateUuid(req.params.agentId);
    if (!agentId) {
      res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_ID',
          message: 'Invalid agent ID format',
        },
      });
      return;
    }

    // get runtime
    const runtime = agents.get(agentId);
    if (!runtime) {
      res.status(404).json({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: 'Agent not found',
        },
      });
      return;
    }

    const entityId = createUniqueUuid(runtime, req.body.senderId);
    const roomId = createUniqueUuid(runtime, req.body.roomId);

    const source = req.body.source;
    const text = req.body.text.trim();

    try {
      // Get the room to determine channel type
      const room = await runtime.getRoom(roomId);
      const channelType = room?.type || ChannelType.DM; // Default to DM if room not found

      const messageId = createUniqueUuid(runtime, Date.now().toString());

      const content: Content = {
        text,
        attachments: [],
        source,
        inReplyTo: undefined,
        channelType: channelType, // Use the room's channel type
      };

      const userMessage = {
        content,
        entityId,
        roomId,
        agentId: runtime.agentId,
      };

      const memory: Memory = {
        id: createUniqueUuid(runtime, messageId),
        ...userMessage,
        agentId: runtime.agentId,
        entityId,
        roomId,
        content,
        createdAt: Date.now(),
      };

      // save message
      await runtime.createMemory(memory, 'messages');

      console.log('*** memory', memory);

      let state = await runtime.composeState(memory);

      console.log('*** state', state);

      const prompt = composePromptFromState({
        state,
        template: messageHandlerTemplate,
      });

      console.log('*** prompt', prompt);

      const response = await runtime.useModel(ModelType.OBJECT_LARGE, {
        prompt,
      });

      console.log('*** response', response);

      if (!response) {
        res.status(500).json({
          success: false,
          error: {
            code: 'MODEL_ERROR',
            message: 'No response from model',
          },
        });
        return;
      }

      const responseMessage: Memory = {
        id: createUniqueUuid(runtime, messageId),
        ...userMessage,
        entityId: runtime.agentId,
        content: response,
        createdAt: Date.now(),
      };

      state = await runtime.composeState(responseMessage, ['RECENT_MESSAGES']);

      const replyHandler = async (message: Content) => {
        res.status(201).json({
          success: true,
          data: {
            message,
            messageId,
            name: runtime.character.name,
            roomId: req.body.roomId,
            source,
          },
        });
        return [memory];
      };

      await runtime.processActions(memory, [responseMessage], state, replyHandler);

      await runtime.evaluate(memory, state);

      if (!res.headersSent) {
        res.status(202).json();
      }
    } catch (error) {
      logger.error('Error processing message:', error.message);
      res.status(500).json({
        success: false,
        error: {
          code: 'PROCESSING_ERROR',
          message: 'Error processing message',
          details: error.message,
        },
      });
    }
  });

  return router;
}
