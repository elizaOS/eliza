/**
 * Autonomy Service for elizaOS
 *
 * Provides autonomous operation for agents using the Task system,
 * enabling them to think and act independently without external prompts.
 *
 * This service uses the unified Task system for scheduling instead of
 * timer-based loops, which provides:
 * - Database persistence (survives restarts)
 * - Blocking mode (prevents overlapping executions)
 * - Unified task management across all periodic operations
 */

import {
  autonomyContinuousContinueTemplate,
  autonomyContinuousFirstTemplate,
  autonomyTaskContinueTemplate,
  autonomyTaskFirstTemplate,
} from "@elizaos/prompts";
import { v4 as uuidv4 } from "uuid";
import {
  ChannelType,
  type Content,
  type ContentValue,
  type Entity,
  EventType,
  type IAgentRuntime,
  type Memory,
  type UUID,
} from "../types";
import { Service } from "../types/service";
import { stringToUuid } from "../utils";
import type { AutonomyStatus } from "./types";

/**
 * Service type constant for autonomy
 */
export const AUTONOMY_SERVICE_TYPE = "AUTONOMY" as const;

/**
 * Task name for autonomy thinking
 */
export const AUTONOMY_TASK_NAME = "AUTONOMY_THINK" as const;

/**
 * Tags used for autonomy tasks
 */
export const AUTONOMY_TASK_TAGS = ["queue", "repeat", "autonomy"] as const;

/** Maximum autonomy entries to keep per table before pruning old ones. */
const MAX_AUTONOMY_ENTRIES = 30;

/** Run memory pruning every N successful think cycles to avoid per-tick overhead. */
const PRUNE_EVERY_N_THINKS = 10;

/** Maximum backoff duration for the circuit breaker (5 minutes). */
const CIRCUIT_BREAKER_MAX_BACKOFF_MS = 300_000;

/**
 * AutonomyService - Manages autonomous agent operation
 *
 * This service uses the Task system to trigger agent thinking
 * in a dedicated room context, separate from user conversations.
 * The task-based approach ensures:
 * - Persistence across restarts
 * - No overlapping executions (blocking mode)
 * - Unified management with other periodic tasks
 */
export class AutonomyService extends Service {
  static serviceType = AUTONOMY_SERVICE_TYPE;
  static serviceName = "Autonomy";

  protected isRunning = false;
  protected intervalMs: number;
  protected autonomousRoomId: UUID;
  protected autonomousWorldId: UUID;
  private taskRegistered = false;
  private isThinking = false;
  protected autonomyEntityId: UUID; // Dedicated entity ID for autonomy prompts (not the agent's ID)

  // Circuit breaker state — backs off exponentially on consecutive failures
  private consecutiveFailures = 0;
  private nextAllowedThinkAt = 0;

  // Pruning counter — triggers cleanup every PRUNE_EVERY_N_THINKS successful cycles
  private thinkCount = 0;

  private getAutonomyMode(): "continuous" | "task" {
    const raw = this.runtime.getSetting("AUTONOMY_MODE");
    if (raw === "task") return "task";
    return "continuous";
  }

  private getTargetRoomId(): UUID | null {
    const raw = this.runtime.getSetting("AUTONOMY_TARGET_ROOM_ID");
    if (typeof raw !== "string" || raw.trim().length === 0) return null;
    try {
      return stringToUuid(raw.trim());
    } catch {
      return null;
    }
  }

