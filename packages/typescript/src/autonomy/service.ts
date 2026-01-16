/**
 * Autonomy Service for elizaOS
 *
 * Provides autonomous operation loop for agents, enabling them to think
 * and act independently without external prompts.
 */

import { v4 as uuidv4 } from "uuid";
import {
  autonomyContinuousContinueTemplate,
  autonomyContinuousFirstTemplate,
  autonomyTaskContinueTemplate,
  autonomyTaskFirstTemplate,
} from "@elizaos/prompts";
import {
  ChannelType,
  type Content,
  type ContentValue,
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
 * AutonomyService - Manages autonomous agent operation
 *
 * This service runs an autonomous loop that triggers agent thinking
 * in a dedicated room context, separate from user conversations.
 */
export class AutonomyService extends Service {
  static serviceType = AUTONOMY_SERVICE_TYPE;
  static serviceName = "Autonomy";

  protected isRunning = false;
  protected isThinking = false; // Guard to prevent overlapping think cycles
  protected loopInterval?: NodeJS.Timeout;
  protected settingsMonitorInterval?: NodeJS.Timeout;
  protected intervalMs: number;
  protected autonomousRoomId: UUID;
  protected autonomousWorldId: UUID;

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
    if (!targetRoomId) return "(no target room configured)";

    const [memoriesTable, messagesTable] = await Promise.all([
      this.runtime.getMemories({
        roomId: targetRoomId,
        count: 15,
        tableName: "memories",
      }),
      this.runtime.getMemories({
        roomId: targetRoomId,
        count: 15,
        tableName: "messages",
      }),
    ]);
    const byId = new Map<string, Memory>();
    for (const m of [...memoriesTable, ...messagesTable]) {
      const id = m.id;
      if (!id) continue;
      const createdAt = m.createdAt ?? 0;
      const existing = byId.get(id);
      if (!existing || createdAt < (existing.createdAt ?? 0)) {
        byId.set(id, m);
      }
    }

    const lines = Array.from(byId.values())
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
      .map((m) => {
        const role = m.entityId === this.runtime.agentId ? "Agent" : "User";
        const text = typeof m.content.text === "string" ? m.content.text : "";
        return `${role}: ${text}`;
      })
      .filter((l) => l.trim().length > 0);

    return lines.length > 0 ? lines.join("\n") : "(no recent messages)";
  }

  constructor() {
    super();
    // Default interval of 30 seconds
    this.intervalMs = 30000;
    // Generate unique room ID for autonomous thoughts
    this.autonomousRoomId = stringToUuid(uuidv4());
    this.autonomousWorldId = stringToUuid(
      "00000000-0000-0000-0000-000000000001",
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
    this.runtime.logger.info(
      { src: "autonomy", agentId: this.runtime.agentId },
      `Using autonomous room ID: ${this.autonomousRoomId}`,
    );

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
        "Autonomy enabled (enableAutonomy: true), starting autonomous loop...",
      );
      await this.startLoop();
    } else {
      this.runtime.logger.info(
        { src: "autonomy", agentId: this.runtime.agentId },
        "Autonomy not enabled (enableAutonomy: false or not set). Set enableAutonomy: true in runtime options to auto-start, or call enableAutonomy() to start manually.",
      );
    }

    // Set up settings monitoring
    this.setupSettingsMonitoring();
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

    // Add agent as participant
    if (this.runtime.addParticipant) {
      await this.runtime.addParticipant(
        this.runtime.agentId,
        this.autonomousRoomId,
      );
    }
    if (this.runtime.ensureParticipantInRoom) {
      await this.runtime.ensureParticipantInRoom(
        this.runtime.agentId,
        this.autonomousRoomId,
      );
    }

    this.runtime.logger.debug(
      { src: "autonomy", agentId: this.runtime.agentId },
      `Ensured autonomous room exists with world ID: ${this.autonomousWorldId}`,
    );
  }

  /**
   * Monitor settings for autonomy state changes
   */
  private setupSettingsMonitoring(): void {
    this.settingsMonitorInterval = setInterval(async () => {
      const shouldBeRunning = this.runtime.enableAutonomy;

      if (shouldBeRunning && !this.isRunning) {
        this.runtime.logger.info(
          { src: "autonomy", agentId: this.runtime.agentId },
          "Runtime indicates autonomy should be enabled, starting...",
        );
        await this.startLoop();
      } else if (!shouldBeRunning && this.isRunning) {
        this.runtime.logger.info(
          { src: "autonomy", agentId: this.runtime.agentId },
          "Runtime indicates autonomy should be disabled, stopping...",
        );
        await this.stopLoop();
      }
    }, 10000); // Check every 10 seconds
  }

  /**
   * Start the autonomous loop
   */
  async startLoop(): Promise<void> {
    if (this.isRunning) {
      this.runtime.logger.debug(
        { src: "autonomy", agentId: this.runtime.agentId },
        "Loop already running",
      );
      return;
    }

    this.isRunning = true;
    this.runtime.enableAutonomy = true;

    this.runtime.logger.info(
      { src: "autonomy", agentId: this.runtime.agentId },
      `Starting autonomous loop (${this.intervalMs}ms interval)`,
    );

    this.scheduleNextThink();
  }

  /**
   * Stop the autonomous loop
   */
  async stopLoop(): Promise<void> {
    if (!this.isRunning) {
      this.runtime.logger.debug(
        { src: "autonomy", agentId: this.runtime.agentId },
        "Loop not running",
      );
      return;
    }

    this.isRunning = false;

    if (this.loopInterval) {
      clearTimeout(this.loopInterval);
      this.loopInterval = undefined;
    }

    this.runtime.enableAutonomy = false;
    this.runtime.logger.info(
      { src: "autonomy", agentId: this.runtime.agentId },
      "Stopped autonomous loop",
    );
  }

  /**
   * Schedule next autonomous thinking iteration
   */
  private scheduleNextThink(): void {
    if (!this.isRunning) {
      return;
    }

    this.loopInterval = setTimeout(async () => {
      // Guard: Skip if previous iteration is still running
      if (this.isThinking) {
        this.runtime.logger.debug(
          { src: "autonomy", agentId: this.runtime.agentId },
          "Previous autonomous think still in progress, skipping this iteration and rescheduling",
        );
        this.scheduleNextThink();
        return;
      }

      // Guard: Don't run if loop was stopped while waiting
      if (!this.isRunning) {
        return;
      }

      this.isThinking = true;
      try {
        await this.performAutonomousThink();
      } finally {
        this.isThinking = false;
      }

      // Only schedule next if still running (could have been stopped during think)
      if (this.isRunning) {
        this.scheduleNextThink();
      }
    }, this.intervalMs);
  }

  /**
   * Check if currently processing an autonomous thought
   */
  isThinkingInProgress(): boolean {
    return this.isThinking;
  }

  /**
   * Perform one iteration of autonomous thinking using the full Eliza agent pipeline.
   * This processes the message through:
   * - All registered providers (context gathering)
   * - The LLM generation pipeline (response creation)
   * - Action processing (executing decided actions)
   * - Evaluators (post-response analysis)
   */
  private async performAutonomousThink(): Promise<void> {
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
        (memory.content.metadata as Record<string, unknown>)?.isAutonomous ===
          true &&
        (memory.content.metadata as Record<string, unknown>)?.type ===
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
    const autonomousMessage: Memory = {
      id: stringToUuid(uuidv4()),
      entityId: agentEntity.id
        ? stringToUuid(String(agentEntity.id))
        : this.runtime.agentId,
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

  // Public API methods

  /**
   * Check if loop is currently running
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
   * Set loop interval (takes effect on next iteration)
   */
  setLoopInterval(ms: number): void {
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
  }

  /**
   * Get the autonomous room ID
   */
  getAutonomousRoomId(): UUID {
    return this.autonomousRoomId;
  }

  /**
   * Enable autonomy
   */
  async enableAutonomy(): Promise<void> {
    this.runtime.enableAutonomy = true;
    if (!this.isRunning) {
      await this.startLoop();
    }
  }

  /**
   * Disable autonomy
   */
  async disableAutonomy(): Promise<void> {
    this.runtime.enableAutonomy = false;
    if (this.isRunning) {
      await this.stopLoop();
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
      thinking: this.isThinking,
      interval: this.intervalMs,
      autonomousRoomId: this.autonomousRoomId,
    };
  }

  /**
   * Stop the service
   */
  async stop(): Promise<void> {
    // Stop the autonomous loop
    await this.stopLoop();

    // Clean up settings monitoring
    if (this.settingsMonitorInterval) {
      clearInterval(this.settingsMonitorInterval);
      this.settingsMonitorInterval = undefined;
    }

    this.runtime.logger.info(
      { src: "autonomy", agentId: this.runtime.agentId },
      "Autonomy service stopped completely",
    );
  }

  get capabilityDescription(): string {
    return "Autonomous operation loop for continuous agent thinking and actions";
  }
}
