/**
 * NPC Bootstrap Service
 *
 * Initializes NPC agents at server startup. Loads all Actor records from database,
 * registers each NPC in AgentRegistry (if not already registered), creates runtime
 * instances using AgentRuntimeManager, and sets up NPC-specific configurations.
 *
 * @remarks
 * Responsibilities:
 * 1. Load all Actor records from database
 * 2. Register each NPC in AgentRegistry (if not already registered)
 * 3. Create runtime instances using AgentRuntimeManager
 * 4. Set up NPC-specific configurations
 *
 * @packageDocumentation
 */

import {
  loadActorById,
  type StaticActor,
  StaticDataRegistry,
} from '@feed/engine';
import type { ActorData, AgentCapabilities } from '@feed/shared';
import {
  logger,
  mapActorToOASFDomains,
  mapActorToOASFSkills,
} from '@feed/shared';
import { agentRuntimeManager } from '../runtime/AgentRuntimeManager';
import { AgentStatus, AgentType } from '../types/agent-registry';
import { agentRegistry } from './agent-registry.service';

/**
 * Result of NPC bootstrap operation
 */
export interface NPCBootstrapResult {
  totalNpcs: number;
  registered: number;
  initialized: number;
  failed: number;
  errors: Array<{ actorId: string; error: string }>;
}

/**
 * Service for bootstrapping NPC agents
 *
 * Singleton service for managing NPC agent initialization, registration, and lifecycle.
 */
export class NPCBootstrapService {
  private static instance: NPCBootstrapService;

  private constructor() {
    // No initialization log - follows best practice of not logging routine lifecycle events
  }

  /**
   * Gets singleton instance
   *
   * @returns Singleton instance
   */
  public static getInstance(): NPCBootstrapService {
    if (!NPCBootstrapService.instance) {
      NPCBootstrapService.instance = new NPCBootstrapService();
    }
    return NPCBootstrapService.instance;
  }

  /**
   * Bootstrap all NPC agents from Actor database
   *
   * @description Bootstraps all NPC agents from the Actor database. Called at server
   * startup. Processes NPCs sequentially to avoid overwhelming the database. Returns
   * summary with total NPCs, registration counts, initialization counts, failures, and errors.
   *
   * @remarks
   * **Logging Best Practice**: Uses batch/aggregated logging pattern.
   * - NO per-NPC logs at INFO level (anti-pattern: logging inside loops)
   * - Single summary log after completion
   * - Only ERROR level for individual failures (actionable events)
   * - DEBUG level available for troubleshooting when needed
   *
   * @returns {Promise<NPCBootstrapResult>} Bootstrap result summary
   */
  public async bootstrapAllNpcs(): Promise<NPCBootstrapResult> {
    const startTime = Date.now();

    const result: NPCBootstrapResult = {
      totalNpcs: 0,
      registered: 0,
      initialized: 0,
      failed: 0,
      errors: [],
    };

    // Load all Actor records from static registry
    const actorsList = StaticDataRegistry.getAllActors()
      .slice()
      .sort((a, b) => (a.name as string).localeCompare(b.name as string));

    result.totalNpcs = actorsList.length;

    // Bootstrap each actor in sequence (to avoid overwhelming database)
    // IMPORTANT: Errors for individual NPCs should NOT stop the entire bootstrap
    // NOTE: No per-NPC logging - aggregate results and log summary only
    for (const actor of actorsList) {
      try {
        const bootstrapResult = await this.bootstrapSingleNpc(actor);
        if (bootstrapResult.registered) {
          result.registered++;
        }
        if (bootstrapResult.initialized) {
          result.initialized++;
        }
      } catch (error) {
        result.failed++;
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        result.errors.push({ actorId: actor.id, error: errorMessage });
        // Only log errors for failures - these are actionable events
        logger.error(
          `NPC bootstrap failed: ${actor.name}`,
          { actorId: actor.id, error: errorMessage },
          'NPCBootstrapService'
        );
        // Continue to next NPC - don't let one failure stop the entire bootstrap
      }
    }

    const durationMs = Date.now() - startTime;
    // Guard against division by zero when no NPCs exist
    const avgPerNpcMs =
      result.totalNpcs > 0 ? Math.round(durationMs / result.totalNpcs) : 0;

    // Single summary log with all relevant metrics (best practice: batch logging)
    logger.info(
      `NPC bootstrap complete`,
      {
        total: result.totalNpcs,
        initialized: result.initialized,
        registered: result.registered,
        failed: result.failed,
        durationMs,
        avgPerNpcMs,
      },
      'NPCBootstrapService'
    );

    return result;
  }