  private async getTargetRoomContextText(): Promise<string> {
    const targetRoomId = this.getTargetRoomId();
    const participantRooms = await this.runtime.getRoomsForParticipant(
      this.runtime.agentId,
    );
    const orderedRoomIds: UUID[] = [];
    if (targetRoomId) {
      orderedRoomIds.push(targetRoomId);
    }
    for (const roomId of participantRooms) {
      if (!orderedRoomIds.includes(roomId)) {
        orderedRoomIds.push(roomId);
      }
    }
    if (orderedRoomIds.length === 0) {
      return "(no rooms configured)";
    }

    const rooms = await this.runtime.getRoomsByIds(orderedRoomIds);
    if (!rooms) {
      return "(no rooms found)";
    }

    const roomNameById = new Map<UUID, string>();
    for (const room of rooms) {
      roomNameById.set(room.id, room.name ?? String(room.id));
    }

    const messageRoomIds = orderedRoomIds.filter(
      (roomId) => roomId !== this.autonomousRoomId,
    );
    const perRoomLimit = 10;
    const [messages, autonomyMemories] = await Promise.all([
      messageRoomIds.length > 0
        ? this.runtime.getMemoriesByRoomIds({
            tableName: "messages",
            roomIds: messageRoomIds,
            limit: perRoomLimit * messageRoomIds.length,
          })
        : Promise.resolve([]),
      this.runtime.getMemories({
        roomId: this.autonomousRoomId,
        count: perRoomLimit,
        tableName: "memories",
      }),
    ]);

    const entityIds = new Set<UUID>();
    for (const memory of messages) {
      if (memory.entityId === this.runtime.agentId) {
        continue;
      }
      entityIds.add(memory.entityId);
    }
    const entityNames = await this.buildEntityNameLookup(entityIds);

    const messagesByRoom = new Map<UUID, Memory[]>();
    const dedupedMessages = this.dedupeMemoriesByIdKeepEarliest(messages);
    const sortedMessages = [...dedupedMessages].sort(
      (a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0),
    );
    for (const memory of sortedMessages) {
      if (memory.entityId === this.runtime.agentId) {
        continue;
      }
      const bucket = messagesByRoom.get(memory.roomId) ?? [];
      if (bucket.length >= perRoomLimit) {
        continue;
      }
      bucket.push(memory);
      messagesByRoom.set(memory.roomId, bucket);
    }

    const roomSections = messageRoomIds.map((roomId) => {
      const roomName = roomNameById.get(roomId) ?? String(roomId);
      const roomMessages = messagesByRoom.get(roomId) ?? [];
      if (roomMessages.length === 0) {
        return `Room: ${roomName}\n(no recent messages)`;
      }
      const lines = roomMessages
        .slice()
        .reverse()
        .map((memory) => {
          const author =
            entityNames.get(memory.entityId) ?? String(memory.entityId);
          const text =
            typeof memory.content.text === "string" ? memory.content.text : "";
          return `${author}: ${text}`;
        })
        .filter((line) => line.trim().length > 0);
      return `Room: ${roomName}\n${lines.join("\n")}`;
    });

    const autonomyEntries = autonomyMemories
      .map((memory) => {
        const text =
          typeof memory.content.text === "string" ? memory.content.text : "";
        if (!text.trim()) return "";

        const metadata =
          typeof memory.content.metadata === "object" &&
          memory.content.metadata !== null &&
          !Array.isArray(memory.content.metadata)
            ? (memory.content.metadata as Record<string, ContentValue>)
            : {};
        const type = metadata.type;

        if (
          memory.entityId === this.runtime.agentId &&
          type === "autonomous-response"
        ) {
          return `Thought: ${text}`;
        }
        if (
          memory.entityId === this.autonomyEntityId &&
          type === "autonomous-trigger"
        ) {
          return `Trigger: ${text}`;
        }
        return "";
      })
      .filter((entry) => entry.trim().length > 0);
    const autonomySection =
      autonomyEntries.length > 0
        ? ["Autonomous context:", ...autonomyEntries].join("\n")
        : "Autonomous context: (none)";

    return [...roomSections, autonomySection].join("\n\n");
  }

  private dedupeMemoriesByIdKeepEarliest(memories: Memory[]): Memory[] {
    const byId = new Map<UUID, Memory>();
    const withoutId: Memory[] = [];
    for (const memory of memories) {
      const memoryId = memory.id;
      if (!memoryId) {
        withoutId.push(memory);
        continue;
      }

      const existing = byId.get(memoryId);
      if (!existing) {
        byId.set(memoryId, memory);
        continue;
      }
      if ((memory.createdAt ?? 0) < (existing.createdAt ?? 0)) {
        byId.set(memoryId, memory);
      }
    }
    return [...withoutId, ...byId.values()];
  }

  constructor() {
    super();
    // Default interval of 30 seconds
    this.intervalMs = 30000;
    // Placeholder — overwritten in initialize() with a deterministic ID
    // derived from agentId so memories persist across restarts.
    this.autonomousRoomId = "00000000-0000-0000-0000-000000000000" as UUID;
    this.autonomousWorldId = stringToUuid(
      "00000000-0000-0000-0000-000000000001",
    );
    // Generate a dedicated entity ID for autonomy prompts
    // This is different from the agent's ID to avoid "skipping message from self"
    this.autonomyEntityId = stringToUuid(
      "00000000-0000-0000-0000-000000000002",
    );
  }

