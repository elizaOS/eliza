import type { AgentServer } from '@/src/server';
import { upload } from '@/src/server/loader';
import { convertToAudioBuffer } from '@/src/utils';
import type {
  Agent,
  Character,
  Content,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  UUID,
} from '@elizaos/core';
import {
  ChannelType,
  EventType,
  MemoryType,
  ModelType,
  composePrompt,
  createUniqueUuid,
  encryptObjectValues,
  encryptStringValue,
  getSalt,
  logger,
  messageHandlerTemplate,
  validateUuid,
  convertPdfToText,
} from '@elizaos/core';
import express from 'express';
import fs from 'node:fs';

// Utility functions for response handling
const sendError = (
  res: express.Response,
  status: number,
  code: string,
  message: string,
  details?: string
) => {
  res.status(status).json({
    success: false,
    error: {
      code,
      message,
      ...(details && { details }),
    },
  });
};

const sendSuccess = (res: express.Response, data: any, status = 200) => {
  res.status(status).json({
    success: true,
    data,
  });
};

const cleanupFile = (filePath: string) => {
  if (filePath && fs.existsSync(filePath)) {
    try {
      fs.unlinkSync(filePath);
    } catch (error) {
      logger.error(`Error cleaning up file ${filePath}:`, error);
    }
  }
};

const cleanupFiles = (files: Express.Multer.File[]) => {
  if (files) {
    files.forEach((file) => cleanupFile(file.path));
  }
};

const getRuntime = (agents: Map<UUID, IAgentRuntime>, agentId: UUID) => {
  const runtime = agents.get(agentId);
  if (!runtime) {
    throw new Error('Agent not found');
  }
  return runtime;
};

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
 * Creates and configures an Express router for managing agents and their related resources.
 *
 * The returned router provides RESTful endpoints for agent lifecycle management (creation, update, start, stop, deletion), memory and log operations, audio processing (transcription and speech synthesis), message handling, knowledge uploads, and group chat management. It integrates with agent runtimes and optionally an {@link AgentServer} instance for database operations.
 *
 * @param agents - Map of agent UUIDs to their runtime instances.
 * @param server - Optional server instance providing database and agent management utilities.
 * @returns An Express router with agent-related routes.
 */