  /**
   * Bootstrap a single NPC agent
   *
   * @description Creates registry entry and runtime instance for a single NPC.
   * Loads ActorData from JSON files, builds system prompt and capabilities, registers
   * in AgentRegistry, and creates runtime instance.
   *
   * @param {StaticActor} actor - Static actor data from registry
   * @returns {Promise<object>} Object indicating which operations succeeded
   * @private
   */
  private async bootstrapSingleNpc(
    actor: StaticActor
  ): Promise<{ registered: boolean; initialized: boolean }> {
    // Use debug level for per-NPC logs to reduce startup noise
    logger.debug(
      `Bootstrapping NPC: ${actor.name} (${actor.id})`,
      undefined,
      'NPCBootstrapService'
    );

    let registered = false;
    let initialized = false;

    // Check if already registered
    const existing = await agentRegistry.getAgentById(actor.id);
    if (existing) {
      logger.debug(
        `NPC ${actor.id} already registered, initializing runtime only`,
        undefined,
        'NPCBootstrapService'
      );
      // Skip registration but still initialize runtime
    } else {
      // Load ActorData from JSON files for rich configuration
      const actorData: ActorData | null = loadActorById(actor.id);
      if (!actorData) {
        throw new Error(`ActorData not found for actor ${actor.id}`);
      }

      // Try to get full PackActor for richer Eliza character fields
      const packActor = StaticDataRegistry.getPackActor(actor.id);

      // Build NPC system prompt — prefer PackActor system prompt if available
      const systemPrompt = packActor?.system
        ? packActor.system
        : this.buildNpcSystemPrompt(actorData);

      // Build NPC capabilities from ActorData
      const capabilities = this.buildNpcCapabilities(actorData);

      // Register NPC in AgentRegistry
      await agentRegistry.registerNpcAgent({
        actorId: actor.id,
        systemPrompt,
        capabilities,
      });

      registered = true;
      logger.debug(
        `NPC ${actor.id} registered successfully`,
        undefined,
        'NPCBootstrapService'
      );
    }

    // Create runtime instance (this will cache it)
    const runtime = await agentRuntimeManager.getRuntime(actor.id);
    initialized = true;
    logger.debug(
      `NPC ${actor.id} runtime created (agentId: ${runtime.agentId})`,
      undefined,
      'NPCBootstrapService'
    );

    return { registered, initialized };
  }

  /**
   * Build system prompt for NPC from ActorData
   *
   * @description Builds system prompt using bio, category, physical description,
   * role, and other rich fields from ActorData. Adds game context about prediction
   * markets and social interactions.
   *
   * @param {ActorData} actorData - Actor data from JSON files
   * @returns {string} System prompt for NPC
   * @private
   */
  private buildNpcSystemPrompt(actorData: ActorData): string {
    const parts: string[] = [];

    // Base personality from description
    if (actorData.description) {
      parts.push(actorData.description);
    } else {
      parts.push(
        `You are ${actorData.name}, a character in the Feed prediction market game.`
      );
    }

    // Physical description adds immersion
    if (actorData.pfpDescription) {
      parts.push(`Physical appearance: ${actorData.pfpDescription}`);
    }

    // Role provides context
    if (actorData.role) {
      parts.push(`Role: ${actorData.role}`);
    }

    // Add game context
    parts.push(
      'You participate in prediction markets, social interactions, and autonomous trading.'
    );
    parts.push(
      'You maintain your personality while engaging with users and other agents.'
    );

    return parts.join('\n\n');
  }

