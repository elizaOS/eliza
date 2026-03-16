import type { Plugin, IAgentRuntime, Memory, CustomMetadata } from '@elizaos/core';
import { logger, MemoryType } from '@elizaos/core';

import { characterEvolutionEvaluator } from './evaluators/character-evolution';
import { modifyCharacterAction } from './actions/modify-character';
import { CharacterFileManager } from './services/character-file-manager';
/**
 * Self-Modification Plugin for elizaOS
 *
 * Enables agents to evolve their character files over time through:
 * - Conversation analysis and learning
 * - User feedback integration
 * - Gradual personality development
 * - Safe character file management
 *
 * Features:
 * - CHARACTER_EVOLUTION evaluator: Analyzes conversations for evolution opportunities
 * - MODIFY_CHARACTER action: Handles direct character modifications
 * - CHARACTER_EVOLUTION provider: Supplies self-reflection context
 * - CharacterFileManager service: Manages safe file operations with backups
 */
export const selfModificationPlugin: Plugin = {
  name: '@elizaos/plugin-personality',
  description:
    'Enables agent self-modification and character evolution through conversation analysis and user feedback',

  // Core components
  evaluators: [characterEvolutionEvaluator],
  actions: [modifyCharacterAction],
  services: [CharacterFileManager as import('@elizaos/core').ServiceClass],

  // Plugin configuration
  config: {
    // Evolution settings
    EVOLUTION_COOLDOWN_MS: 5 * 60 * 1000, // 5 minutes between evaluations
    MODIFICATION_CONFIDENCE_THRESHOLD: 0.7, // Minimum confidence for auto-modifications
    MAX_BIO_ELEMENTS: 20,
    MAX_TOPICS: 50,
    MAX_BACKUPS: 10,

    // Safety settings
    REQUIRE_ADMIN_APPROVAL: false, // Set to true in production
    ENABLE_AUTO_EVOLUTION: true,
    VALIDATE_MODIFICATIONS: true,

    // File management
    BACKUP_DIRECTORY: '.eliza/character-backups',
    CHARACTER_FILE_DETECTION: true,
  },

  async init(config: Record<string, string>, runtime: IAgentRuntime): Promise<void> {
    logger.debug('Self-Modification Plugin initializing...');

    try {
      // Note: CharacterFileManager is registered as a service in this plugin's
      // `services` array, but service registration happens asynchronously AFTER
      // init() returns.  There is no point checking for it here — it will be
      // available by the time actions / evaluators need it at runtime.
      // (Character file detection also depends on a JSON file on disk, which
      //  Milaidy's config-based approach may not have.)

      // Log current character state
      const character = runtime.character;
      const characterStats = {
        name: character.name,
        bioElements: Array.isArray(character.bio) ? character.bio.length : 1,
        topics: character.topics?.length || 0,
        messageExamples: character.messageExamples?.length || 0,
        hasStyleConfig: !!(character.style?.all || character.style?.chat || character.style?.post),
        hasSystemPrompt: !!character.system,
      };

      logger.debug(characterStats, 'Current character state');

      // Plugin init() runs during runtime.initialize() BEFORE the agent
      // entity and room rows are created (those happen after all plugins
      // finish registering). Even when the adapter object exists (because
      // plugin-sql was pre-registered), the agents / entities / rooms tables
      // won't have this agent's rows yet, so cache writes (FK on agent_id)
      // and memory writes (FK on entity_id, room_id) would hit foreign-key
      // violations.  The SQL plugin logs those as Error before we can catch
      // them, producing scary-looking output.
      //
      // Guard: only attempt DB writes when the agent entity already exists
      // (i.e. on a restart where the DB is populated, not on first boot).
      const runtimeRecord = runtime as unknown as Record<string, unknown>;
      const adapterReady =
        typeof runtimeRecord.adapter === 'object' &&
        runtimeRecord.adapter !== null;

      let entityReady = false;
      if (adapterReady) {
        try {
          const entity = await runtime.getEntityById(runtime.agentId);
          entityReady = !!entity;
        } catch {
          // Entity lookup failed — DB schema not ready yet
        }
      }

      if (entityReady) {
        // Initialize evolution tracking using proper cache methods
        try {
          await runtime.setCache('self-modification:initialized', Date.now().toString());
          await runtime.setCache('self-modification:modification-count', '0');
          logger.debug('Evolution tracking initialized');
        } catch (cacheError) {
          logger.debug('Cache not available during init, will initialize lazily');
        }

        // Create proper initialization memory with correct structure
        try {
          const initMemory: Memory = {
            entityId: runtime.agentId,
            roomId: runtime.agentId,
            content: {
              text: `Self-modification plugin initialized. Character: ${characterStats.name}, Bio: ${characterStats.bioElements} elements, Topics: ${characterStats.topics}, System: ${characterStats.hasSystemPrompt ? 'present' : 'none'}`,
              source: 'plugin_initialization',
            },
            metadata: {
              type: MemoryType.CUSTOM,
              plugin: '@elizaos/plugin-personality',
              timestamp: Date.now(),
              characterBaseline: characterStats as unknown as Record<string, unknown>,
            } as CustomMetadata,
          };

          await runtime.createMemory(initMemory, 'plugin_events');
          logger.debug('Plugin initialization memory created');
        } catch (memoryError) {
          logger.debug('Memory creation failed during init, will initialize lazily');
        }
      } else {
        logger.debug(
          'Agent entity not yet created (plugin init runs before entity setup) — deferring cache/memory to first use'
        );
      }

      logger.debug(
        {
          evolutionEnabled: config.ENABLE_AUTO_EVOLUTION !== 'false',
          confidenceThreshold: config.MODIFICATION_CONFIDENCE_THRESHOLD || '0.7',
          characterHasSystem: characterStats.hasSystemPrompt,
          entityReady,
        },
        'Self-Modification Plugin initialized successfully'
      );
    } catch (error) {
      logger.error({ err: error }, 'Critical error during plugin initialization');
      throw error;
    }
  },
};

// Export individual components for testing
export { characterEvolutionEvaluator, modifyCharacterAction, CharacterFileManager };

// Default export
export default selfModificationPlugin;
