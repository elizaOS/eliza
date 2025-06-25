import type { Agent, Character, IAgentRuntime, UUID } from '@elizaos/core';
import {
  validateUuid,
  logger,
  stringToUuid,
  getSalt,
  encryptObjectValues,
  encryptStringValue,
} from '@elizaos/core';
import express from 'express';
import type { AgentServer } from '../../index';
import { sendError, sendSuccess } from '../shared/response-utils';

/**
 * Agent CRUD operations
 */
export function createAgentCrudRouter(
  agents: Map<UUID, IAgentRuntime>,
  serverInstance: AgentServer
): express.Router {
  const router = express.Router();
  const db = serverInstance?.database;

  // List all agents with minimal details
  router.get('/', async (_, res) => {
    try {
      if (!db) {
        return sendError(res, 500, 'DB_ERROR', 'Database not available');
      }
      const allAgents = await db.getAgents();
      const runtimes = Array.from(agents.keys());

      // Return only minimal agent data
      const response = allAgents
        .map((agent: Partial<Agent>) => ({
          id: agent.id,
          name: agent.name || '',
          characterName: agent.name || '', // Since Agent extends Character, agent.name is the character name
          bio: agent.bio?.[0] ?? '',
          status: agent.id && runtimes.includes(agent.id) ? 'active' : 'inactive',
        }))
        .filter((agent) => agent.id) // Filter out agents without IDs
        .sort((a: any, b: any) => {
          if (a.status === b.status) {
            return a.name.localeCompare(b.name);
          }
          return a.status === 'active' ? -1 : 1;
        });

      sendSuccess(res, { agents: response });
    } catch (error) {
      logger.error('[AGENTS LIST] Error retrieving agents:', error);
      sendError(
        res,
        500,
        '500',
        'Error retrieving agents',
        error instanceof Error ? error.message : String(error)
      );
    }
  });

  // Get specific agent details
  router.get('/:agentId', async (req, res) => {
    const agentId = validateUuid(req.params.agentId);
    if (!agentId) {
      return sendError(res, 400, 'INVALID_ID', 'Invalid agent ID format');
    }
    if (!db) {
      return sendError(res, 500, 'DB_ERROR', 'Database not available');
    }

    try {
      const agent = await db.getAgent(agentId);
      if (!agent) {
        return sendError(res, 404, 'NOT_FOUND', 'Agent not found');
      }

      const runtime = agents.get(agentId);
      const response = {
        ...agent,
        status: runtime ? 'active' : 'inactive',
      };

      sendSuccess(res, response);
    } catch (error) {
      logger.error('[AGENT GET] Error retrieving agent:', error);
      sendError(
        res,
        500,
        '500',
        'Error retrieving agent',
        error instanceof Error ? error.message : String(error)
      );
    }
  });

  // Create new agent
  router.post('/', async (req, res) => {
    logger.debug('[AGENT CREATE] Creating new agent');
    const { characterPath, characterJson, agent } = req.body;
    if (!db) {
      return sendError(res, 500, 'DB_ERROR', 'Database not available');
    }

    try {
      let character: Character;

      if (characterJson) {
        logger.debug('[AGENT CREATE] Parsing character from JSON');
        character = await serverInstance?.jsonToCharacter(characterJson);
      } else if (characterPath) {
        logger.debug(`[AGENT CREATE] Loading character from path: ${characterPath}`);
        character = await serverInstance?.loadCharacterTryPath(characterPath);
      } else if (agent) {
        logger.debug('[AGENT CREATE] Parsing character from agent object');
        character = await serverInstance?.jsonToCharacter(agent);
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

      const ensureAgentExists = async (character: Character) => {
        const agentId = stringToUuid(character.name);
        let agent = await db.getAgent(agentId);
        if (!agent) {
          await db.createAgent({ ...character, id: agentId });
          agent = await db.getAgent(agentId);
        }
        return agent;
      };

      const newAgent = await ensureAgentExists(character);

      if (!newAgent) {
        throw new Error(`Failed to create agent ${character.name}`);
      }

      res.status(201).json({
        success: true,
        data: {
          id: newAgent.id,
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
          details: error instanceof Error ? error.message : String(error),
        },
      });
    }
  });

  // Update agent
  router.patch('/:agentId', async (req, res) => {
    const agentId = validateUuid(req.params.agentId);
    if (!agentId) {
      return sendError(res, 400, 'INVALID_ID', 'Invalid agent ID format');
    }
    if (!db) {
      return sendError(res, 500, 'DB_ERROR', 'Database not available');
    }

    const updates = req.body;

    try {
      if (updates.settings?.secrets) {
        const salt = getSalt();
        const encryptedSecrets: Record<string, string | null> = {};
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
      if (isActive && updatedAgent) {
        serverInstance?.unregisterAgent(agentId);
        await serverInstance?.startAgent(updatedAgent);
      }

      const runtime = agents.get(agentId);
      const status = runtime ? 'active' : 'inactive';

      sendSuccess(res, { ...updatedAgent, status });
    } catch (error) {
      logger.error('[AGENT UPDATE] Error updating agent:', error);
      sendError(
        res,
        500,
        'UPDATE_ERROR',
        'Error updating agent',
        error instanceof Error ? error.message : String(error)
      );
    }
  });

  // Delete agent
  router.delete('/:agentId', async (req, res) => {
    logger.debug(`[AGENT DELETE] Received request to delete agent with ID: ${req.params.agentId}`);

    const agentId = validateUuid(req.params.agentId);
    if (!agentId) {
      logger.error(`[AGENT DELETE] Invalid agent ID format: ${req.params.agentId}`);
      return sendError(res, 400, 'INVALID_ID', 'Invalid agent ID format');
    }
    if (!db) {
      return sendError(res, 500, 'DB_ERROR', 'Database not available');
    }

    logger.debug(`[AGENT DELETE] Validated agent ID: ${agentId}, proceeding with deletion`);

    try {
      const agent = await db.getAgent(agentId);
      if (!agent) {
        logger.warn(`[AGENT DELETE] Agent not found: ${agentId}`);
        return sendError(res, 404, 'NOT_FOUND', 'Agent not found');
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
    let lastError: unknown = null;

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

  return router;
}
