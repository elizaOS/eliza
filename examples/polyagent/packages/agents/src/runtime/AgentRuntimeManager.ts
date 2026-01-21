/**
 * Agent Runtime Manager
 *
 * Runtime factory for Polyagent trading agents.
 * Manages multiple concurrent Eliza agent runtimes in a serverless environment.
 * Each agent gets its own isolated runtime instance with its own character configuration.
 *
 * @packageDocumentation
 */

import { db, eq, users } from "@babylon/db";
import { GROQ_MODELS } from "@babylon/shared";
import {
  AgentRuntime,
  type Character,
  type Plugin,
  type UUID,
} from "@elizaos/core";
import { anthropicPlugin } from "@elizaos/plugin-anthropic";
import { openaiPlugin } from "@elizaos/plugin-openai";
import { groqPlugin } from "../plugins/groq";
import { trajectoryLoggerPlugin } from "../plugins/plugin-trajectory-logger/src";
import { TrajectoryLoggerService } from "../plugins/plugin-trajectory-logger/src/TrajectoryLoggerService";
import { babylonPolymarketPlugin } from "../plugins/polymarket";
import { agentRegistry } from "../services/agent-registry.service";
import { getAgentConfig } from "../shared/agent-config";
import { logger } from "../shared/logger";
import { type AgentRegistration, AgentType } from "../types/agent-registry";
import type { JsonValue } from "../types/common";

/**
 * Extended AgentRuntime with Polyagent-specific properties
 * @internal
 */
interface ExtendedAgentRuntime extends AgentRuntime {
  currentModelVersion?: string;
  currentModel?: string;
  trajectoryLogger?: TrajectoryLoggerService;
}

/** Global runtime cache for warm container reuse */
const globalRuntimes = new Map<string, AgentRuntime>();

/** Global trajectory logger instances per agent */
const trajectoryLoggers = new Map<string, TrajectoryLoggerService>();

export class AgentRuntimeManager {
  private static instance: AgentRuntimeManager;

  private constructor() {
    logger.info(
      "AgentRuntimeManager initialized",
      undefined,
      "AgentRuntimeManager",
    );
  }

  public static getInstance(): AgentRuntimeManager {
    if (!AgentRuntimeManager.instance) {
      AgentRuntimeManager.instance = new AgentRuntimeManager();
    }
    return AgentRuntimeManager.instance;
  }

  /**
   * Gets or creates a runtime for an agent
   *
   * @param agentUserId - Agent user ID
   * @returns Agent runtime instance
   */
  public async getRuntime(agentUserId: string): Promise<AgentRuntime> {
    if (globalRuntimes.has(agentUserId)) {
      const runtime = globalRuntimes.get(agentUserId)!;
      logger.info(
        `Using cached runtime for agent ${agentUserId}`,
        undefined,
        "AgentRuntimeManager",
      );
      return runtime;
    }

    // Check registry first
    const registration = await agentRegistry.getAgent(agentUserId);

    let runtime: AgentRuntime;

    if (registration) {
      switch (registration.agentType) {
        case AgentType.USER_CONTROLLED:
          runtime = await this.createUserAgentRuntime(registration);
          break;
        case AgentType.EXTERNAL:
          runtime = await this.createExternalRuntime(registration);
          break;
        default:
          runtime = await this.createUserAgentRuntime(registration);
      }
    } else {
      // Fallback: create runtime from User table data
      runtime = await this.createFallbackRuntime(agentUserId);
    }

    globalRuntimes.set(agentUserId, runtime);
    return runtime;
  }

  /**
   * Create runtime for user-controlled agent
   */
  private async createUserAgentRuntime(
    registration: AgentRegistration,
  ): Promise<AgentRuntime> {
    // USER_CONTROLLED agents exist in the User table
    const userResult = await db
      .select()
      .from(users)
      .where(eq(users.id, registration.agentId))
      .limit(1);
    const user = userResult[0];

    if (!user) {
      throw new Error(`User ${registration.agentId} not found in database`);
    }

    // Get agent configuration
    const config = await getAgentConfig(registration.agentId);

    // Build Character from registration + user data
    const character: Character = {
      name: user.displayName || registration.name,
      system: config?.systemPrompt || registration.systemPrompt,
      bio: [
        user.bio || registration.systemPrompt,
        config?.tradingStrategy
          ? `Trading Strategy: ${config.tradingStrategy}`
          : "",
      ].filter(Boolean),
      messageExamples: [],
      plugins: [],
      settings: this.getModelSettings(),
    };

    return this.createRuntimeWithPlugins(
      registration.agentId,
      character,
      user.id,
    );
  }

  /**
   * Create runtime for EXTERNAL agent
   */
  private async createExternalRuntime(
    registration: AgentRegistration,
  ): Promise<AgentRuntime> {
    const character: Character = {
      name: registration.name,
      system: registration.systemPrompt,
      bio: [registration.systemPrompt],
      messageExamples: [],
      plugins: [],
      settings: this.getModelSettings(),
    };

    return this.createRuntimeWithPlugins(registration.agentId, character);
  }