  /**
   * Start the autonomy service
   */
  static async start(runtime: IAgentRuntime): Promise<AutonomyService> {
    const service = new AutonomyService();
    service.runtime = runtime;
    await service.initialize();
    return service;
  }

  /**
   * Initialize the service
   */
  private async initialize(): Promise<void> {
    // Derive a deterministic room ID from the agent's ID so autonomy
    // memories survive restarts and orphaned rooms are avoided.
    this.autonomousRoomId = stringToUuid(
      `autonomy-room-${this.runtime.agentId}`,
    );

    this.runtime.logger.info(
      { src: "autonomy", agentId: this.runtime.agentId },
      `Using autonomous room ID: ${this.autonomousRoomId}`,
    );

    // Register the task worker for autonomous thinking
    this.registerAutonomyTaskWorker();

    // Check runtime flag for auto-start
    const autonomyEnabled = this.runtime.enableAutonomy;

    this.runtime.logger.debug(
      { src: "autonomy", agentId: this.runtime.agentId },
      `Runtime enableAutonomy value: ${autonomyEnabled}`,
    );

    // Ensure autonomous world and room exist
    await this.ensureAutonomousContext();

    // Check if autonomy should auto-start based on runtime configuration
    if (autonomyEnabled) {
      this.runtime.logger.info(
        { src: "autonomy", agentId: this.runtime.agentId },
        "Autonomy enabled (enableAutonomy: true), creating autonomy task...",
      );
      await this.createAutonomyTask();
    } else {
      this.runtime.logger.info(
        { src: "autonomy", agentId: this.runtime.agentId },
        "Autonomy not enabled (enableAutonomy: false or not set). Set enableAutonomy: true in runtime options to auto-start, or call enableAutonomy() to start manually.",
      );
    }
  }

  /**
   * Register the task worker for autonomous thinking
   */
  private registerAutonomyTaskWorker(): void {
    if (this.taskRegistered) return;

    this.runtime.registerTaskWorker({
      name: AUTONOMY_TASK_NAME,
      validate: async () => true,
      execute: async (runtime, _options, task) => {
        // ── Circuit breaker: skip if still in backoff period ──────────
        if (Date.now() < this.nextAllowedThinkAt) {
          const remainingMs = this.nextAllowedThinkAt - Date.now();
          this.runtime.logger.warn(
            {
              src: "autonomy",
              agentId: runtime.agentId,
              taskId: task.id,
              remainingMs,
              consecutiveFailures: this.consecutiveFailures,
            },
            "Circuit breaker active, skipping think cycle",
          );
          return;
        }

        const startTime = Date.now();
        this.runtime.logger.debug(
          {
            src: "autonomy",
            agentId: runtime.agentId,
            taskId: task.id,
          },
          "Executing autonomy task",
        );

        try {
          await this.performAutonomousThink();
          const durationMs = Date.now() - startTime;

          // Reset circuit breaker on success
          if (this.consecutiveFailures > 0) {
            this.runtime.logger.info(
              {
                src: "autonomy",
                agentId: runtime.agentId,
                previousFailures: this.consecutiveFailures,
              },
              "Circuit breaker reset after successful think",
            );
          }
          this.consecutiveFailures = 0;
          this.nextAllowedThinkAt = 0;

          // Periodic memory pruning to bound growth
          this.thinkCount++;
          if (this.thinkCount % PRUNE_EVERY_N_THINKS === 0) {
            await this.pruneAutonomyMemories();
          }

          this.runtime.logger.debug(
            {
              src: "autonomy",
              agentId: runtime.agentId,
              taskId: task.id,
              durationMs,
            },
            "Autonomy task completed successfully",
          );
        } catch (error) {
          const durationMs = Date.now() - startTime;
          this.consecutiveFailures++;
          const backoffMs = Math.min(
            this.intervalMs * 2 ** this.consecutiveFailures,
            CIRCUIT_BREAKER_MAX_BACKOFF_MS,
          );
          this.nextAllowedThinkAt = Date.now() + backoffMs;

          this.runtime.logger.error(
            {
              src: "autonomy",
              agentId: runtime.agentId,
              taskId: task.id,
              error: error instanceof Error ? error.message : String(error),
              durationMs,
              consecutiveFailures: this.consecutiveFailures,
              backoffMs,
            },
            `Autonomy task failed, backing off ${Math.round(backoffMs / 1000)}s`,
          );
          // Don't rethrow — the circuit breaker handles retry scheduling.
          // Rethrowing could cause the task system to de-register the task.
        }
      },
    });

    this.taskRegistered = true;
    this.runtime.logger.debug(
      { src: "autonomy", agentId: this.runtime.agentId },
      "Registered autonomy task worker",
    );
  }

