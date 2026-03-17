/**
 * TrajectoryGenerator
 *
 * Generates real trajectories using real agents running in parallel.
 * Uses AutonomousCoordinator with trajectory recording enabled.
 *
 * Requires dependencies via configureTrainingDependencies() before use.
 *
 * @packageDocumentation
 */

import { getTrainingDataAdapter } from "../adapter";
import { ArchetypeConfigService } from "../archetypes/ArchetypeConfigService";
import type { IAgentRuntimeLike, UserLike } from "../dependencies";
import {
  areAgentDependenciesConfigured,
  getAgentRuntimeManager,
  getAgentService,
  getAutonomousCoordinator,
} from "../dependencies";
import { logger } from "../utils/logger";

export interface ParallelGenerationConfig {
  // Agent configuration
  archetypes: string[];
  agentsPerArchetype: number;

  // Simulation configuration
  ticksPerAgent: number;
  parallelAgents: number; // How many agents to run simultaneously

  // Recording configuration
  recordTrajectories: boolean;

  // Manager
  managerId: string;
}

export interface ParallelGenerationResult {
  agentsCreated: string[];
  trajectoryIds: string[];
  totalTicks: number;
  duration: number;
  errors: string[];
  archetypeStats: Record<
    string,
    {
      agents: number;
      trajectories: number;
      avgTicksPerAgent: number;
    }
  >;
}

/**
 * Ensure dependencies are configured before use
 */
function ensureDependencies(): void {
  if (!areAgentDependenciesConfigured()) {
    throw new Error(
      "Training dependencies not configured. Call configureTrainingDependencies() with agentService, agentRuntimeManager, and autonomousCoordinator first.",
    );
  }
}

/**
 * Generator that creates and runs real agents in parallel
 */
export class TrajectoryGenerator {
  private config: ParallelGenerationConfig;
  private agents: Map<string, { user: UserLike; archetype: string }> =
    new Map();

  constructor(config: ParallelGenerationConfig) {
    this.config = {
      ...config,
      recordTrajectories: true, // Always record for training
      parallelAgents: Math.min(config.parallelAgents || 5, 10), // Cap at 10 for safety
    };
  }

  /**
   * Create agents based on archetypes
   */
  private async createArchetypeAgents(): Promise<void> {
    ensureDependencies();
    const agentService = getAgentService();

    logger.info(
      "Creating archetype-based agents...",
      {
        archetypes: this.config.archetypes,
        perArchetype: this.config.agentsPerArchetype,
      },
      "TrajectoryGenerator",
    );

    for (const archetype of this.config.archetypes) {
      const archetypeConfig = ArchetypeConfigService.getConfig(archetype);

      for (let i = 0; i < this.config.agentsPerArchetype; i++) {
        // Create agent using the actual AgentService
        // Use small initial deposit to avoid insufficient points errors
        const agent = await agentService.createAgent({
          userId: this.config.managerId,
          name: `${archetypeConfig.name} ${i + 1}`,
          description: archetypeConfig.description,
          bio: archetypeConfig.bio,
          personality: archetypeConfig.personality,
          tradingStrategy: archetypeConfig.tradingStrategy,
          system: archetypeConfig.system,
          initialDeposit: 100, // Small deposit for training agents
        });

        // Update autonomous settings in agent config based on archetype
        // Disable A2A to allow offline training without localhost server
        await getTrainingDataAdapter().updateAgentConfig(agent.id, {
          autonomousTrading: archetypeConfig.actionWeights.trade > 0.3,
          autonomousPosting: archetypeConfig.postFrequency !== "low",
          autonomousCommenting:
            archetypeConfig.engagementStyle === "helpful" ||
            archetypeConfig.engagementStyle === "analytical",
          autonomousDMs: archetypeConfig.dmActivity,
          autonomousGroupChats: archetypeConfig.groupChatActivity,
          maxActionsPerTick: 5,
          a2aEnabled: false, // Disable A2A for training
          updatedAt: new Date(),
        });

        this.agents.set(agent.id, { user: agent, archetype });

        logger.info(
          `Created ${archetype} agent: ${agent.username}`,
          {},
          "TrajectoryGenerator",
        );
      }
    }

    logger.info(
      `Created ${this.agents.size} agents total`,
      {},
      "TrajectoryGenerator",
    );
  }