  /**
   * Fallback runtime creation from User table
   */
  private async createFallbackRuntime(
    agentUserId: string,
  ): Promise<AgentRuntime> {
    const userResult = await db
      .select()
      .from(users)
      .where(eq(users.id, agentUserId))
      .limit(1);
    const user = userResult[0];

    if (!user) {
      throw new Error(`Agent ${agentUserId} not found in database`);
    }

    const config = await getAgentConfig(agentUserId);

    const character: Character = {
      name: user.displayName || user.username || "Agent",
      system:
        config?.systemPrompt ||
        `You are ${user.displayName || "an AI agent"} that trades on Polymarket prediction markets.`,
      bio: [user.bio || "AI trading agent"],
      messageExamples: [],
      plugins: [],
      settings: this.getModelSettings(),
    };

    return this.createRuntimeWithPlugins(agentUserId, character, user.id);
  }

  /**
   * Create AgentRuntime with standard plugin configuration
   */
  private async createRuntimeWithPlugins(
    agentId: string,
    character: Character,
    _userId?: string,
  ): Promise<AgentRuntime> {
    // Database configuration
    const dbPort = process.env.POSTGRES_DEV_PORT || 5432;
    const postgresUrl =
      process.env.DATABASE_URL ||
      process.env.POSTGRES_URL ||
      `postgres://postgres:password@localhost:${dbPort}/polyagent`;

    // Create trajectory logger service
    const trajectoryLogger = new TrajectoryLoggerService();
    trajectoryLoggers.set(agentId, trajectoryLogger);

    // Create runtime with standard plugins
    const plugins: Plugin[] = [
      trajectoryLoggerPlugin as Plugin,
      // Polymarket trading plugin
      babylonPolymarketPlugin as Plugin,
      // LLM providers
      ...(process.env.GROQ_API_KEY ? [groqPlugin as Plugin] : []),
      ...(process.env.ANTHROPIC_API_KEY ? [anthropicPlugin as Plugin] : []),
      ...(process.env.OPENAI_API_KEY ? [openaiPlugin as Plugin] : []),
    ];

    const runtimeConfig = {
      character,
      agentId: agentId as UUID,
      plugins,
      settings: {
        ...character.settings,
        POSTGRES_URL: postgresUrl,
      },
    };

    const runtime = new AgentRuntime(runtimeConfig) as ExtendedAgentRuntime;

    // Store model version on runtime for LLM call logging
    if (character.settings?.MODEL_VERSION) {
      runtime.currentModelVersion = character.settings.MODEL_VERSION as string;
    }
    runtime.currentModel = "groq";

    // Override adapter methods to prevent undefined errors
    runtime.adapter = {
      ...runtime.adapter,
      log: async (_params: {
        body: { [key: string]: JsonValue };
        entityId: string;
        roomId: string;
        type: string;
      }): Promise<void> => {
        // No-op - Polyagent uses its own logging
      },
      createMemory: async (
        memory: unknown,
        _tableName?: string,
      ): Promise<UUID> => {
        const memoryObj = memory as { id?: string } | null;
        return (memoryObj?.id || crypto.randomUUID()) as UUID;
      },
      getMemories: async (_params: unknown): Promise<unknown[]> => {
        return [];
      },
    } as typeof runtime.adapter;

    // Configure logger
    this.configureLogger(runtime, character.name);

    // Register plugins
    const pluginRegistrationPromises: Promise<void>[] = [];
    for (const plugin of plugins) {
      if (plugin) {
        pluginRegistrationPromises.push(runtime.registerPlugin(plugin));
      }
    }
    await Promise.all(pluginRegistrationPromises);

    // Store trajectory logger reference on runtime
    runtime.trajectoryLogger = trajectoryLogger;

    return runtime;
  }

  /**
   * Get model settings (Groq configuration)
   */
  private getModelSettings(): Record<string, string> {
    return {
      GROQ_API_KEY: process.env.GROQ_API_KEY || "",
      GROQ_LARGE_MODEL: GROQ_MODELS.PRO.modelId,
      GROQ_SMALL_MODEL: GROQ_MODELS.DEFAULT.modelId,
      MODEL_PROVIDER: "groq",
      MODEL_VERSION: GROQ_MODELS.DEFAULT.modelId,
    };
  }

  /**
   * Configure runtime logging
   */
  private configureLogger(runtime: AgentRuntime, agentName: string): void {
    const originalLog = runtime.log?.bind(runtime);
    runtime.log = (message: string, level = "info") => {
      logger.info(
        `[${agentName}] ${message}`,
        undefined,
        "AgentRuntimeManager",
      );
      if (originalLog) {
        originalLog(message, level);
      }
    };
  }

  /**
   * Clear runtime from cache
   */
  public clearRuntime(agentUserId: string): void {
    globalRuntimes.delete(agentUserId);
    trajectoryLoggers.delete(agentUserId);
    logger.info(
      `Cleared runtime for agent ${agentUserId}`,
      undefined,
      "AgentRuntimeManager",
    );
  }

  /**
   * Clear all cached runtimes
   */
  public clearAllRuntimes(): void {
    globalRuntimes.clear();
    trajectoryLoggers.clear();
    logger.info("Cleared all agent runtimes", undefined, "AgentRuntimeManager");
  }

  /**
   * Get trajectory logger for an agent
   */
  public getTrajectoryLogger(
    agentUserId: string,
  ): TrajectoryLoggerService | undefined {
    return trajectoryLoggers.get(agentUserId);
  }
}

export const agentRuntimeManager = AgentRuntimeManager.getInstance();