  /**
   * Create the recurring autonomy task
   */
  private async createAutonomyTask(): Promise<void> {
    // Clean up any existing autonomy tasks
    const existingTasks = await this.runtime.getTasks({
      tags: [...AUTONOMY_TASK_TAGS],
    });

    for (const task of existingTasks) {
      if (task.id && task.name === AUTONOMY_TASK_NAME) {
        await this.runtime.deleteTask(task.id);
        this.runtime.logger.debug(
          {
            src: "autonomy",
            agentId: this.runtime.agentId,
            taskId: task.id,
          },
          "Removed existing autonomy task",
        );
      }
    }

    // Create the recurring task.
    // updatedAt is set to 0 so the TaskService fires the first tick
    // immediately instead of waiting a full interval.
    await this.runtime.createTask({
      name: AUTONOMY_TASK_NAME,
      description: `Autonomous thinking for agent ${this.runtime.agentId}`,
      worldId: this.autonomousWorldId,
      roomId: this.autonomousRoomId,
      metadata: {
        updatedAt: 0,
        updateInterval: this.intervalMs,
        // Enable blocking to prevent overlapping think cycles
        // This is critical for long-running autonomous operations
        blocking: true,
      },
      tags: [...AUTONOMY_TASK_TAGS],
    });

    this.isRunning = true;
    this.runtime.enableAutonomy = true;

    this.runtime.logger.info(
      {
        src: "autonomy",
        agentId: this.runtime.agentId,
        intervalMs: this.intervalMs,
      },
      `Created autonomy task (interval: ${this.intervalMs}ms)`,
    );
  }

  /**
   * Delete the autonomy task to stop autonomous operation
   */
  private async deleteAutonomyTask(): Promise<void> {
    const existingTasks = await this.runtime.getTasks({
      tags: [...AUTONOMY_TASK_TAGS],
    });

    for (const task of existingTasks) {
      if (task.id && task.name === AUTONOMY_TASK_NAME) {
        await this.runtime.deleteTask(task.id);
        this.runtime.logger.info(
          {
            src: "autonomy",
            agentId: this.runtime.agentId,
            taskId: task.id,
          },
          "Deleted autonomy task",
        );
      }
    }

    this.isRunning = false;
    this.runtime.enableAutonomy = false;
  }

  /**
   * Ensure autonomous world and room exist
   */
  private async ensureAutonomousContext(): Promise<void> {
    // Ensure world exists
    if (this.runtime.ensureWorldExists) {
      await this.runtime.ensureWorldExists({
        id: this.autonomousWorldId,
        name: "Autonomy World",
        agentId: this.runtime.agentId,
        messageServerId: stringToUuid("00000000-0000-0000-0000-000000000000"),
        metadata: {
          type: "autonomy",
          description: "World for autonomous agent thinking",
        },
      });
    }

    // Ensure room exists
    if (this.runtime.ensureRoomExists) {
      await this.runtime.ensureRoomExists({
        id: this.autonomousRoomId,
        name: "Autonomous Thoughts",
        worldId: this.autonomousWorldId,
        source: "autonomy-service",
        type: ChannelType.SELF,
        metadata: {
          source: "autonomy-service",
          description: "Room for autonomous agent thinking",
        },
      });
    }

    // Ensure autonomy entity exists in the database before adding as participant.
    // The participants table has a foreign key on entity_id, so the entity must exist first.
    // IMPORTANT: getEntityById does NOT filter by agentId, but getEntitiesForRoom DOES.
    // If the entity exists from a prior run with a stale agentId, we must update it so the
    // JOIN in getEntitiesForRoom can match it. Without this, formatPosts/formatMessages
    // will fail to resolve the entity and the autonomy prompt context becomes degraded.
    if (this.runtime.getEntityById && this.runtime.createEntity) {
      const existingEntity = await this.runtime.getEntityById(
        this.autonomyEntityId,
      );
      if (!existingEntity) {
        const created = await this.runtime.createEntity({
          id: this.autonomyEntityId,
          names: ["Autonomy"],
          agentId: this.runtime.agentId,
          metadata: {
            type: "autonomy",
            description: "Dedicated entity for autonomy service prompts",
          },
        });
        if (!created) {
          this.runtime.logger.warn(
            { src: "autonomy", agentId: this.runtime.agentId },
            "Failed to create autonomy entity, participant linking may fail",
          );
        }
      } else if (
        existingEntity.agentId !== this.runtime.agentId &&
        this.runtime.updateEntity
      ) {
        // Entity exists but is bound to a different agent — update it so
        // getEntitiesForRoom (which filters by agentId) can find it.
        await this.runtime.updateEntity({
          ...existingEntity,
          agentId: this.runtime.agentId,
        });
      }
    }

    // Ensure both the agent and the autonomy entity are participants in the room.
    if (this.runtime.ensureParticipantInRoom) {
      await this.runtime.ensureParticipantInRoom(
        this.runtime.agentId,
        this.autonomousRoomId,
      );
      await this.runtime.ensureParticipantInRoom(
        this.autonomyEntityId,
        this.autonomousRoomId,
      );
    } else if (this.runtime.addParticipant) {
      await this.runtime.addParticipant(
        this.runtime.agentId,
        this.autonomousRoomId,
      );
      await this.runtime.addParticipant(
        this.autonomyEntityId,
        this.autonomousRoomId,
      );
    }

    this.runtime.logger.debug(
      { src: "autonomy", agentId: this.runtime.agentId },
      `Ensured autonomous room exists with world ID: ${this.autonomousWorldId}`,
    );
  }

