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
  MemoryType,
} from '@elizaos/core';
import express from 'express';
import fs from 'node:fs';
import { Readable } from 'node:stream';
import type { AgentServer } from '..';
import { upload } from '../loader';

/**
 * Interface representing a custom request object that extends the express.Request interface.
 * @interface CustomRequest
 * @extends express.Request
 * @property {Express.Multer.File} [file] - Optional property representing a file uploaded with the request
 * @property {Express.Multer.File[]} [files] - Optional property representing multiple files uploaded with the request
 * @property {Object} params - Object representing parameters included in the request
 * @property {string} params.agentId - The unique identifier for the agent associated with the request
 * @property {string} [params.knowledgeId] - Optional knowledge ID parameter
 */
interface CustomRequest extends express.Request {
  file?: Express.Multer.File;
  files?: Express.Multer.File[];
  params: {
    agentId: string;
    knowledgeId?: string;
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
        logger.debug('[AGENT GET] Agent not found');
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
    logger.debug('[AGENT CREATE] Creating new agent');
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
      logger.debug('[AGENT STOP] Invalid agent ID format');
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
        logger.debug('[AGENT START] Agent not found');
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
        logger.debug(`[AGENT START] Agent ${agentId} is already running`);
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

      logger.debug(`[AGENT START] Successfully started agent: ${agent.name}`);
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
      await db.deleteAgent(agentId);

      const runtime = agents.get(agentId);

      // if agent is running, stop it
      if (runtime) {
        server?.unregisterAgent(agentId);
      }
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

  // Delete Memory
  router.delete('/:agentId/memories/:memoryId', async (req, res) => {
    const agentId = validateUuid(req.params.agentId);
    const memoryId = validateUuid(req.params.memoryId);

    if (!agentId || !memoryId) {
      res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_ID',
          message: 'Invalid agent ID or memory ID format',
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

    await runtime.deleteMemory(memoryId);

    res.status(204).send();
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
      logger.debug('[AUDIO MESSAGE] Processing audio message');
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
    logger.debug('[SPEECH GENERATE] Request to generate speech from text');
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
      logger.debug('[SPEECH GENERATE] Using text-to-speech model');
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

      logger.debug('[SPEECH CONVERSATION] Using LLM for response');
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

      logger.debug('[SPEECH CONVERSATION] Generating speech response');

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
      logger.debug('[TRANSCRIPTION] Request to transcribe audio');
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

        logger.debug('[TRANSCRIPTION] Transcribing audio');
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
      const rooms = await runtime.getRoomsForParticipant(agentId);

      const roomDetails = await Promise.all(
        rooms.map(async (roomId) => {
          try {
            const roomData = await runtime.getRoom(roomId);
            if (!roomData) return null;

            if (worldId && roomData.worldId !== worldId) {
              return null;
            }

            const entities = await runtime.getEntitiesForRoom(roomId, true);

            return {
              id: roomId,
              name: roomData.name || new Date().toLocaleString(),
              source: roomData.source,
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
      const { name, worldId, source, metadata, serverId } = req.body;
      const roomId = createUniqueUuid(runtime, serverId);
      const roomName = name || `Chat ${new Date().toLocaleString()}`;

      await runtime.ensureRoomExists({
        id: roomId,
        name: roomName,
        source,
        type: ChannelType.API,
        worldId,
        serverId,
        metadata,
      });

      await runtime.addParticipant(runtime.agentId, roomId);
      await runtime.ensureParticipantInRoom(runtime.agentId, roomId);
      await runtime.setParticipantUserState(roomId, runtime.agentId, 'FOLLOWED');

      res.status(201).json({
        success: true,
        data: {
          id: roomId,
          name: roomName,
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

      const cleanMemories = memories.map((memory) => {
        return {
          ...memory,
          embedding: undefined,
        };
      });

      res.json({
        success: true,
        data: {
          memories: cleanMemories,
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

  // get all memories for an agent
  router.get('/:agentId/memories', async (req, res) => {
    const agentId = validateUuid(req.params.agentId);

    if (!agentId) {
      res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_ID',
          message: 'Invalid agent ID',
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

    // Get tableName from query params, default to "messages"
    const tableName = (req.query.tableName as string) || 'messages';

    const memories = await runtime.getMemories({
      agentId,
      tableName,
    });

    const cleanMemories = memories.map((memory) => {
      return {
        ...memory,
        embedding: undefined,
      };
    });

    res.json({
      success: true,
      data: cleanMemories,
    });
  });

  // update a specific memory for an agent
  router.patch('/:agentId/memories/:memoryId', async (req, res) => {
    const agentId = validateUuid(req.params.agentId);
    const memoryId = validateUuid(req.params.memoryId);

    const memory = req.body;

    if (!agentId || !memoryId) {
      res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_ID',
          message: 'Invalid agent ID or memory ID format',
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
      // Ensure memory has the correct ID from the path
      const memoryToUpdate = {
        ...memory,
        id: memoryId,
      };

      await runtime.updateMemory(memoryToUpdate);

      logger.success(`[MEMORY UPDATE] Successfully updated memory ${memoryId}`);
      res.json({
        success: true,
        data: {
          id: memoryId,
          message: 'Memory updated successfully',
        },
      });
    } catch (error) {
      logger.error(`[MEMORY UPDATE] Error updating memory ${memoryId}:`, error);
      res.status(500).json({
        success: false,
        error: {
          code: 'UPDATE_ERROR',
          message: 'Failed to update memory',
          details: error.message,
        },
      });
    }
  });

  router.post('/:agentId/message', async (req: CustomRequest, res) => {
    logger.debug('[MESSAGES CREATE] Creating new message');
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
      const messageId = createUniqueUuid(runtime, Date.now().toString());

      const content: Content = {
        text,
        attachments: [],
        source,
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

      let state = await runtime.composeState(memory);

      const prompt = composePromptFromState({
        state,
        template: messageHandlerTemplate,
      });

      const response = await runtime.useModel(ModelType.OBJECT_LARGE, {
        prompt,
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

  // Knowledge management routes
  router.post('/:agentId/memories/upload-knowledge', upload.array('files'), async (req, res) => {
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

    const files = req.files as Express.Multer.File[];

    if (!files || files.length === 0) {
      res.status(400).json({
        success: false,
        error: {
          code: 'NO_FILES',
          message: 'No files uploaded',
        },
      });
      return;
    }

    try {
      const results = [];

      for (const file of files) {
        try {
          // Read file content
          const content = fs.readFileSync(file.path, 'utf8');

          // Format the content with Path: prefix like in the devRel/index.ts example
          const relativePath = file.originalname;
          const formattedContent = `Path: ${relativePath}\n\n${content}`;

          // Create knowledge item with proper metadata
          const knowledgeId = createUniqueUuid(runtime, `knowledge-${Date.now()}`);
          const fileExt = file.originalname.split('.').pop()?.toLowerCase() || '';
          const filename = file.originalname;
          const title = filename.replace(`.${fileExt}`, '');

          const knowledgeItem = {
            id: knowledgeId,
            content: {
              text: formattedContent,
            },
            metadata: {
              type: MemoryType.DOCUMENT,
              timestamp: Date.now(),
              filename: filename,
              fileExt: fileExt,
              title: title,
              path: relativePath,
              fileType: file.mimetype,
              fileSize: file.size,
              source: 'upload',
            },
          };

          // Add knowledge to agent
          await runtime.addKnowledge(knowledgeItem, {
            targetTokens: 3000,
            overlap: 200,
            modelContextSize: 4096,
          });

          // Clean up temp file immediately after successful processing
          if (file.path && fs.existsSync(file.path)) {
            fs.unlinkSync(file.path);
          }

          results.push({
            id: knowledgeId,
            filename: relativePath,
            type: file.mimetype,
            size: file.size,
            uploadedAt: Date.now(),
            preview:
              formattedContent.length > 0
                ? `${formattedContent.substring(0, 150)}${formattedContent.length > 150 ? '...' : ''}`
                : 'No preview available',
          });
        } catch (fileError) {
          logger.error(`[KNOWLEDGE POST] Error processing file ${file.originalname}: ${fileError}`);
          // Clean up this file if it exists
          if (file.path && fs.existsSync(file.path)) {
            fs.unlinkSync(file.path);
          }
          // Continue with other files even if one fails
        }
      }

      res.json({
        success: true,
        data: results,
      });
    } catch (error) {
      logger.error(`[KNOWLEDGE POST] Error uploading knowledge: ${error}`);

      // Clean up any remaining files
      if (files) {
        for (const file of files) {
          if (file.path && fs.existsSync(file.path)) {
            try {
              fs.unlinkSync(file.path);
            } catch (cleanupError) {
              logger.error(
                `[KNOWLEDGE POST] Error cleaning up file ${file.originalname}: ${cleanupError}`
              );
            }
          }
        }
      }

      res.status(500).json({
        success: false,
        error: {
          code: 500,
          message: 'Failed to upload knowledge',
          details: error.message,
        },
      });
    }
  });

  return router;
}