  /**
   * Build capabilities for NPC from ActorData
   *
   * @description Builds agent capabilities including standard NPC strategies, markets,
   * actions, OASF taxonomy skills/domains, and game network configuration. NPCs have
   * standard game capabilities plus OASF taxonomy skills/domains mapped from ActorData.
   *
   * @param {ActorData} actorData - Actor data from JSON files
   * @returns {AgentCapabilities} Agent capabilities
   * @private
   */
  private buildNpcCapabilities(actorData: ActorData): AgentCapabilities {
    // Map ActorData to OASF skills and domains using the skill mapper
    const oasfSkills = mapActorToOASFSkills(actorData);
    const oasfDomains = mapActorToOASFDomains(actorData);

    return {
      // Standard NPC strategies
      strategies: [
        'prediction_markets',
        'social_interaction',
        'autonomous_trading',
      ],

      // NPCs can interact with all market types
      markets: ['prediction', 'perpetual', 'spot'],

      // Standard NPC actions
      actions: [
        'trade',
        'post',
        'comment',
        'like',
        'message',
        'analyze_market',
        'manage_portfolio',
      ],

      version: '1.0.0',

      // NPCs support x402 payments in game
      x402Support: true,

      // Platform and user type
      platform: 'feed',
      userType: 'npc',

      // OASF Taxonomy Support (Agent0 SDK v0.31.0)
      skills: oasfSkills,
      domains: oasfDomains,

      // A2A Communication Endpoints (Agent0 SDK v0.31.0)
      // Set when A2A endpoints are implemented
      a2aEndpoint: undefined,
      mcpEndpoint: undefined,
    };
  }

  /**
   * Bootstrap a specific NPC by ID
   *
   * @description Bootstraps a specific NPC by ID. Useful for adding new NPCs
   * at runtime or refreshing existing NPCs.
   *
   * @param {string} actorId - Actor ID to bootstrap
   * @returns {Promise<void>}
   * @throws {Error} If actor not found
   */
  public async bootstrapNpc(actorId: string): Promise<void> {
    // Get actor from static registry
    const actor = StaticDataRegistry.getActor(actorId);

    if (!actor) {
      throw new Error(`Actor ${actorId} not found`);
    }

    await this.bootstrapSingleNpc(actor);
  }

  /**
   * Remove NPC from registry and clear runtime
   *
   * @description Removes NPC from runtime cache and clears runtime instance.
   * Note: Does not delete from AgentRegistry to preserve history. Status will
   * be set to TERMINATED by clearRuntimeInstance.
   *
   * @param {string} actorId - Actor ID to remove
   * @returns {Promise<void>}
   */
  public async removeNpc(actorId: string): Promise<void> {
    // Clear runtime from cache
    await agentRuntimeManager.clearRuntime(actorId);

    // AgentRegistry entry is preserved for history
    // Status will be set to TERMINATED by clearRuntimeInstance
    logger.debug(`NPC ${actorId} removed`, undefined, 'NPCBootstrapService');
  }

  /**
   * Refresh NPC configuration
   *
   * @description Reloads ActorData and recreates runtime. Clears existing runtime
   * and bootstraps again with latest ActorData.
   *
   * @param {string} actorId - Actor ID to refresh
   * @returns {Promise<void>}
   */
  public async refreshNpc(actorId: string): Promise<void> {
    // Clear existing runtime
    await agentRuntimeManager.clearRuntime(actorId);

    // Bootstrap again (will use latest ActorData)
    await this.bootstrapNpc(actorId);

    logger.debug(`NPC ${actorId} refreshed`, undefined, 'NPCBootstrapService');
  }

  /**
   * Get bootstrap status for all NPCs
   *
   * @description Returns bootstrap status including total NPCs, registered count,
   * initialized count, and active count.
   *
   * @returns {Promise<object>} Bootstrap status summary
   */
  public async getBootstrapStatus(): Promise<{
    totalNpcs: number;
    registered: number;
    initialized: number;
    active: number;
  }> {
    const actorsList = StaticDataRegistry.getAllActors();
    const totalNpcs = actorsList.length;

    const registrations = await agentRegistry.discoverAgents({
      types: [AgentType.NPC],
    });

    const registered = registrations.length;
    const initialized = registrations.filter(
      (r) =>
        r.status === AgentStatus.INITIALIZED || r.status === AgentStatus.ACTIVE
    ).length;
    const active = registrations.filter(
      (r) => r.status === AgentStatus.ACTIVE
    ).length;

    return {
      totalNpcs,
      registered,
      initialized,
      active,
    };
  }
}

// Export singleton instance
export const npcBootstrapService = NPCBootstrapService.getInstance();
