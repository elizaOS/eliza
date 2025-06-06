import type { AgentServer } from '@/src/server';
import { agentUpload } from '@/src/server/upload';
import { convertToAudioBuffer } from '@/src/utils';
import type {
  Agent,
  Character,
  Content,
  HandlerCallback,
  IAgentRuntime,
  Log,
  Memory,
  UUID,
  MemoryMetadata,
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
} from '@elizaos/core';
import express from 'express';
import fs from 'node:fs';
// Using Express.Multer.File type instead of importing from multer directly
type MulterFile = Express.Multer.File;

// Cache for compiled regular expressions to improve performance
const regexCache = new Map<string, RegExp>();

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

const cleanupFiles = (files: MulterFile[]) => {
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
 * @property {string} params.roomId - The unique identifier for the room associated with the request
 * @property {string} params.logId - The unique identifier for the log associated with the request
 * @property {string} params.worldId - The unique identifier for the world associated with the request
 * @property {string} params.memoryId - The unique identifier for the memory associated with the request
 * @property {string} params.messageId - The unique identifier for the message associated with the request
 * @property {string} params.filename - The filename associated with the request
 */
interface CustomRequest extends express.Request {
  query: any;
  body: any;
  file?: MulterFile;
  files?: MulterFile[];
  params: {
    agentId: string;
    roomId?: string;
    logId?: string;
    worldId?: string;
    memoryId?: string;
    messageId?: string;
    filename?: string;
  };
}

export function agentRouter(
  agents: Map<UUID, IAgentRuntime>,
  serverInstance?: AgentServer
): express.Router {
  const router = express.Router();
  const db = serverInstance?.database;

  // Get all worlds
  router.get('/worlds', async (req, res) => {
    try {
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

    const runtime = agents.get(agentId);
    if (!runtime) {
      sendError(res, 404, 'NOT_FOUND', 'Agent not found');
      return;
    }

    try {
      const world = (await runtime.getAllWorlds()).find((w) => w.id === worldId);

      if (!world) {
        sendError(res, 404, 'NOT_FOUND', 'World not found');
        return;
      }

      const { name, metadata } = req.body;

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

      await runtime.updateWorld(updatedWorld);
      const refreshedWorld = (await runtime.getAllWorlds()).find((w) => w.id === worldId);
      sendSuccess(res, { world: refreshedWorld });
    } catch (error) {
      logger.error('[WORLD UPDATE] Error updating world:', error);
      sendError(res, 500, '500', 'Error updating world', error.message);
    }
  });

  // List all agents with minimal details
  router.get('/', async (_, res) => {
    try {
      if (!db) {
        sendError(res, 500, 'DB_ERROR', 'Database not available');
        return;
      }
      const allAgents = await db.getAgents();
      const runtimes = Array.from(agents.keys());

      // Return only minimal agent data
      const response = allAgents
        .map((agent: Agent) => ({
          id: agent.id,
          name: agent.name,
          characterName: agent.name, // Since Agent extends Character, agent.name is the character name
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

  // Get specific agent details
  router.get('/:agentId', async (req, res) => {
    const agentId = validateUuid(req.params.agentId);
    if (!agentId) {
      sendError(res, 400, 'INVALID_ID', 'Invalid agent ID format');
      return;
    }
    if (!db) {
      sendError(res, 500, 'DB_ERROR', 'Database not available');
      return;
    }
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

  // Plugin middleware - handles all plugin routes
  router.use(
    '/:agentId/plugins/:pluginName',
    agentUpload.array('files', 12), // Use agentUpload for potential file uploads
    async (req: any, res, next) => {
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
        if (!runtime.plugins?.length) {
          next();
          return;
        }

        const fullPath = req.path;
        let path = fullPath;

        if (!path.startsWith('/')) {
          path = '/' + path;
        }

        for (const plugin of runtime.plugins) {
          if (!plugin.name) continue;
          if (plugin.routes && plugin.name === req.params.pluginName) {
            for (const r of plugin.routes) {
              if (r.type === req.method) {
                const executeHandler = () => {
                  if (r.path.match(/\*/)) {
                    if (path.match(r.path.replace('*', ''))) {
                      logger.debug(`Calling wildcard plugin route: ${r.path} for ${path}`);
                      r.handler(req, res, runtime);
                      return true;
                    }
                  } else {
                    if (path === r.path) {
                      logger.debug(`Calling exact match plugin route: ${r.path} for ${path}`);
                      r.handler(req, res, runtime);
                      return true;
                    }
                  }
                  return false;
                };

                if (r.isMultipart) {
                  logger.debug(`Executing multipart handler for plugin route: ${r.path}`);
                  if (executeHandler()) return;
                } else {
                  logger.debug(`Executing non-multipart handler for plugin route: ${r.path}`);
                  if (executeHandler()) return;
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
    }
  );

  // Create new agent
  router.post('/', async (req, res) => {
    logger.debug('[AGENT CREATE] Creating new agent');
    const { characterPath, characterJson } = req.body;
    if (!db) {
      sendError(res, 500, 'DB_ERROR', 'Database not available');
      return;
    }
    try {
      let character: Character;

      if (characterJson) {
        logger.debug('[AGENT CREATE] Parsing character from JSON');
        character = await serverInstance?.jsonToCharacter(characterJson);
      } else if (characterPath) {
        logger.debug(`[AGENT CREATE] Loading character from path: ${characterPath}`);
        character = await serverInstance?.loadCharacterTryPath(characterPath);
      } else {
        throw new Error('No character configuration provided');
      }

      if (!character) {
        throw new Error('Failed to create character configuration');
      }

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
          message: error instanceof Error ? error.message : 'Error creating agent',
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
    if (!db) {
      sendError(res, 500, 'DB_ERROR', 'Database not available');
      return;
    }
    const updates = req.body;

    try {
      if (updates.settings?.secrets) {
        const salt = getSalt();
        const encryptedSecrets: Record<string, string> = {};
        Object.entries(updates.settings.secrets).forEach(([key, value]) => {
          if (value === null) {
            encryptedSecrets[key] = null;
          } else if (typeof value === 'string') {
            encryptedSecrets[key] = encryptStringValue(value, salt);
          } else {
            encryptedSecrets[key] = value as string;
          }
        });
        updates.settings.secrets = encryptedSecrets;
      }

      if (Object.keys(updates).length > 0) {
        await db.updateAgent(agentId, updates);
      }

      const updatedAgent = await db.getAgent(agentId);

      const isActive = !!agents.get(agentId);
      if (isActive) {
        serverInstance?.unregisterAgent(agentId);
        await serverInstance?.startAgent(updatedAgent);
      }

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

    serverInstance?.unregisterAgent(agentId);

    logger.debug(`[AGENT STOP] Successfully stopped agent: ${runtime.character.name} (${agentId})`);

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
    if (!db) {
      sendError(res, 500, 'DB_ERROR', 'Database not available');
      return;
    }
    try {
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

      await serverInstance?.startAgent(agent);

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
    if (!db) {
      sendError(res, 500, 'DB_ERROR', 'Database not available');
      return;
    }
    logger.debug(`[AGENT DELETE] Validated agent ID: ${agentId}, proceeding with deletion`);

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
    }

    const timeoutId = setTimeout(() => {
      logger.warn(`[AGENT DELETE] Operation taking longer than expected for agent: ${agentId}`);
      if (!res.headersSent) {
        res.status(202).json({
          success: true,
          partial: true,
          message:
            'Agent deletion initiated but taking longer than expected. The operation will continue in the background.',
        });
      }
    }, 10000);

    const MAX_RETRIES = 2;
    let retryCount = 0;
    let lastError = null;

    while (retryCount <= MAX_RETRIES) {
      try {
        const runtime = agents.get(agentId);
        if (runtime) {
          logger.debug(`[AGENT DELETE] Agent ${agentId} is running, unregistering from server`);
          try {
            serverInstance?.unregisterAgent(agentId);
            logger.debug(`[AGENT DELETE] Agent ${agentId} unregistered successfully`);
          } catch (stopError) {
            logger.error(`[AGENT DELETE] Error stopping agent ${agentId}:`, stopError);
          }
        } else {
          logger.debug(`[AGENT DELETE] Agent ${agentId} was not running, no need to unregister`);
        }

        logger.debug(`[AGENT DELETE] Calling database deleteAgent method for agent: ${agentId}`);

        const deleteResult = await db.deleteAgent(agentId);
        logger.debug(`[AGENT DELETE] Database deleteAgent result: ${JSON.stringify(deleteResult)}`);

        clearTimeout(timeoutId);

        logger.success(`[AGENT DELETE] Successfully deleted agent: ${agentId}`);

        if (!res.headersSent) {
          res.status(204).send();
        }

        return;
      } catch (error) {
        lastError = error;
        retryCount++;

        logger.error(
          `[AGENT DELETE] Error deleting agent ${agentId} (attempt ${retryCount}/${MAX_RETRIES + 1}):`,
          error
        );

        if (retryCount > MAX_RETRIES) {
          break;
        }

        const delay = 1000 * Math.pow(2, retryCount - 1);
        logger.debug(`[AGENT DELETE] Waiting ${delay}ms before retry ${retryCount}`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    clearTimeout(timeoutId);

    if (!res.headersSent) {
      let statusCode = 500;
      let errorMessage = 'Error deleting agent';

      if (lastError instanceof Error) {
        const message = lastError.message;

        if (message.includes('foreign key constraint')) {
          errorMessage = 'Cannot delete agent because it has active references in the system';
          statusCode = 409;
        } else if (message.includes('timed out')) {
          errorMessage = 'Agent deletion operation timed out';
          statusCode = 408;
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

  // Get Agent Panels (public GET routes)
  router.get('/:agentId/panels', async (req, res) => {
    const agentId = validateUuid(req.params.agentId);
    if (!agentId) {
      sendError(res, 400, 'INVALID_ID', 'Invalid agent ID format');
      return;
    }

    const runtime = agents.get(agentId);
    if (!runtime) {
      sendError(res, 404, 'NOT_FOUND', 'Agent not found');
      return;
    }

    try {
      const publicPanels = runtime.plugins
        .flatMap((plugin) => plugin.routes || [])
        .filter((route) => route.public === true && route.type === 'GET' && route.name)
        .map((route) => ({
          name: route.name,
          // Construct the full path to the plugin route
          path: `/api/agents/${agentId}/plugins/${runtime.plugins.find((p) => p.routes?.includes(route))?.name}${route.path.startsWith('/') ? route.path : `/${route.path}`}`,
        }));

      sendSuccess(res, publicPanels);
    } catch (error) {
      logger.error(`[AGENT PANELS] Error retrieving panels for agent ${agentId}:`, error);
      sendError(res, 500, 'PANEL_ERROR', 'Error retrieving agent panels', error.message);
    }
  });

  // Get Agent Logs
  router.get('/:agentId/logs', async (req, res) => {
    const agentId = validateUuid(req.params.agentId);
    const { roomId, type, count, offset } = req.query;
    if (!agentId) {
      sendError(res, 400, 'INVALID_ID', 'Invalid agent ID format');
      return;
    }

    const runtime = agents.get(agentId);
    if (!runtime) {
      sendError(res, 404, 'NOT_FOUND', 'Agent not found');
      return;
    }

    if (roomId) {
      const roomIdValidated = validateUuid(roomId as string);
      if (!roomIdValidated) {
        sendError(res, 400, 'INVALID_ID', 'Invalid room ID format');
        return;
      }
    }
    try {
      const logs: Log[] = await runtime.getLogs({
        entityId: agentId,
        roomId: roomId ? (roomId as UUID) : undefined,
        type: type ? (type as string) : undefined,
        count: count ? Number(count) : undefined,
        offset: offset ? Number(offset) : undefined,
      });
      sendSuccess(res, logs);
    } catch (error) {
      logger.error(`[AGENT LOGS] Error retrieving logs for agent ${agentId}:`, error);
      sendError(res, 500, 'LOG_ERROR', 'Error retrieving agent logs', error.message);
    }
  });

  router.delete('/:agentId/logs/:logId', async (req, res) => {
    const agentId = validateUuid(req.params.agentId);
    const logId = validateUuid(req.params.logId);
    if (!agentId || !logId) {
      sendError(res, 400, 'INVALID_ID', 'Invalid agent or log ID format');
      return;
    }

    const runtime = agents.get(agentId);
    if (!runtime) {
      sendError(res, 404, 'NOT_FOUND', 'Agent not found');
      return;
    }
    try {
      await runtime.deleteLog(logId);
      res.status(204).send();
    } catch (error) {
      logger.error(`[LOG DELETE] Error deleting log ${logId} for agent ${agentId}:`, error);
      sendError(res, 500, 'DELETE_ERROR', 'Failed to delete log', error.message);
    }
  });

  // Create a new room for an agent
  router.post('/:agentId/rooms', async (req, res) => {
    const agentId = validateUuid(req.params.agentId);
    if (!agentId) {
      sendError(res, 400, 'INVALID_ID', 'Invalid agent ID format');
      return;
    }

    const runtime = agents.get(agentId);
    if (!runtime) {
      sendError(res, 404, 'NOT_FOUND', 'Agent not found');
      return;
    }

    try {
      const { name, type = ChannelType.DM, source = 'client', worldId, metadata } = req.body;

      if (!name) {
        sendError(res, 400, 'MISSING_PARAM', 'Room name is required');
        return;
      }

      const roomId = createUniqueUuid(runtime, `room-${Date.now()}`);
      const serverId = req.body.serverId || `server-${Date.now()}`;

      let resolvedWorldId = worldId;
      if (!resolvedWorldId) {
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

      await runtime.addParticipant(runtime.agentId, roomId);
      await runtime.ensureParticipantInRoom(runtime.agentId, roomId);
      await runtime.setParticipantUserState(roomId, runtime.agentId, 'FOLLOWED');

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

    const runtime = agents.get(agentId);
    if (!runtime) {
      sendError(res, 404, 'NOT_FOUND', 'Agent not found');
      return;
    }

    try {
      const worlds = await runtime.getAllWorlds();
      const participantRoomIds = await runtime.getRoomsForParticipant(agentId);
      const agentRooms = [];

      for (const world of worlds) {
        const worldRooms = await runtime.getRooms(world.id);
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

  // Get room details
  router.get('/:agentId/rooms/:roomId', async (req: CustomRequest, res: express.Response) => {
    const agentId = validateUuid(req.params.agentId);
    const roomId = validateUuid(req.params.roomId);

    if (!agentId || !roomId) {
      sendError(res, 400, 'INVALID_ID', 'Invalid agent ID or room ID format');
      return;
    }

    // Get runtime
    const runtime = agents.get(agentId);
    if (!runtime) {
      sendError(res, 404, 'NOT_FOUND', 'Agent not found');
      return;
    }

    try {
      const room = await runtime.getRoom(roomId);
      if (!room) {
        sendError(res, 404, 'NOT_FOUND', 'Room not found');
        return;
      }

      // Optionally, enrich room data with world name if needed
      // This depends on whether getRoom returns worldId and if you want to include worldName
      let worldName = 'N/A';
      if (room.worldId) {
        const world = await runtime.getWorld(room.worldId);
        if (world) {
          worldName = world.name;
        }
      }

      sendSuccess(res, { ...room, worldName });
    } catch (error) {
      logger.error(`[ROOM DETAILS] Error retrieving room ${roomId} for agent ${agentId}:`, error);
      sendError(res, 500, 'RETRIEVAL_ERROR', 'Failed to retrieve room details', error.message);
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
    agentUpload.single('file'), // Use agentUpload
    async (req: CustomRequest, res) => {
      logger.debug('[AUDIO MESSAGE] Processing audio message');
      const agentId = validateUuid(req.params.agentId);
      if (!agentId) {
        sendError(res, 400, 'INVALID_ID', 'Invalid agent ID format');
        return;
      }

      const audioFile = req.file;
      if (!audioFile) {
        sendError(res, 400, 'INVALID_REQUEST', 'No audio file provided');
        return;
      }

      const runtime = agents.get(agentId);

      if (!runtime) {
        sendError(res, 404, 'NOT_FOUND', 'Agent not found');
        return;
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

  // Text-to-Speech endpoint
  router.post('/:agentId/audio-messages/synthesize', async (req, res) => {
    const agentId = validateUuid(req.params.agentId);
    if (!agentId) {
      sendError(res, 400, 'INVALID_ID', 'Invalid agent ID format');
      return;
    }

    const { text } = req.body;
    if (!text) {
      sendError(res, 400, 'INVALID_REQUEST', 'Text is required for speech synthesis');
      return;
    }

    const runtime = agents.get(agentId);

    if (!runtime) {
      sendError(res, 404, 'NOT_FOUND', 'Agent not found');
      return;
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
      sendError(res, 500, 'PROCESSING_ERROR', 'Error generating speech', error.message);
    }
  });

  // Speech-related endpoints
  router.post('/:agentId/speech/generate', async (req, res) => {
    logger.debug('[SPEECH GENERATE] Request to generate speech from text');
    const agentId = validateUuid(req.params.agentId);
    if (!agentId) {
      sendError(res, 400, 'INVALID_ID', 'Invalid agent ID format');
      return;
    }

    const { text } = req.body;
    if (!text) {
      sendError(res, 400, 'INVALID_REQUEST', 'Text is required for speech synthesis');
      return;
    }

    const runtime = agents.get(agentId);

    if (!runtime) {
      sendError(res, 404, 'NOT_FOUND', 'Agent not found');
      return;
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
      sendError(res, 500, 'PROCESSING_ERROR', 'Error generating speech', error.message);
    }
  });

  router.post('/:agentId/speech/conversation', async (req, res) => {
    const agentId = validateUuid(req.params.agentId);
    if (!agentId) {
      sendError(res, 400, 'INVALID_ID', 'Invalid agent ID format');
      return;
    }

    const { text, roomId: rawRoomId, entityId: rawUserId, worldId: rawWorldId } = req.body;
    if (!text) {
      sendError(res, 400, 'INVALID_REQUEST', 'Text is required for conversation');
      return;
    }

    const runtime = agents.get(agentId);

    if (!runtime) {
      sendError(res, 404, 'NOT_FOUND', 'Agent not found');
      return;
    }

    try {
      const roomId = createUniqueUuid(runtime, rawRoomId ?? `default-room-${agentId}`);
      const entityId = createUniqueUuid(runtime, rawUserId ?? 'Anon');
      const worldId = rawWorldId ?? createUniqueUuid(runtime, 'direct');

      logger.debug('[SPEECH CONVERSATION] Ensuring connection');
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

      logger.debug('[SPEECH CONVERSATION] Creating memory');
      await runtime.createMemory(userMessageMemory, 'messages');

      logger.debug('[SPEECH CONVERSATION] Composing state');
      const state = await runtime.composeState(userMessageMemory);

      logger.debug('[SPEECH CONVERSATION] Creating context');
      const prompt = composePrompt({
        state,
        template: messageHandlerTemplate,
      });

      logger.debug('[SPEECH CONVERSATION] Using LLM for response');
      const llmResponse = await runtime.useModel(ModelType.TEXT_LARGE, {
        // Renamed to llmResponse
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

      if (!llmResponse) {
        sendError(res, 500, 'MODEL_ERROR', 'No response from model');
        return;
      }

      logger.debug('[SPEECH CONVERSATION] Creating response memory');

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

      logger.debug('[SPEECH CONVERSATION] Generating speech response from LLM output');

      const speechAudioResponse = await runtime.useModel(ModelType.TEXT_TO_SPEECH, llmResponse); // Use llmResponse for TTS
      const audioResult = await convertToAudioBuffer(speechAudioResponse, true);

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
      sendError(res, 500, 'PROCESSING_ERROR', 'Error processing conversation', error.message);
    }
  });

  router.post(
    '/:agentId/transcriptions',
    agentUpload.single('file'), // Use agentUpload
    async (req: CustomRequest, res) => {
      logger.debug('[TRANSCRIPTION] Request to transcribe audio');
      const agentId = validateUuid(req.params.agentId);
      if (!agentId) {
        sendError(res, 400, 'INVALID_ID', 'Invalid agent ID format');
        return;
      }

      const audioFile = req.file;
      if (!audioFile) {
        sendError(res, 400, 'INVALID_REQUEST', 'No audio file provided');
        return;
      }

      const runtime = agents.get(agentId);

      if (!runtime) {
        sendError(res, 404, 'NOT_FOUND', 'Agent not found');
        return;
      }

      try {
        logger.debug('[TRANSCRIPTION] Reading audio file');
        const audioBuffer = await fs.promises.readFile(audioFile.path);

        logger.debug('[TRANSCRIPTION] Transcribing audio');
        const transcription = await runtime.useModel(ModelType.TRANSCRIPTION, audioBuffer);

        cleanupFile(audioFile.path);

        if (!transcription) {
          sendError(res, 500, 'PROCESSING_ERROR', 'Failed to transcribe audio');
          return;
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

  // Get memories for a specific room
  router.get('/:agentId/rooms/:roomId/memories', async (req, res) => {
    const agentId = validateUuid(req.params.agentId);
    const roomId = validateUuid(req.params.roomId);

    if (!agentId || !roomId) {
      sendError(res, 400, 'INVALID_ID', 'Invalid agent ID or room ID format');
      return;
    }

    const runtime = agents.get(agentId);

    if (!runtime) {
      sendError(res, 404, 'NOT_FOUND', 'Agent not found');
      return;
    }

    try {
      const limit = req.query.limit ? Number.parseInt(req.query.limit as string, 10) : 20;
      const before = req.query.before
        ? Number.parseInt(req.query.before as string, 10)
        : Date.now();
      const includeEmbedding = req.query.includeEmbedding === 'true';
      const tableName = (req.query.tableName as string) || 'messages';

      const memories = await runtime.getMemories({
        tableName,
        roomId,
        count: limit,
        end: before,
      });

      const cleanMemories = includeEmbedding
        ? memories
        : memories.map((memory) => ({
            ...memory,
            embedding: undefined,
          }));

      sendSuccess(res, { memories: cleanMemories });
    } catch (error) {
      logger.error('[MEMORIES GET] Error retrieving memories for room:', error);
      sendError(res, 500, '500', 'Failed to retrieve memories', error.message);
    }
  });

  // get all memories for an agent
  router.get('/:agentId/memories', async (req, res) => {
    const agentId = validateUuid(req.params.agentId);

    if (!agentId) {
      sendError(res, 400, 'INVALID_ID', 'Invalid agent ID');
      return;
    }

    const runtime = agents.get(agentId);
    if (!runtime) {
      sendError(res, 404, 'NOT_FOUND', 'Agent not found');
      return;
    }
    try {
      const tableName = (req.query.tableName as string) || 'messages';
      const includeEmbedding = req.query.includeEmbedding === 'true';
      const roomId = req.query.roomId ? validateUuid(req.query.roomId as string) : undefined;

      if (req.query.roomId && !roomId) {
        sendError(res, 400, 'INVALID_ID', 'Invalid room ID format');
        return;
      }

      const memories = await runtime.getMemories({
        agentId,
        tableName,
        roomId,
      });

      const cleanMemories = includeEmbedding
        ? memories
        : memories.map((memory) => ({
            ...memory,
            embedding: undefined,
          }));
      sendSuccess(res, { memories: cleanMemories });
    } catch (error) {
      logger.error(`[AGENT MEMORIES] Error retrieving memories for agent ${agentId}:`, error);
      sendError(res, 500, 'MEMORY_ERROR', 'Error retrieving agent memories', error.message);
    }
  });

  // update a specific memory for an agent
  router.patch('/:agentId/memories/:memoryId', async (req, res) => {
    const agentId = validateUuid(req.params.agentId);
    const memoryId = validateUuid(req.params.memoryId);

    const { id: _idFromData, ...restOfMemoryData } = req.body;

    if (!agentId || !memoryId) {
      sendError(res, 400, 'INVALID_ID', 'Invalid agent ID or memory ID format');
      return;
    }

    const runtime = agents.get(agentId);
    if (!runtime) {
      sendError(res, 404, 'NOT_FOUND', 'Agent not found');
      return;
    }

    try {
      // Construct memoryToUpdate ensuring it satisfies Partial<Memory> & { id: UUID }
      const memoryToUpdate: Partial<Memory> & { id: UUID; metadata?: MemoryMetadata } = {
        // Explicitly set the required id using the validated path parameter
        id: memoryId,
        // Spread other properties from the request body.
        // Cast to Partial<Memory> to align with the base type.
        ...(restOfMemoryData as Partial<Memory>),
        // If specific fields from restOfMemoryData need type assertion (e.g., to UUID),
        // they should be handled here or ensured by upstream validation.
        // For example, if agentId from body is always expected as UUID:
        agentId: restOfMemoryData.agentId
          ? validateUuid(restOfMemoryData.agentId as string)
          : agentId,
        roomId: restOfMemoryData.roomId
          ? validateUuid(restOfMemoryData.roomId as string)
          : undefined,
        entityId: restOfMemoryData.entityId
          ? validateUuid(restOfMemoryData.entityId as string)
          : undefined,
        worldId: restOfMemoryData.worldId
          ? validateUuid(restOfMemoryData.worldId as string)
          : undefined,
        // Ensure metadata, if provided, conforms to MemoryMetadata
        metadata: restOfMemoryData.metadata as MemoryMetadata | undefined,
      };

      // Remove undefined fields that might have been explicitly set to undefined by casting above,
      // if the updateMemory implementation doesn't handle them gracefully.
      Object.keys(memoryToUpdate).forEach((key) => {
        if (memoryToUpdate[key] === undefined) {
          delete memoryToUpdate[key];
        }
      });

      await runtime.updateMemory(memoryToUpdate);

      logger.success(`[MEMORY UPDATE] Successfully updated memory ${memoryId}`);
      sendSuccess(res, { id: memoryId, message: 'Memory updated successfully' });
    } catch (error) {
      logger.error(`[MEMORY UPDATE] Error updating memory ${memoryId}:`, error);
      sendError(res, 500, 'UPDATE_ERROR', 'Failed to update memory', error.message);
    }
  });

  // Media upload endpoint for images and videos
  router.post(
    '/:agentId/upload-media',
    agentUpload.single('file'),
    async (req: CustomRequest, res) => {
      logger.debug('[MEDIA UPLOAD] Processing media upload');
      const agentId = validateUuid(req.params.agentId);

      if (!agentId) {
        sendError(res, 400, 'INVALID_ID', 'Invalid agent ID format');
        return;
      }

      const mediaFile = req.file;
      if (!mediaFile) {
        sendError(res, 400, 'INVALID_REQUEST', 'No media file provided');
        return;
      }

      const validImageTypes = [
        'image/jpeg',
        'image/png',
        'image/gif',
        'image/webp',
        'image/svg+xml',
        'image/bmp',
      ];
      const validVideoTypes = [
        'video/mp4',
        'video/webm',
        'video/mov',
        'video/avi',
        'video/mkv',
        'video/quicktime',
      ];
      const allValidTypes = [...validImageTypes, ...validVideoTypes];

      if (!allValidTypes.includes(mediaFile.mimetype)) {
        cleanupFile(mediaFile.path);
        sendError(res, 400, 'INVALID_FILE_TYPE', 'File must be an image or video');
        return;
      }

      try {
        const fileUrl = `/media/uploads/agents/${agentId}/${mediaFile.filename}`;
        const mediaType = validImageTypes.includes(mediaFile.mimetype) ? 'image' : 'video';

        logger.info(
          `[MEDIA UPLOAD] Successfully uploaded ${mediaType}: ${mediaFile.filename}. URL: ${fileUrl}`
        );

        sendSuccess(res, {
          url: fileUrl,
          type: mediaType,
          filename: mediaFile.filename,
          originalName: mediaFile.originalname,
          size: mediaFile.size,
        });
      } catch (error) {
        logger.error(`[MEDIA UPLOAD] Error processing upload: ${error}`);
        cleanupFile(mediaFile.path);
        sendError(res, 500, 'UPLOAD_ERROR', 'Failed to process media upload', error.message);
      }
    }
  );

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
        const runtime = getRuntime(agents, agentId as UUID);
        const roomId = createUniqueUuid(runtime, serverId as string);
        const roomName = name || `Chat ${new Date().toLocaleString()}`;

        await runtime.ensureWorldExists({
          id: worldId,
          name: source,
          agentId: runtime.agentId,
          serverId: serverId as UUID,
        });

        await runtime.ensureRoomExists({
          id: roomId,
          name: roomName,
          source,
          type: ChannelType.API,
          worldId,
          serverId: serverId as UUID,
          metadata,
          channelId: roomId,
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

    if (results.length === 0 && errors.length > 0) {
      res.status(500).json({
        success: false,
        error: errors.length
          ? errors
          : [{ code: 'UNKNOWN_ERROR', message: 'No rooms were created' }],
      });
      return;
    }

    res.status(errors.length ? 207 : 201).json({
      success: errors.length === 0,
      data: results,
      errors: errors.length ? errors : undefined,
    });
  });

  router.delete('/groups/:serverId', async (req, res) => {
    const worldId = validateUuid(req.params.serverId);
    if (!worldId) {
      sendError(res, 400, 'INVALID_ID', 'Invalid serverId (worldId) format');
      return;
    }
    if (!db) {
      sendError(res, 500, 'DB_ERROR', 'Database not available');
      return;
    }
    try {
      await db.deleteRoomsByWorldId(worldId);
      res.status(204).send();
    } catch (error) {
      logger.error('[GROUP DELETE] Error deleting group:', error);
      sendError(res, 500, 'DELETE_ERROR', 'Error deleting group', error.message);
    }
  });

  router.delete('/groups/:serverId/memories', async (req, res) => {
    const worldId = validateUuid(req.params.serverId);
    if (!worldId) {
      sendError(res, 400, 'INVALID_ID', 'Invalid serverId (worldId) format');
      return;
    }
    if (!db) {
      sendError(res, 500, 'DB_ERROR', 'Database not available');
      return;
    }
    try {
      const memories = await db.getMemoriesByWorldId({ worldId, tableName: 'messages' });
      for (const memory of memories) {
        await db.deleteMemory(memory.id as UUID);
      }
      res.status(204).send();
    } catch (error) {
      logger.error('[GROUP MEMORIES DELETE] Error clearing memories:', error);
      sendError(res, 500, 'DELETE_ERROR', 'Error deleting group memories', error.message);
    }
  });

  router.delete('/:agentId/memories/all/:roomId', async (req, res) => {
    try {
      const agentId = validateUuid(req.params.agentId);
      const roomId = validateUuid(req.params.roomId);

      if (!agentId) {
        sendError(res, 400, 'INVALID_ID', 'Invalid agent ID');
        return;
      }

      if (!roomId) {
        sendError(res, 400, 'INVALID_ID', 'Invalid room ID');
        return;
      }

      const runtime = agents.get(agentId);
      if (!runtime) {
        sendError(res, 404, 'NOT_FOUND', 'Agent not found');
        return;
      }

      await runtime.deleteAllMemories(roomId, MemoryType.MESSAGE);
      await runtime.deleteAllMemories(roomId, MemoryType.DOCUMENT);

      res.status(204).send();
    } catch (e) {
      logger.error('[DELETE ALL MEMORIES] Error deleting all memories:', e);
      sendError(res, 500, 'DELETE_ERROR', 'Error deleting all memories', e.message);
    }
  });

  return router;
}