  /**
   * Run agents in parallel batches
   */
  private async runParallelBatch(agentIds: string[]): Promise<{
    trajectoryIds: string[];
    errors: string[];
  }> {
    ensureDependencies();
    const agentRuntimeManager = getAgentRuntimeManager();
    const autonomousCoordinator = getAutonomousCoordinator();

    const trajectoryIds: string[] = [];
    const errors: string[] = [];

    // Create promises for parallel execution
    const promises = agentIds.map(async (agentId) => {
      const agentInfo = this.agents.get(agentId);
      if (!agentInfo) return;

      // Get agent runtime - disable A2A for training to avoid connection errors
      let runtime: IAgentRuntimeLike;
      const runtimeResult = await agentRuntimeManager.getRuntime(agentId);

      // If runtime creation returns null/undefined, skip
      if (!runtimeResult) {
        logger.warn(
          `Runtime creation returned null for ${agentId}, skipping`,
          {},
          "TrajectoryGenerator",
        );
        return;
      }
      runtime = runtimeResult;

      // Apply archetype configuration to runtime character if available
      const archetypeConfig = ArchetypeConfigService.getConfig(
        agentInfo.archetype,
      );
      const character = runtime.character as
        | { name?: string; bio?: string | string[]; topics?: string[] }
        | undefined;
      if (character) {
        character.name = archetypeConfig.name;
        character.bio = archetypeConfig.bio.join(" ");
        if (!character.topics) {
          character.topics = [];
        }

        // Add archetype-specific topics
        if (archetypeConfig.preferredMarkets.includes("perpetual")) {
          character.topics.push("perpetual_trading", "leverage");
        }
        if (archetypeConfig.preferredMarkets.includes("prediction")) {
          character.topics.push("prediction_markets", "forecasting");
        }
      }

      // Run ticks for this agent
      for (let tick = 0; tick < this.config.ticksPerAgent; tick++) {
        logger.debug(
          `Agent ${agentInfo.user.username} - Tick ${tick + 1}/${this.config.ticksPerAgent}`,
        );

        // Execute autonomous tick with trajectory recording
        const result = await autonomousCoordinator.executeAutonomousTick(
          agentId,
          runtime,
          true, // Enable trajectory recording
        );

        if (result.trajectoryId) {
          trajectoryIds.push(result.trajectoryId);
          logger.debug(
            `Recorded trajectory ${result.trajectoryId} for ${agentInfo.user.username}`,
          );
        }

        // Small delay between ticks
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      logger.info(
        `Completed ${this.config.ticksPerAgent} ticks for ${agentInfo.user.username}`,
        {
          trajectories: trajectoryIds.length,
          archetype: agentInfo.archetype,
        },
        "TrajectoryGenerator",
      );
    });

    // Wait for all agents in batch to complete
    await Promise.allSettled(promises).then((results) => {
      for (const result of results) {
        if (result.status === "rejected") {
          const errorMsg = `Agent batch error: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`;
          logger.error(
            errorMsg,
            { error: result.reason },
            "TrajectoryGenerator",
          );
          errors.push(errorMsg);
        }
      }
    });

    return { trajectoryIds, errors };
  }

  /**
   * Generate trajectories with parallel agent execution
   */
  async generate(): Promise<ParallelGenerationResult> {
    const startTime = Date.now();
    const result: ParallelGenerationResult = {
      agentsCreated: [],
      trajectoryIds: [],
      totalTicks: 0,
      duration: 0,
      errors: [],
      archetypeStats: {},
    };

    // Create agents
    await this.createArchetypeAgents();
    result.agentsCreated = Array.from(this.agents.keys());

    // Initialize stats
    for (const archetype of this.config.archetypes) {
      result.archetypeStats[archetype] = {
        agents: 0,
        trajectories: 0,
        avgTicksPerAgent: 0,
      };
    }

    // Count agents per archetype
    for (const [_, agentInfo] of this.agents) {
      const stat = result.archetypeStats[agentInfo.archetype];
      if (stat) {
        stat.agents++;
      }
    }

    logger.info(
      "Starting parallel trajectory generation",
      {
        totalAgents: this.agents.size,
        parallelBatches: Math.ceil(
          this.agents.size / this.config.parallelAgents,
        ),
        ticksPerAgent: this.config.ticksPerAgent,
      },
      "TrajectoryGenerator",
    );

    // Process agents in parallel batches
    const agentIds = Array.from(this.agents.keys());
    for (let i = 0; i < agentIds.length; i += this.config.parallelAgents) {
      const batch = agentIds.slice(i, i + this.config.parallelAgents);

      logger.info(
        `Processing batch ${Math.floor(i / this.config.parallelAgents) + 1}/${Math.ceil(agentIds.length / this.config.parallelAgents)}`,
        {
          agents: batch.length,
        },
        "TrajectoryGenerator",
      );

      const batchResult = await this.runParallelBatch(batch);
      result.trajectoryIds.push(...batchResult.trajectoryIds);
      result.errors.push(...batchResult.errors);
      result.totalTicks += batch.length * this.config.ticksPerAgent;
    }

    // Calculate stats
    for (const trajId of result.trajectoryIds) {
      // Get trajectory to determine archetype
      const trajectory =
        await getTrainingDataAdapter().getTrajectoryById(trajId);

      if (trajectory) {
        const agentInfo = this.agents.get(trajectory.agentId);
        if (agentInfo) {
          const stat = result.archetypeStats[agentInfo.archetype];
          if (stat) {
            stat.trajectories++;
          }
        }
      }
    }

    // Calculate averages
    for (const stats of Object.values(result.archetypeStats)) {
      if (stats.agents > 0) {
        stats.avgTicksPerAgent = stats.trajectories / stats.agents;
      }
    }

    result.duration = Date.now() - startTime;

    logger.info(
      "Parallel generation complete",
      {
        agents: result.agentsCreated.length,
        trajectories: result.trajectoryIds.length,
        totalTicks: result.totalTicks,
        durationSeconds: result.duration / 1000,
        errors: result.errors.length,
      },
      "TrajectoryGenerator",
    );

    return result;
  }

  /**
   * Cleanup created agents (for testing)
   */
  async cleanup(): Promise<void> {
    logger.info(
      `Cleaning up ${this.agents.size} agents...`,
      {},
      "TrajectoryGenerator",
    );

    const adapter = getTrainingDataAdapter();
    for (const [agentId] of this.agents) {
      await adapter.deleteUser(agentId);
    }

    logger.info("Cleanup complete", {}, "TrajectoryGenerator");
  }
}

/**
 * Factory function for creating parallel generator
 */
export async function createParallelGenerator(
  config: ParallelGenerationConfig,
): Promise<TrajectoryGenerator> {
  return new TrajectoryGenerator(config);
}