  private async buildEntityNameLookup(
    entityIds: Set<UUID>,
  ): Promise<Map<UUID, string>> {
    const entries = await Promise.all(
      Array.from(entityIds).map(async (entityId) => {
        if (!this.runtime.getEntityById) {
          return [entityId, String(entityId)] as const;
        }
        const entity = await this.runtime.getEntityById(entityId);
        return [entityId, this.readEntityName(entity, entityId)] as const;
      }),
    );
    return new Map(entries);
  }

  private readEntityName(entity: Entity | null, entityId: UUID): string {
    if (entity && Array.isArray(entity.names) && entity.names.length > 0) {
      const first = entity.names[0];
      if (typeof first === "string" && first.trim().length > 0) {
        return first;
      }
    }
    return String(entityId);
  }

  /**
   * Perform one iteration of autonomous thinking using the full Eliza agent pipeline.
   * This processes the message through:
   * - All registered providers (context gathering)
   * - The LLM generation pipeline (response creation)
   * - Action processing (executing decided actions)
   * - Evaluators (post-response analysis)
   */
  async performAutonomousThink(): Promise<void> {
    this.runtime.logger.debug(
      { src: "autonomy", agentId: this.runtime.agentId },
      `Performing autonomous thinking... (${new Date().toLocaleTimeString()})`,
    );

    // Get agent entity
    const agentEntity = this.runtime.getEntityById
      ? await this.runtime.getEntityById(this.runtime.agentId)
      : { id: this.runtime.agentId };

    if (!agentEntity) {
      this.runtime.logger.error(
        { src: "autonomy", agentId: this.runtime.agentId },
        "Failed to get agent entity, skipping autonomous thought",
      );
      return;
    }

    // Get recent autonomous memories for context continuation
    let lastThought: string | undefined;
    let isFirstThought = false;

    const recentMemories = await this.runtime.getMemories({
      roomId: this.autonomousRoomId,
      count: 3,
      tableName: "memories",
    });

    let lastAgentThought: Memory | null = null;
    for (const memory of recentMemories) {
      if (
        memory.entityId === agentEntity.id &&
        memory.content?.text &&
        memory.content?.metadata &&
        (memory.content.metadata as Record<string, ContentValue>)
          ?.isAutonomous === true &&
        (memory.content.metadata as Record<string, ContentValue>)?.type ===
          "autonomous-response"
      ) {
        if (
          !lastAgentThought ||
          (memory.createdAt || 0) > (lastAgentThought.createdAt || 0)
        ) {
          lastAgentThought = memory;
        }
      }
    }

    if (lastAgentThought?.content?.text) {
      lastThought = lastAgentThought.content.text;
    } else {
      isFirstThought = true;
    }

    // Create prompt with user context + next-step focus
    const mode = this.getAutonomyMode();
    const targetRoomContext = await this.getTargetRoomContextText();
    const autonomyPrompt =
      mode === "task"
        ? this.createTaskPrompt({
            lastThought,
            isFirstThought,
            targetRoomContext,
          })
        : this.createContinuousPrompt({
            lastThought,
            isFirstThought,
            targetRoomContext,
          });

    // Create the autonomous message for the full agent pipeline
    // Use autonomyEntityId (not agentId) to avoid "skipping message from self"
    const autonomousMessage: Memory = {
      id: stringToUuid(uuidv4()),
      entityId: this.autonomyEntityId,
      content: {
        text: autonomyPrompt,
        source: "autonomy-service",
        metadata: {
          type: "autonomous-prompt",
          isAutonomous: true,
          isInternalThought: true,
          autonomyMode: mode,
          channelId: "autonomous",
          timestamp: Date.now(),
          isContinuation: !isFirstThought,
        },
      },
      roomId: this.autonomousRoomId,
      agentId: this.runtime.agentId,
      createdAt: Date.now(),
    };

    // Persist the autonomous prompt so UIs can show "autonomy logs" even if the agent doesn't respond.
    // Use a distinct ID to avoid clashing with messageService's message memory creation.
    const baseMetadata =
      typeof autonomousMessage.content.metadata === "object" &&
      autonomousMessage.content.metadata !== null &&
      !Array.isArray(autonomousMessage.content.metadata)
        ? (autonomousMessage.content.metadata as Record<string, ContentValue>)
        : {};
    const autonomyLogMemory: Memory = {
      ...autonomousMessage,
      id: stringToUuid(uuidv4()),
      content: {
        ...autonomousMessage.content,
        metadata: {
          ...baseMetadata,
          originalMessageId: autonomousMessage.id,
        },
      },
    };
    try {
      await this.runtime.createMemory(autonomyLogMemory, "memories");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.runtime.logger.warn(
        { src: "autonomy", agentId: this.runtime.agentId, error: msg },
        "Failed to persist autonomous prompt memory",
      );
    }

    // Response callback - the message service handles memory creation
    const callback = async (content: Content): Promise<Memory[]> => {
      this.runtime.logger.debug(
        { src: "autonomy", agentId: this.runtime.agentId },
        `Response generated: ${content.text?.substring(0, 100)}...`,
      );
      // Persist response text for UI log views.
      if (typeof content.text === "string" && content.text.trim().length > 0) {
        const responseMemory: Memory = {
          id: stringToUuid(uuidv4()),
          entityId: this.runtime.agentId,
          agentId: this.runtime.agentId,
          roomId: this.autonomousRoomId,
          createdAt: Date.now(),
          content: {
            text: content.text,
            source: "autonomy-service",
            metadata: {
              type: "autonomous-response",
              isAutonomous: true,
              isInternalThought: true,
              autonomyMode: mode,
              channelId: "autonomous",
              timestamp: Date.now(),
            },
          },
        };
        try {
          await this.runtime.createMemory(responseMemory, "memories");
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.runtime.logger.warn(
            { src: "autonomy", agentId: this.runtime.agentId, error: msg },
            "Failed to persist autonomous response memory",
          );
        }
      }
      // Return empty - the message service handles memory storage
      return [];
    };

    this.runtime.logger.debug(
      { src: "autonomy", agentId: this.runtime.agentId },
      "Processing through full Eliza agent pipeline (providers, actions, evaluators)...",
    );

    // Use the canonical message service if available (full agent pipeline)
    // This ensures: providers gather context, LLM generates response,
    // actions are processed, evaluators run, and memories are stored properly
    if (this.runtime.messageService) {
      try {
        const result = await this.runtime.messageService.handleMessage(
          this.runtime,
          autonomousMessage,
          callback,
        );

        this.runtime.logger.info(
          { src: "autonomy", agentId: this.runtime.agentId },
          `Pipeline complete - responded: ${result.didRespond}, mode: ${result.mode}`,
        );

        if (result.responseContent?.actions?.length) {
          this.runtime.logger.info(
            { src: "autonomy", agentId: this.runtime.agentId },
            `Actions executed: ${result.responseContent.actions.join(", ")}`,
          );
        }
      } catch (error) {
        this.runtime.logger.error(
          { src: "autonomy", agentId: this.runtime.agentId, error },
          "Error in autonomous message processing",
        );
      }
    } else {
      // Fallback to event-based handling for older cores
      this.runtime.logger.warn(
        { src: "autonomy", agentId: this.runtime.agentId },
        "Using event-based fallback (messageService not available)",
      );
      await this.runtime.emitEvent(EventType.MESSAGE_RECEIVED, {
        runtime: this.runtime,
        message: autonomousMessage,
        callback,
        source: "autonomy-service",
      });
    }
  }