export function agentRouter(
  agents: Map<UUID, IAgentRuntime>,
  server?: AgentServer
): express.Router {
  const router = express.Router();
  const db = server?.database;

  // Get all worlds
  router.get('/worlds', async (req, res) => {
    try {
      // Find any active runtime to use for getting worlds
      const runtime = Array.from(agents.values())[0];

      if (!runtime) {
        sendError(res, 404, 'NOT_FOUND', 'No active agents found to get worlds');
        return;
      }

      const worlds = await runtime.getAllWorlds();

      sendSuccess(res, { worlds });
    } catch (error) {
      logger.error('[WORLDS LIST] Error retrieving worlds:', error);
      sendError(res, 500, '500', 'Error retrieving worlds', error.message);
    }
  });

  // Helper function to create a world
  const createWorldHelper = async (
    runtime: IAgentRuntime,
    req: express.Request,
    res: express.Response
  ) => {
    try {
      const { name, serverId, metadata } = req.body;

      if (!name) {
        sendError(res, 400, 'BAD_REQUEST', 'World name is required');
        return;
      }

      // Generate a unique ID for the world
      const worldId = createUniqueUuid(runtime, `world-${Date.now()}`);

      await runtime.createWorld({
        id: worldId,
        name,
        agentId: runtime.agentId,
        serverId: serverId || `server-${Date.now()}`,
        metadata,
      });

      const world = (await runtime.getAllWorlds()).find((w) => w.id === worldId);

      sendSuccess(res, { world }, 201);
    } catch (error) {
      logger.error('[WORLD CREATE] Error creating world:', error);
      sendError(res, 500, '500', 'Error creating world', error.message);
    }
  };

  // Create new world for specific agent
  router.post('/:agentId/worlds', async (req, res) => {
    const agentId = validateUuid(req.params.agentId);
    if (!agentId) {
      sendError(res, 400, 'INVALID_ID', 'Invalid agent ID format');
      return;
    }

    // get runtime
    const runtime = agents.get(agentId);
    if (!runtime) {
      sendError(res, 404, 'NOT_FOUND', 'Agent not found');
      return;
    }

    await createWorldHelper(runtime, req, res);
  });

  // Update world properties
  router.patch('/:agentId/worlds/:worldId', async (req, res) => {
    const agentId = validateUuid(req.params.agentId);
    const worldId = validateUuid(req.params.worldId);

    if (!agentId || !worldId) {
      sendError(res, 400, 'INVALID_ID', 'Invalid agent ID or world ID format');
      return;
    }

    // get runtime
    const runtime = agents.get(agentId);
    if (!runtime) {
      sendError(res, 404, 'NOT_FOUND', 'Agent not found');
      return;
    }

    try {
      // Get existing world
      const world = (await runtime.getAllWorlds()).find((w) => w.id === worldId);

      if (!world) {
        sendError(res, 404, 'NOT_FOUND', 'World not found');
        return;
      }

      const { name, metadata } = req.body;

      // Merge updates with existing world data
      const updatedWorld = {
        ...world,
        name: name !== undefined ? name : world.name,
        metadata:
          metadata !== undefined
            ? world.metadata
              ? { ...world.metadata, ...metadata }
              : metadata
            : world.metadata,
      };

      // Update the world
      await runtime.updateWorld(updatedWorld);

      // Get the updated world to return
      const refreshedWorld = (await runtime.getAllWorlds()).find((w) => w.id === worldId);

      sendSuccess(res, { world: refreshedWorld });
    } catch (error) {
      logger.error('[WORLD UPDATE] Error updating world:', error);
      sendError(res, 500, '500', 'Error updating world', error.message);
    }
  });

  // Message handler
  const handleAgentMessage = async (req: CustomRequest, res: express.Response) => {
    logger.debug('[MESSAGES CREATE] Creating new message');
    const agentId = validateUuid(req.params.agentId);
    if (!agentId) {
      sendError(res, 400, 'INVALID_ID', 'Invalid agent ID format');
      return;
    }

    // get runtime
    const runtime = agents.get(agentId);
    if (!runtime) {
      sendError(res, 404, 'NOT_FOUND', 'Agent not found');
      return;
    }

    const entityId = req.body.entityId as UUID;
    const roomId = req.body.roomId as UUID;
    const worldId = (validateUuid(req.query.worldId as string) ||
      ('00000000-0000-0000-0000-000000000000' as UUID)) as UUID;

    const source = req.body.source;
    const text = req.body.text.trim();

    const channelType = req.body.channelType;
    const incomingMessageVirtualId = createUniqueUuid(
      runtime,
      `${roomId}-${entityId}-${Date.now()}`
    );

    try {
      await runtime.ensureConnection({
        entityId,
        roomId,
        userName: req.body.userName,
        name: req.body.name,
        source: 'api-message',
        type: ChannelType.API,
        worldId,
        worldName: 'api-message',
      });

      const content: Content = {
        text,
        attachments: [],
        source,
        inReplyTo: undefined, // Handled by response memory if needed
        channelType: channelType || ChannelType.API,
      };

      const userMessageMemory: Memory = {
        id: incomingMessageVirtualId, // Use a consistent ID for the incoming message
        entityId,
        roomId,
        worldId,
        agentId: runtime.agentId, // The agent this message is directed to
        content,
        createdAt: Date.now(),
      };

      // Define the callback for sending the HTTP response
      const apiCallback: HandlerCallback = async (responseContent: Content) => {
        let sentMemory: Memory | null = null;
        if (!res.headersSent) {
          res.status(201).json({
            success: true,
            data: {
              message: responseContent,
              messageId: userMessageMemory.id,
              name: runtime.character.name,
              roomId: req.body.roomId,
              source,
            },
          });

          // Construct Memory for the agent's HTTP response
          sentMemory = {
            id: createUniqueUuid(runtime, `api-response-${userMessageMemory.id}-${Date.now()}`),
            entityId: runtime.agentId, // Agent is the sender
            agentId: runtime.agentId,
            content: {
              ...responseContent,
              text: responseContent.text || '',
              inReplyTo: userMessageMemory.id,
            },
            roomId: roomId,
            worldId,
            createdAt: Date.now(),
          };

          await runtime.createMemory(sentMemory, 'messages');
        }
        return sentMemory ? [sentMemory] : [];
      };

      // Emit event for message processing
      await runtime.emitEvent(EventType.MESSAGE_RECEIVED, {
        runtime,
        message: userMessageMemory,
        callback: apiCallback,
        onComplete: () => {
          if (!res.headersSent) {
            logger.warn(
              '[MESSAGES CREATE] API Callback was not called by a handler. Responding with 204 No Content.'
            );
            res.status(204).send(); // Send 204 No Content
          }
        },
      });
    } catch (error) {
      logger.error('Error processing message:', error.message);
      if (!res.headersSent) {
        sendError(res, 500, 'PROCESSING_ERROR', 'Error processing message', error.message);
      }
    }
  };

  // List all agents with minimal details
  router.get('/', async (_, res) => {
    try {
      const allAgents = await db.getAgents();
      const runtimes = Array.from(agents.keys());

      // Return only minimal agent data
      const response = allAgents
        .map((agent: Agent) => ({
          id: agent.id,
          name: agent.name,
          bio: agent.bio[0] ?? '',
          status: runtimes.includes(agent.id) ? 'active' : 'inactive',
        }))
        .sort((a: any, b: any) => {
          if (a.status === b.status) {
            return a.name.localeCompare(b.name);
          }
          return a.status === 'active' ? -1 : 1;
        });

      sendSuccess(res, { agents: response });
    } catch (error) {
      logger.error('[AGENTS LIST] Error retrieving agents:', error);
      sendError(res, 500, '500', 'Error retrieving agents', error.message);
    }
  });

  router.all('/:agentId/plugins/:pluginName/*', async (req, res, next) => {
    const agentId = req.params.agentId as UUID;
    if (!agentId) {
      logger.debug('[AGENT PLUGINS MIDDLEWARE] Params required');
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
      let runtime: IAgentRuntime | undefined;
      if (validateUuid(agentId)) {
        runtime = agents.get(agentId);
      }
      // if runtime is null, look for runtime with the same name
      if (!runtime) {
        runtime = Array.from(agents.values()).find((r) => r.character.name === agentId);
      }
      if (!runtime) {
        logger.debug('[AGENT PLUGINS MIDDLEWARE] Agent not found');
        res.status(404).json({
          success: false,
          error: {
            code: 'NOT_FOUND',
            message: 'Agent not found',
          },
        });
        return;
      }
      // short circuit
      if (!runtime.plugins?.length) next();

      let path = req.path.substr(1 + agentId.length + 9 + req.params.pluginName.length);

      // Check each plugin
      for (const plugin of runtime.plugins) {
        if (!plugin.name) continue;
        if (plugin.routes && plugin.name === req.params.pluginName) {
          for (const r of plugin.routes) {
            if (r.type === req.method) {
              // r.path can contain /*
              if (r.path.match(/\*/)) {
                // hacky af
                if (path.match(r.path.replace('*', ''))) {
                  r.handler(req, res, runtime);
                  return;
                }
              } else {
                if (path === r.path) {
                  r.handler(req, res, runtime);
                  return;
                }
              }
            }
          }
        }
      }
      next();
    } catch (error) {
      logger.error('[AGENT PLUGINS MIDDLEWARE] Error agent middleware:', error);
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

  // Get specific agent details
  router.get('/:agentId', async (req, res) => {
    const agentId = validateUuid(req.params.agentId);

    try {
      const agent = await db.getAgent(agentId);
      if (!agent) {
        sendError(res, 404, 'NOT_FOUND', 'Agent not found');
        return;
      }

      const runtime = agents.get(agentId);
      const response = {
        ...agent,
        status: runtime ? 'active' : 'inactive',
      };

      sendSuccess(res, response);
    } catch (error) {
      logger.error('[AGENT GET] Error retrieving agent:', error);
      sendError(res, 500, '500', 'Error retrieving agent', error.message);
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

      // Encrypt secrets if they exist in the character
      if (character.settings?.secrets) {
        logger.debug('[AGENT CREATE] Encrypting secrets');
        const salt = getSalt();
        character.settings.secrets = encryptObjectValues(character.settings.secrets, salt);
      }

      const createdAgent = await db.ensureAgentExists(character);

      res.status(201).json({
        success: true,
        data: {
          id: createdAgent.id,
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
      // Handle encryption of secrets if present in updates
      if (updates.settings?.secrets) {
        const salt = getSalt();
        const encryptedSecrets: Record<string, string> = {};

        // Encrypt each secret value
        // We need to handle null values separately
        // because they mean delete the secret
        Object.entries(updates.settings.secrets).forEach(([key, value]) => {
          if (value === null) {
            // Null means delete the secret
            encryptedSecrets[key] = null;
          } else if (typeof value === 'string') {
            // Only encrypt string values
            encryptedSecrets[key] = encryptStringValue(value, salt);
          } else {
            // Leave other types as is
            encryptedSecrets[key] = value as string;
          }
        });

        // Replace with encrypted secrets
        updates.settings.secrets = encryptedSecrets;
      }

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

    // Log success
    logger.debug(`[AGENT STOP] Successfully stopped agent: ${runtime.character.name} (${agentId})`);

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
    logger.debug(`[AGENT DELETE] Received request to delete agent with ID: ${req.params.agentId}`);

    const agentId = validateUuid(req.params.agentId);
    if (!agentId) {
      logger.error(`[AGENT DELETE] Invalid agent ID format: ${req.params.agentId}`);
      res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_ID',
          message: 'Invalid agent ID format',
        },
      });
      return;
    }

    logger.debug(`[AGENT DELETE] Validated agent ID: ${agentId}, proceeding with deletion`);

    // First, check if agent exists
    try {
      const agent = await db.getAgent(agentId);
      if (!agent) {
        logger.warn(`[AGENT DELETE] Agent not found: ${agentId}`);
        res.status(404).json({
          success: false,
          error: {
            code: 'NOT_FOUND',
            message: 'Agent not found',
          },
        });
        return;
      }

      logger.debug(`[AGENT DELETE] Agent found: ${agent.name} (${agentId})`);
    } catch (checkError) {
      logger.error(`[AGENT DELETE] Error checking if agent exists: ${agentId}`, checkError);
      // Continue with deletion attempt anyway
    }

    // Set a timeout to send a response if the operation takes too long
    const timeoutId = setTimeout(() => {
      logger.warn(`[AGENT DELETE] Operation taking longer than expected for agent: ${agentId}`);
      res.status(202).json({
        success: true,
        partial: true,
        message:
          'Agent deletion initiated but taking longer than expected. The operation will continue in the background.',
      });
    }, 10000);

    const MAX_RETRIES = 2;
    let retryCount = 0;
    let lastError = null;

    // Retry loop for database operations
    while (retryCount <= MAX_RETRIES) {
      try {
        // First, if the agent is running, stop it immediately to prevent ongoing operations
        const runtime = agents.get(agentId);
        if (runtime) {
          logger.debug(`[AGENT DELETE] Agent ${agentId} is running, unregistering from server`);
          try {
            server?.unregisterAgent(agentId);
            logger.debug(`[AGENT DELETE] Agent ${agentId} unregistered successfully`);
          } catch (stopError) {
            logger.error(`[AGENT DELETE] Error stopping agent ${agentId}:`, stopError);
            // Continue with deletion even if stopping fails
          }
        } else {
          logger.debug(`[AGENT DELETE] Agent ${agentId} was not running, no need to unregister`);
        }

        logger.debug(`[AGENT DELETE] Calling database deleteAgent method for agent: ${agentId}`);

        // Perform the deletion operation
        const deleteResult = await db.deleteAgent(agentId);
        logger.debug(`[AGENT DELETE] Database deleteAgent result: ${JSON.stringify(deleteResult)}`);

        // Clear the response timeout since we completed before it triggered
        clearTimeout(timeoutId);

        logger.success(`[AGENT DELETE] Successfully deleted agent: ${agentId}`);

        // Only send response if one hasn't been sent already
        if (!res.headersSent) {
          res.status(204).send();
        }

        // Successfully deleted, break out of retry loop
        return;
      } catch (error) {
        lastError = error;
        retryCount++;

        logger.error(
          `[AGENT DELETE] Error deleting agent ${agentId} (attempt ${retryCount}/${MAX_RETRIES + 1}):`,
          error
        );

        // If we've reached max retries, break out of the loop
        if (retryCount > MAX_RETRIES) {
          break;
        }

        // Wait a bit before retrying
        const delay = 1000 * Math.pow(2, retryCount - 1); // Exponential backoff
        logger.debug(`[AGENT DELETE] Waiting ${delay}ms before retry ${retryCount}`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    // Clear the response timeout
    clearTimeout(timeoutId);

    // If we reach here, all retries failed
    // Check if headers have already been sent (from the timeout handler)
    if (!res.headersSent) {
      let statusCode = 500;
      let errorMessage = 'Error deleting agent';

      // Special handling for different error types
      if (lastError instanceof Error) {
        const message = lastError.message;

        if (message.includes('foreign key constraint')) {
          errorMessage = 'Cannot delete agent because it has active references in the system';
          statusCode = 409; // Conflict
        } else if (message.includes('timed out')) {
          errorMessage = 'Agent deletion operation timed out';
          statusCode = 408; // Request Timeout
        }
      }

      res.status(statusCode).json({
        success: false,
        error: {
          code: 'DELETE_ERROR',
          message: errorMessage,
          details: lastError instanceof Error ? lastError.message : String(lastError),
        },
      });
    }
  });

  router.delete('/:agentId/memories/all/:roomId/', async (req, res) => {
    try {
      const agentId = validateUuid(req.params.agentId);
      const roomId = validateUuid(req.params.roomId);

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

      if (!roomId) {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_ID',
            message: 'Invalid room ID',
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

      await runtime.deleteAllMemories(roomId, 'messages');
      await runtime.deleteAllMemories(roomId, 'knowledge');
      await runtime.deleteAllMemories(roomId, 'documents');

      res.status(204).send();
    } catch (e) {
      logger.error('[DELETE ALL MEMORIES] Error deleting all memories:', e);
      res.status(500).json({
        success: false,
        error: {
          code: 'DELETE_ERROR',
          message: 'Error deleting all memories',
          details: e instanceof Error ? e.message : String(e),
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

  // Get Agent Panels (public GET routes)
  router.get('/:agentId/panels', async (req, res) => {
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
      const publicPanels = runtime.routes
        .filter((route) => route.public === true && route.type === 'GET' && route.name)
        .map((route) => ({
          name: route.name,
          path: route.path.startsWith('/') ? route.path : `/${route.path}`,
        }));

      res.json({
        success: true,
        data: publicPanels,
      });
    } catch (error) {
      logger.error(`[AGENT PANELS] Error retrieving panels for agent ${agentId}:`, error);
      res.status(500).json({
        success: false,
        error: {
          code: 'PANEL_ERROR',
          message: 'Error retrieving agent panels',
          details: error instanceof Error ? error.message : String(error),
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

  // Create a new room for an agent
  router.post('/:agentId/rooms', async (req, res) => {
    const agentId = validateUuid(req.params.agentId);
    if (!agentId) {
      sendError(res, 400, 'INVALID_ID', 'Invalid agent ID format');
      return;
    }

    // Get runtime
    const runtime = agents.get(agentId);
    if (!runtime) {
      sendError(res, 404, 'NOT_FOUND', 'Agent not found');
      return;
    }

    try {
      // Extract data from request body
      const { name, type = 'dm', source = 'client', worldId, metadata } = req.body;

      if (!name) {
        sendError(res, 400, 'MISSING_PARAM', 'Room name is required');
        return;
      }

      // Generate a unique ID for the room
      const roomId = createUniqueUuid(runtime, `room-${Date.now()}`);
      const serverId = req.body.serverId || `server-${Date.now()}`;

      // Ensure world exists or create a new one
      let resolvedWorldId = worldId;
      if (!resolvedWorldId) {
        // Create a default world if none provided
        const worldName = `World for ${name}`;
        resolvedWorldId = createUniqueUuid(runtime, `world-${Date.now()}`);

        await runtime.ensureWorldExists({
          id: resolvedWorldId,
          name: worldName,
          agentId: runtime.agentId,
          serverId: serverId,
          metadata: metadata,
        });
      }

      // Create the room
      await runtime.ensureRoomExists({
        id: roomId,
        name: name,
        source: source,
        type: type,
        channelId: roomId,
        serverId: serverId,
        worldId: resolvedWorldId,
        metadata: metadata,
      });

      // Add the agent as a participant
      await runtime.addParticipant(runtime.agentId, roomId);
      await runtime.ensureParticipantInRoom(runtime.agentId, roomId);
      await runtime.setParticipantUserState(roomId, runtime.agentId, 'FOLLOWED');

      // Return the created room
      res.status(201).json({
        success: true,
        data: {
          id: roomId,
          name: name,
          agentId: agentId,
          createdAt: Date.now(),
          source: source,
          type: type,
          worldId: resolvedWorldId,
          serverId: serverId,
          metadata: metadata,
        },
      });
    } catch (error) {
      logger.error(`[ROOM CREATE] Error creating room for agent ${agentId}:`, error);
      sendError(res, 500, 'CREATE_ERROR', 'Failed to create room', error.message);
    }
  });

  // Get all rooms where an agent is a participant
  router.get('/:agentId/rooms', async (req, res) => {
    const agentId = validateUuid(req.params.agentId);
    if (!agentId) {
      sendError(res, 400, 'INVALID_ID', 'Invalid agent ID format');
      return;
    }

    // Get runtime
    const runtime = agents.get(agentId);
    if (!runtime) {
      sendError(res, 404, 'NOT_FOUND', 'Agent not found');
      return;
    }

    try {
      // Get all worlds for this agent
      const worlds = await runtime.getAllWorlds();
      const worldsMap = new Map(worlds.map((world) => [world.id, world]));

      // Use getRoomsForParticipant to directly get room IDs where agent is a participant
      const participantRoomIds = await runtime.getRoomsForParticipant(agentId);

      const agentRooms = [];

      // For each world, get rooms and filter by participant room IDs
      for (const world of worlds) {
        const worldRooms = await runtime.getRooms(world.id);

        // Filter rooms where agent is a participant
        for (const room of worldRooms) {
          if (participantRoomIds.includes(room.id)) {
            agentRooms.push({
              ...room,
              worldName: world.name,
            });
          }
        }
      }

      sendSuccess(res, { rooms: agentRooms });
    } catch (error) {
      logger.error(`[ROOMS LIST] Error retrieving rooms for agent ${agentId}:`, error);
      sendError(res, 500, 'RETRIEVAL_ERROR', 'Failed to retrieve agent rooms', error.message);
    }
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
        await handleAgentMessage(messageRequest as CustomRequest, res);
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

      // Convert to Buffer if not already a Buffer and detect MIME type
      const audioResult = await convertToAudioBuffer(speechResponse, true);

      logger.debug('[TTS] Setting response headers');
      res.set({
        'Content-Type': audioResult.mimeType,
        'Content-Length': audioResult.buffer.length.toString(),
      });

      res.send(audioResult.buffer);
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

      // Convert to Buffer if not already a Buffer and detect MIME type
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
        worldId: createUniqueUuid(runtime, 'direct'),
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

      // Convert to Buffer if not already a Buffer and detect MIME type
      const audioResult = await convertToAudioBuffer(speechResponse, true);

      logger.debug('[SPEECH CONVERSATION] Setting response headers');

      res.set({
        'Content-Type': audioResult.mimeType,
        'Content-Length': audioResult.buffer.length.toString(),
      });

      res.send(audioResult.buffer);

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
          cleanupFile(audioFile.path);
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

  router.post('/:agentId/message', handleAgentMessage);

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
          // Read file content into a buffer
          const fileBuffer = fs.readFileSync(file.path);
          let extractedTextForContent: string;
          const relativePath = file.originalname;

          if (file.mimetype === 'application/pdf') {
            extractedTextForContent = await convertPdfToText(fileBuffer);
          } else {
            extractedTextForContent = fileBuffer.toString('utf8');
          }

          const formattedMainText = `Path: ${relativePath}\n\n${extractedTextForContent}`;

          // Create knowledge item with proper metadata
          const knowledgeId = createUniqueUuid(runtime, `knowledge-${Date.now()}`);
          const fileExt = file.originalname.split('.').pop()?.toLowerCase() || '';
          const filename = file.originalname;
          const title = filename.replace(`.${fileExt}`, '');

          const knowledgeItem = {
            id: knowledgeId,
            content: {
              text: formattedMainText,
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
          await runtime.addKnowledge(knowledgeItem, undefined, {
            roomId: undefined,
            worldId: runtime.agentId,
            entityId: runtime.agentId,
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
              formattedMainText.length > 0
                ? `${formattedMainText.substring(0, 150)}${formattedMainText.length > 150 ? '...' : ''}`
                : 'No preview available',
          });
        } catch (fileError) {
          logger.error(`[KNOWLEDGE POST] Error processing file ${file.originalname}: ${fileError}`);
          cleanupFile(file.path);
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
      cleanupFiles(files);

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

  router.post('/groups/:serverId', async (req, res) => {
    const serverId = validateUuid(req.params.serverId);
    const { name, worldId, source, metadata, agentIds = [] } = req.body;

    if (!Array.isArray(agentIds) || agentIds.length === 0) {
      sendError(res, 400, 'BAD_REQUEST', 'agentIds must be a non-empty array');
      return;
    }

    let results = [];
    let errors = [];

    for (const agentId of agentIds) {
      try {
        const runtime = getRuntime(agents, agentId);
        const roomId = createUniqueUuid(runtime, serverId);
        const roomName = name || `Chat ${new Date().toLocaleString()}`;

        await runtime.ensureWorldExists({
          id: worldId,
          name: source,
          agentId: runtime.agentId,
          serverId: serverId,
        });

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

        results.push({
          id: roomId,
          name: roomName,
          createdAt: Date.now(),
          source: 'client',
          worldId,
        });
      } catch (error) {
        logger.error(`[ROOM CREATE] Error creating room for agent ${agentId}:`, error);
        errors.push({
          agentId,
          code: error.message === 'Agent not found' ? 'NOT_FOUND' : 'CREATE_ERROR',
          message: error.message === 'Agent not found' ? error.message : 'Failed to Create group',
          details: error.message,
        });
      }
    }

    if (results.length === 0) {
      res.status(500).json({
        success: false,
        error: errors.length
          ? errors
          : [{ code: 'UNKNOWN_ERROR', message: 'No rooms were created' }],
      });
    }

    res.status(errors.length ? 207 : 201).json({
      success: errors.length === 0,
      data: results,
      errors: errors.length ? errors : undefined,
    });
  });

  router.delete('/groups/:serverId', async (req, res) => {
    const serverId = validateUuid(req.params.serverId);
    try {
      await db.deleteRoomsByServerId(serverId);
      res.status(204).send();
    } catch (error) {
      logger.error('[GROUP DELETE] Error deleting group:', error);
      sendError(res, 500, 'DELETE_ERROR', 'Error deleting group', error.message);
    }
  });

  router.delete('/groups/:serverId/memories', async (req, res) => {
    const serverId = validateUuid(req.params.serverId);
    try {
      const memories = await db.getMemoriesByServerId({ serverId });
      for (const memory of memories) {
        await db.deleteMemory(memory.id);
      }
      res.status(204).send();
    } catch (error) {
      logger.error('[GROUP MEMORIES DELETE] Error clearing memories:', error);
      sendError(res, 500, 'DELETE_ERROR', 'Error deleting group memories', error.message);
    }
  });

  router.delete('/groups/:serverId/memories/:memoryId', async (req, res) => {
    const serverId = validateUuid(req.params.serverId);
    const memoryId = validateUuid(req.params.memoryId);

    try {
      const memory = await db.getMemoryById(memoryId);
      if (!memory) {
        sendError(res, 404, 'NOT_FOUND', 'Memory not found');
        return;
      }

      // Optional: verify the memory belongs to the provided serverId
      if (memory.roomId) {
        const rooms = await db.getRooms(memory.worldId as UUID);
        const room = rooms.find((r) => r.id === memory.roomId);
        if (room && room.serverId !== serverId) {
          sendError(res, 400, 'BAD_REQUEST', 'Memory does not belong to server');
          return;
        }
      }

      await db.deleteMemory(memoryId);
      res.status(204).send();
    } catch (error) {
      logger.error('[GROUP MEMORY DELETE] Error deleting memory:', error);
      sendError(res, 500, 'DELETE_ERROR', 'Error deleting memory', error.message);
    }
  });

  return router;
}
