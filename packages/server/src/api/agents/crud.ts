import type { Agent, Character, ElizaOS } from '@elizaos/core';
import { validateUuid, logger, getSalt, encryptObjectValues } from '@elizaos/core';
import express from 'express';
import type { AgentServer } from '../../index';
import { sendError, sendSuccess } from '../shared/response-utils';

/**
 * Agent CRUD operations
 */
export function createAgentCrudRouter(
  elizaOS: ElizaOS,
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
      const runtimes = elizaOS.getAgents().map((a) => a.agentId);

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
      logger.error({ src: 'http', error }, 'Error retrieving agents');
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

      const runtime = elizaOS.getAgent(agentId);
      const response = {
        ...agent,
        status: runtime ? 'active' : 'inactive',
      };

      sendSuccess(res, response);
    } catch (error) {
      logger.error({ src: 'http', error, agentId }, 'Error retrieving agent');
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
    const { characterPath, characterJson, agent } = req.body;
    if (!db) {
      return sendError(res, 500, 'DB_ERROR', 'Database not available');
    }

    try {
      let character: Character;

      if (characterJson) {
        character = await serverInstance?.jsonToCharacter(characterJson);
      } else if (characterPath) {
        character = await serverInstance?.loadCharacterTryPath(characterPath);
      } else if (agent) {
        character = await serverInstance?.jsonToCharacter(agent);
      } else {
        throw new Error('No character configuration provided');
      }

      if (!character) {
        throw new Error('Failed to create character configuration');
      }

      // Encrypt all secrets before saving to database
      const salt = getSalt();
      if (character.settings?.secrets && typeof character.settings.secrets === 'object') {
        character.settings.secrets = encryptObjectValues(
          character.settings.secrets as Record<string, any>,
          salt
        );
      }
      // Also encrypt character.secrets (root level) if it exists
      if (character.secrets && typeof character.secrets === 'object') {
        character.secrets = encryptObjectValues(character.secrets as Record<string, any>, salt) as {
          [key: string]: string | number | boolean;
        };
      }

      const ensureAgentExists = async (character: Character) => {
        // Ensure character has an ID - if not, it should have been set during loading
        if (!character.id) {
          throw new Error('Character must have an ID');
        }
        const agentId = character.id;
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
          character,
        },
      });
      logger.success(
        { src: 'http', agentId: newAgent.id, agentName: character.name },
        'Agent created'
      );
    } catch (error) {
      logger.error({ src: 'http', error }, 'Error creating agent');
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
      // Get current agent state before update to detect critical changes
      const currentAgent = await db.getAgent(agentId);
      const activeRuntime = elizaOS.getAgent(agentId);

      // Encrypt secrets before saving to database
      const salt = getSalt();
      if (updates.settings?.secrets && typeof updates.settings.secrets === 'object') {
        updates.settings.secrets = encryptObjectValues(
          updates.settings.secrets as Record<string, any>,
          salt
        );
      }
      if (updates.secrets && typeof updates.secrets === 'object') {
        updates.secrets = encryptObjectValues(updates.secrets as Record<string, any>, salt) as {
          [key: string]: string | number | boolean;
        };
      }

      if (Object.keys(updates).length > 0) {
        await db.updateAgent(agentId, updates);
      }

      const updatedAgent = await db.getAgent(agentId);

      // Detect if plugins have changed - this requires a full restart
      let needsRestart = false;
      if (currentAgent && activeRuntime && updatedAgent) {
        // Validate plugins array structure
        if (updatedAgent.plugins && !Array.isArray(updatedAgent.plugins)) {
          throw new Error('plugins must be an array');
        }

        interface PluginWithName {
          name: string;
          [key: string]: unknown;
        }
        const currentPlugins = (currentAgent.plugins || [])
          .filter((p) => p !== null && p !== undefined)
          .map((p) => (typeof p === 'string' ? p : (p as PluginWithName).name))
          .filter((name) => typeof name === 'string')
          .sort();

        const updatedPlugins = (updatedAgent.plugins || [])
          .filter((p) => p !== null && p !== undefined)
          .map((p) => (typeof p === 'string' ? p : (p as PluginWithName).name))
          .filter((name) => typeof name === 'string')
          .sort();

        const pluginsChanged =
          currentPlugins.length !== updatedPlugins.length ||
          currentPlugins.some((plugin, idx) => plugin !== updatedPlugins[idx]);

        needsRestart = pluginsChanged;
      }

      // Check if agent is currently active
      if (activeRuntime && updatedAgent) {
        if (needsRestart) {
          // Plugins changed - need full restart
          try {
            await serverInstance?.unregisterAgent(agentId);

            const {
              enabled: _enabled,
              status: _status,
              createdAt: _createdAt,
              updatedAt: _updatedAt,
              ...characterData
            } = updatedAgent;
            const runtimes = await serverInstance?.startAgents([
              { character: characterData as Character },
            ]);
            if (!runtimes || runtimes.length === 0) {
              throw new Error('Failed to restart agent after configuration change');
            }
            logger.debug({ src: 'http', agentId }, 'Agent restarted after config change');
          } catch (restartError) {
            logger.error({ src: 'http', error: restartError, agentId }, 'Failed to restart agent');

            // Try to restore the agent with the previous configuration
            try {
              const { enabled, status, createdAt, updatedAt, ...previousCharacterData } =
                currentAgent!;
              await serverInstance?.startAgents([
                { character: previousCharacterData as Character },
              ]);
              logger.warn({ src: 'http', agentId }, 'Restored agent to previous state');
            } catch (restoreError) {
              logger.error(
                { src: 'http', error: restoreError, agentId },
                'Failed to restore agent - may be in broken state'
              );
            }

            throw restartError;
          }
        } else {
          // Only character properties changed - can update in-place
          const { enabled, status, createdAt, updatedAt, ...characterData } = updatedAgent;
          await elizaOS.updateAgent(agentId, characterData as Character);
        }
      }

      const runtime = elizaOS.getAgent(agentId);
      const status = runtime ? 'active' : 'inactive';

      sendSuccess(res, { ...updatedAgent, status });
    } catch (error) {
      logger.error({ src: 'http', error, agentId }, 'Error updating agent');
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
    } catch (checkError) {
      logger.error({ src: 'http', error: checkError, agentId }, 'Error checking if agent exists');
    }

    const timeoutId = setTimeout(() => {
      logger.warn({ src: 'http', agentId }, 'Agent deletion taking longer than expected');
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
        const runtime = elizaOS.getAgent(agentId);
        if (runtime) {
          try {
            await serverInstance?.unregisterAgent(agentId);
          } catch (stopError) {
            logger.error({ src: 'http', error: stopError, agentId }, 'Error stopping agent');
          }
        }

        await db.deleteAgent(agentId);
        clearTimeout(timeoutId);

        logger.success({ src: 'http', agentId }, 'Agent deleted');

        if (!res.headersSent) {
          res.status(204).send();
        }

        return;
      } catch (error) {
        lastError = error;
        retryCount++;

        logger.error(
          { src: 'http', error, agentId, attempt: retryCount, maxRetries: MAX_RETRIES + 1 },
          'Error deleting agent'
        );

        if (retryCount > MAX_RETRIES) {
          break;
        }

        const delay = 1000 * Math.pow(2, retryCount - 1);
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