  /**
   * Create a continuous autonomous operation prompt
   */
  private createContinuousPrompt(params: {
    lastThought: string | undefined;
    isFirstThought: boolean;
    targetRoomContext: string;
  }): string {
    const template = params.isFirstThought
      ? autonomyContinuousFirstTemplate
      : autonomyContinuousContinueTemplate;
    return this.fillAutonomyTemplate(template, {
      targetRoomContext: params.targetRoomContext,
      lastThought: params.lastThought ?? "",
    });
  }

  private createTaskPrompt(params: {
    lastThought: string | undefined;
    isFirstThought: boolean;
    targetRoomContext: string;
  }): string {
    const template = params.isFirstThought
      ? autonomyTaskFirstTemplate
      : autonomyTaskContinueTemplate;
    return this.fillAutonomyTemplate(template, {
      targetRoomContext: params.targetRoomContext,
      lastThought: params.lastThought ?? "",
    });
  }

  private fillAutonomyTemplate(
    template: string,
    values: { targetRoomContext: string; lastThought: string },
  ): string {
    let output = template.replaceAll(
      "{{targetRoomContext}}",
      values.targetRoomContext,
    );
    output = output.replaceAll("{{lastThought}}", values.lastThought);
    return output;
  }

  /**
   * Prune old autonomy entries to prevent unbounded growth.
   * Keeps the most recent MAX_AUTONOMY_ENTRIES in each table
   * (memories + messages) and deletes the rest.
   */
  private async pruneAutonomyMemories(): Promise<void> {
    for (const tableName of ["memories", "messages"] as const) {
      try {
        const entries = await this.runtime.getMemories({
          roomId: this.autonomousRoomId,
          count: MAX_AUTONOMY_ENTRIES + 50,
          tableName,
        });

        if (entries.length <= MAX_AUTONOMY_ENTRIES) continue;

        // Keep the newest entries, delete the rest
        const sorted = [...entries].sort(
          (a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0),
        );
        const toDelete = sorted.slice(MAX_AUTONOMY_ENTRIES);
        let deleted = 0;

        for (const entry of toDelete) {
          if (entry.id) {
            try {
              await this.runtime.deleteMemory(entry.id);
              deleted++;
            } catch (error) {
              this.runtime.logger.warn(
                {
                  src: "autonomy",
                  agentId: this.runtime.agentId,
                  tableName,
                  entryId: entry.id,
                  error: error instanceof Error ? error.message : String(error),
                },
                "Failed to delete autonomy entry during prune",
              );
            }
          }
        }

        if (deleted > 0) {
          this.runtime.logger.info(
            {
              src: "autonomy",
              agentId: this.runtime.agentId,
              deleted,
              tableName,
              remaining: entries.length - deleted,
            },
            "Pruned old autonomy entries",
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.runtime.logger.warn(
          {
            src: "autonomy",
            agentId: this.runtime.agentId,
            error: msg,
            tableName,
          },
          "Failed to prune autonomy entries",
        );
      }
    }
  }

  // Public API methods

  /**
   * Check if autonomy is currently running
   */
  isLoopRunning(): boolean {
    return this.isRunning;
  }

  /**
   * Get current loop interval in milliseconds
   */
  getLoopInterval(): number {
    return this.intervalMs;
  }

  /**
   * Set loop interval (recreates the task with new interval)
   */
  async setLoopInterval(ms: number): Promise<void> {
    const MIN_INTERVAL = 5000;
    const MAX_INTERVAL = 600000;

    if (ms < MIN_INTERVAL) {
      this.runtime.logger.warn(
        { src: "autonomy", agentId: this.runtime.agentId },
        `Interval too short, minimum is ${MIN_INTERVAL}ms`,
      );
      ms = MIN_INTERVAL;
    }
    if (ms > MAX_INTERVAL) {
      this.runtime.logger.warn(
        { src: "autonomy", agentId: this.runtime.agentId },
        `Interval too long, maximum is ${MAX_INTERVAL}ms`,
      );
      ms = MAX_INTERVAL;
    }

    this.intervalMs = ms;
    this.runtime.logger.info(
      { src: "autonomy", agentId: this.runtime.agentId },
      `Loop interval set to ${ms}ms`,
    );

    // Recreate the task if running
    if (this.isRunning) {
      await this.createAutonomyTask();
    }
  }

  /**
   * Get the autonomous room ID
   */
  getAutonomousRoomId(): UUID {
    return this.autonomousRoomId;
  }

  /**
   * Enable autonomy - creates the recurring task
   */
  async enableAutonomy(): Promise<void> {
    this.runtime.enableAutonomy = true;
    if (!this.isRunning) {
      await this.createAutonomyTask();
    }
  }

  /**
   * Disable autonomy - deletes the recurring task
   */
  async disableAutonomy(): Promise<void> {
    this.runtime.enableAutonomy = false;
    if (this.isRunning) {
      await this.deleteAutonomyTask();
    }
  }

  /**
   * Legacy method names for backwards compatibility
   */
  async startLoop(): Promise<void> {
    await this.enableAutonomy();
  }

  async stopLoop(): Promise<void> {
    await this.disableAutonomy();
  }

  /**
   * Inject an instruction into the autonomous room and optionally wake the loop immediately.
   */
  async injectAutonomousInstruction(params: {
    instructions: string;
    source?: string;
    triggerId?: UUID;
    triggerTaskId?: UUID;
    wakeMode?: "inject_now" | "next_autonomy_cycle";
  }): Promise<UUID> {
    const instructions = params.instructions.trim();
    if (!instructions) {
      throw new Error("Instruction text is required");
    }

    await this.ensureAutonomousContext();

    if (!this.isRunning) {
      await this.enableAutonomy();
    }

    const wakeMode = params.wakeMode ?? "inject_now";
    const timestamp = Date.now();
    const metadata: Record<string, ContentValue> = {
      type: "autonomous-trigger",
      isAutonomous: true,
      isInternalThought: true,
      channelId: "autonomous",
      timestamp,
      wakeMode,
      source: params.source ?? "autonomy-service",
    };
    if (params.triggerId) {
      metadata.triggerId = params.triggerId;
    }
    if (params.triggerTaskId) {
      metadata.triggerTaskId = params.triggerTaskId;
    }

    const memory: Memory = {
      id: stringToUuid(uuidv4()),
      entityId: this.autonomyEntityId,
      agentId: this.runtime.agentId,
      roomId: this.autonomousRoomId,
      createdAt: timestamp,
      content: {
        text: instructions,
        source: params.source ?? "autonomy-service",
        metadata,
      },
    };

    await this.runtime.createMemory(memory, "memories");

    if (wakeMode === "inject_now") {
      await this.triggerThinkNow();
    }

    const createdMemoryId = memory.id;
    if (!createdMemoryId) {
      throw new Error("Autonomy trigger memory ID was not generated");
    }
    return createdMemoryId;
  }

  /**
   * Trigger an autonomous thinking cycle immediately.
   * Useful for testing or manual intervention without waiting for the interval.
   * @returns true if thinking was triggered, false if already thinking or an error occurred
   */
  async triggerThinkNow(): Promise<boolean> {
    if (this.isThinking) {
      this.runtime.logger.info(
        { src: "autonomy", agentId: this.runtime.agentId },
        "Already thinking, skipping manual trigger",
      );
      return false;
    }

    this.runtime.logger.info(
      { src: "autonomy", agentId: this.runtime.agentId },
      "Manually triggered autonomous thinking",
    );

    this.isThinking = true;
    try {
      await this.performAutonomousThink();
      return true;
    } catch (error) {
      this.runtime.logger.error(
        { src: "autonomy", agentId: this.runtime.agentId, error },
        "Error during manually triggered autonomous think",
      );
      return false;
    } finally {
      this.isThinking = false;
    }
  }

  /**
   * Get current autonomy status
   */
  getStatus(): AutonomyStatus {
    const enabled = this.runtime.enableAutonomy;
    return {
      enabled,
      running: this.isRunning,
      thinking: false, // Task system handles blocking
      interval: this.intervalMs,
      autonomousRoomId: this.autonomousRoomId,
    };
  }

  /**
   * Stop the service
   */
  async stop(): Promise<void> {
    // Delete the autonomy task
    await this.deleteAutonomyTask();

    this.runtime.logger.info(
      { src: "autonomy", agentId: this.runtime.agentId },
      "Autonomy service stopped completely",
    );
  }

  get capabilityDescription(): string {
    return "Autonomous operation using Task system for continuous agent thinking and actions";
  }
}
