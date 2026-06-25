import {
  asUUID,
  ChannelType,
  type Content,
  EventType,
  type IAgentRuntime,
  type Memory,
  Service,
  type UUID,
} from "@elizaos/core";
import { v4 as uuidv4 } from "uuid";
import { logger } from "../../../shared/logger";
import type { JsonValue } from "../../../types/common";
import { AutonomousServiceType } from "./types";

/**
 * Simple autonomous loop service that can be toggled on/off via API
 * Continuously triggers agent thinking in a separate autonomous context
 */
export class AutonomyService extends Service {
  static serviceType = AutonomousServiceType.AUTONOMOUS;
  static serviceName = "Autonomy";

  private isRunning = false;
  private loopInterval?: NodeJS.Timeout;
  private intervalMs = 1000; // Default 1 second for continuous operation
  private autonomousRoomId: UUID; // Dedicated room for autonomous thoughts
  private autonomousWorldId: UUID; // World ID for autonomous context

  constructor(runtime?: IAgentRuntime) {
    super(runtime);
    if (!runtime) {
      throw new Error("AutonomyService requires an agent runtime");
    }
    this.runtime = runtime;

    // Use a dedicated room ID for autonomous thoughts to avoid conflicts
    // This ensures we have a clean room that's not shared with other functionality
    // Generate a proper UUID - ensure it's a valid v4 UUID format
    const roomUUID = uuidv4();
    logger.info("Generated room UUID", { roomUUID }, "AutonomyService");
    this.autonomousRoomId = asUUID(roomUUID);
    this.autonomousWorldId = asUUID("00000000-0000-0000-0000-000000000001"); // Default world

    logger.info(
      "Service initialized with room ID",
      { roomId: this.autonomousRoomId },
      "AutonomyService",
    );
  }

  static async start(runtime: IAgentRuntime): Promise<AutonomyService> {
    const service = new AutonomyService(runtime);
    await service.initialize();
    return service;
  }

  async initialize(): Promise<void> {
    // The autonomous room ID is already set in the constructor
    // Don't override it here

    logger.info(
      "Using autonomous room ID",
      { roomId: this.autonomousRoomId },
      "AutonomyService",
    );

    // Check current autonomy setting
    const autonomyEnabled = this.runtime.getSetting("AUTONOMY_ENABLED");
    const autoStart = this.runtime.getSetting("AUTONOMY_AUTO_START");

    // Ensure the autonomous room exists with proper world context
    const worldId = asUUID("00000000-0000-0000-0000-000000000001"); // Use a fixed world ID for autonomy

    // Only set up world/room if runtime has these methods (not available in test mocks)
    if (this.runtime.ensureWorldExists) {
      await this.runtime.ensureWorldExists({
        id: worldId,
        name: "Autonomy World",
        agentId: this.runtime.agentId,
        // serverId removed in alpha - no longer exists on World type
        metadata: {
          type: "autonomy",
          description: "World for autonomous agent thinking",
        },
      });
    }

    // Store the world ID for later use
    this.autonomousWorldId = worldId;

    // Always ensure room exists with correct world ID
    if (this.runtime.ensureRoomExists) {
      await this.runtime.ensureRoomExists({
        id: this.autonomousRoomId,
        name: "Autonomous Thoughts",
        worldId,
        agentId: this.runtime.agentId,
        source: "autonomy-plugin",
        type: ChannelType.AUTONOMOUS,
        metadata: {
          source: "autonomy-plugin",
          description: "Room for autonomous agent thinking",
          type: "AUTONOMOUS",
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

    logger.info(
      "Ensured autonomous room exists with world ID",
      { worldId: this.autonomousWorldId },
      "AutonomyService",
    );

    logger.info(
      "Settings check",
      { autonomyEnabled, autoStart },
      "AutonomyService",
    );

    // Start disabled by default - autonomy should only run when explicitly enabled from frontend
    if (autonomyEnabled === true || autonomyEnabled === "true") {
      logger.info(
        "Autonomy is enabled in settings, starting...",
        undefined,
        "AutonomyService",
      );
      await this.startLoop();
    } else {
      logger.info(
        "Autonomy disabled by default - will wait for frontend activation",
        undefined,
        "AutonomyService",
      );
    }

    // Set up settings monitoring (check for changes every 10 seconds)
    this.setupSettingsMonitoring();
  }

  /**
   * Monitor settings for changes and react accordingly
   */
  private setupSettingsMonitoring(): void {
    setInterval(async () => {
      const autonomyEnabled = this.runtime.getSetting("AUTONOMY_ENABLED");
      const shouldBeRunning =
        autonomyEnabled === true || autonomyEnabled === "true";

      if (shouldBeRunning && !this.isRunning) {
        logger.info(
          "Settings indicate autonomy should be enabled, starting...",
          undefined,
          "AutonomyService",
        );
        await this.startLoop();
      } else if (!shouldBeRunning && this.isRunning) {
        logger.info(
          "Settings indicate autonomy should be disabled, stopping...",
          undefined,
          "AutonomyService",
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
      logger.info("Loop already running", undefined, "AutonomyService");
      return;
    }

    this.isRunning = true;

    // Set setting to persist state
    this.runtime.setSetting("AUTONOMY_ENABLED", true);

    logger.info(
      "Starting continuous autonomous loop",
      { intervalMs: this.intervalMs },
      "AutonomyService",
    );

    // Start the loop
    this.scheduleNextThink();
  }

  /**
   * Stop the autonomous loop
   */
  async stopLoop(): Promise<void> {
    if (!this.isRunning) {
      logger.info("Loop not running", undefined, "AutonomyService");
      return;
    }

    this.isRunning = false;

    // Clear interval and persist state
    if (this.loopInterval) {
      clearTimeout(this.loopInterval);
      this.loopInterval = undefined;
    }

    this.runtime.setSetting("AUTONOMY_ENABLED", false);
    logger.info("Stopped autonomous loop", undefined, "AutonomyService");
  }

  /**
   * Schedule next autonomous thinking iteration
   */
  private scheduleNextThink(): void {
    if (!this.isRunning) {
      return;
    }

    this.loopInterval = setTimeout(async () => {
      await this.performAutonomousThink();
      // Schedule next iteration if still running
      this.scheduleNextThink();
    }, this.intervalMs);
  }

  /**
   * Perform one iteration of autonomous thinking
   */
  private async performAutonomousThink(): Promise<void> {
    logger.info(
      "Performing autonomous monologue...",
      { time: new Date().toLocaleTimeString() },
      "AutonomyService",
    );

    // Get the agent's entity first - we'll need it throughout this function
    const agentEntity = this.runtime.getEntityById
      ? await this.runtime.getEntityById(this.runtime.agentId)
      : { id: this.runtime.agentId };
    if (!agentEntity) {
      logger.error(
        "Failed to get agent entity, skipping autonomous thought",
        undefined,
        "AutonomyService",
      );
      return;
    }

    // Get the last autonomous thought to continue the internal monologue
    let lastThought: string | undefined;
    let isFirstThought = false;

    // Get recent autonomous memories from this room
    const recentMemories = await this.runtime.getMemories({
      roomId: this.autonomousRoomId,
      count: 3,
      tableName: "memories",
    });

    // Find the most recent agent-generated autonomous thought
    const lastAgentThought = recentMemories
      .filter(
        (m) =>
          m.entityId === agentEntity.id &&
          m.content?.text &&
          m.content?.metadata &&
          (m.content.metadata as Record<string, JsonValue>)?.isAutonomous ===
            true,
      )
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0];

    if (lastAgentThought?.content?.text) {
      lastThought = lastAgentThought.content.text;
      logger.info(
        "Continuing from last thought",
        { thoughtPreview: lastThought.substring(0, 50) },
        "AutonomyService",
      );
    } else {
      isFirstThought = true;
      logger.info(
        "No previous autonomous thoughts found, starting fresh monologue",
        undefined,
        "AutonomyService",
      );
    }

    // Create introspective monologue prompt (not conversational)
    const monologuePrompt = this.createMonologuePrompt(
      lastThought,
      isFirstThought,
    );
    logger.info(
      "Monologue prompt",
      { promptPreview: monologuePrompt.substring(0, 100) },
      "AutonomyService",
    );

    // Create an autonomous message that will be processed through the full agent pipeline
    const autonomousMessage: Memory = {
      id: asUUID(uuidv4()), // Generate unique ID for this autonomous message
      entityId: agentEntity.id ? asUUID(agentEntity.id) : this.runtime.agentId, // Use the agent's entity ID or fallback to agentId
      content: {
        text: monologuePrompt,
        source: "autonomous-trigger",
        metadata: {
          type: "autonomous-prompt",
          isAutonomous: true,
          isInternalThought: true,
          channelId: "autonomous",
          timestamp: Date.now(),
          isContinuation: !isFirstThought,
        },
      },
      roomId: this.autonomousRoomId,
      agentId: this.runtime.agentId,
      createdAt: Date.now(),
    };

    logger.info(
      "Processing autonomous message through full agent pipeline...",
      undefined,
      "AutonomyService",
    );

    // Process the message through the complete agent pipeline
    // This will:
    // 1. Gather context from providers
    // 2. Generate response using the full LLM pipeline
    // 3. Execute any actions the agent decides to take
    // 4. Run evaluators on the result
    // 5. Store memories appropriately
    await this.runtime.emitEvent(EventType.MESSAGE_RECEIVED, {
      runtime: this.runtime,
      source: "plugin-autonomy",
      message: autonomousMessage,
      callback: async (content: Content): Promise<Memory[]> => {
        logger.info(
          "Response generated",
          { responsePreview: content.text?.substring(0, 100) },
          "AutonomyService",
        );

        // Store the response with autonomous metadata
        if (content.text) {
          const responseMemory: Memory = {
            id: asUUID(uuidv4()),
            entityId: agentEntity.id
              ? asUUID(agentEntity.id)
              : this.runtime.agentId, // Use the agent's entity ID from above or fallback to agentId
            agentId: this.runtime.agentId,
            content: {
              text: content.text,
              thought: content.thought,
              actions: content.actions,
              source:
                typeof content.source === "string"
                  ? content.source
                  : "autonomous",
              metadata: {
                ...(typeof content.metadata === "object" &&
                content.metadata !== null
                  ? content.metadata
                  : {}),
                isAutonomous: true,
                isInternalThought: true,
                channelId: "autonomous",
                timestamp: Date.now(),
              },
            },
            roomId: this.autonomousRoomId,
            createdAt: Date.now(),
          };

          // Save the autonomous thought
          await this.runtime.createMemory(responseMemory, "messages");

          // Broadcast the thought to WebSocket clients
          await this.broadcastThoughtToMonologue(
            content.text!,
            responseMemory.id || asUUID(uuidv4()),
          );
        }

        return [];
      },
      onComplete: async () => {
        logger.info(
          "Autonomous message processing completed",
          undefined,
          "AutonomyService",
        );
      },
    });

    logger.info(
      "Autonomous message event emitted to agent pipeline",
      undefined,
      "AutonomyService",
    );
  }
  /**
   * Create an introspective monologue prompt suited for internal thoughts
   */
  private createMonologuePrompt(
    lastThought: string | undefined,
    isFirstThought: boolean,
  ): string {
    if (isFirstThought) {
      return `As an AI agent, reflect on your current state and experiences. What are you thinking about right now? What interests you or concerns you? Share your internal thoughts as a stream of consciousness. Don't address anyone - this is your private monologue.

Generate a thoughtful, introspective response (1-2 sentences):`;
    } else {
      return `Continuing your internal monologue from your last thought: "${lastThought}"

What naturally follows from this thought? What does it make you think about next? Continue your stream of consciousness without addressing anyone - this is your private internal reflection.

Generate your next thought (1-2 sentences):`;
    }
  }

  /**
   * Broadcast autonomous thought to WebSocket clients for real-time monologue display
   */
  private async broadcastThoughtToMonologue(
    thoughtText: string,
    messageId: string,
  ): Promise<void> {
    // Use the correct messaging API endpoint that exists in server.ts
    const apiUrl = "http://localhost:7777/api/messaging/submit";

    const broadcastData = {
      channel_id: this.autonomousRoomId, // Use autonomous room ID as channel
      server_id: "00000000-0000-0000-0000-000000000000",
      author_id: this.runtime.agentId,
      content: thoughtText,
      source_type: "autonomous_thought", // Add missing source_type field
      raw_message: {
        thought: thoughtText,
        actions: [],
      },
      metadata: {
        agentName: this.runtime.character?.name || "ELIZA",
        channelId: "autonomous", // Ensure this matches frontend filter
        isAutonomous: true,
        isInternalThought: true,
        messageId,
        timestamp: Date.now(),
      },
    };

    logger.info(
      "Broadcasting thought to WebSocket",
      { apiUrl },
      "AutonomyService",
    );
    logger.debug("Broadcast data", { broadcastData }, "AutonomyService");

    // Make HTTP request to broadcast endpoint
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(broadcastData),
    });

    if (response.ok) {
      const responseData = await response.json();
      logger.info(
        "Successfully broadcasted thought to monologue chat",
        { responseData },
        "AutonomyService",
      );
    } else {
      const errorText = await response.text();
      logger.warn(
        "Failed to broadcast thought",
        { status: response.status, statusText: response.statusText, errorText },
        "AutonomyService",
      );
    }
  }

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
   * Set loop interval (will take effect on next iteration)
   */
  setLoopInterval(ms: number): void {
    if (ms < 100) {
      logger.warn(
        "Interval too short, minimum is 100ms",
        { requested: ms },
        "AutonomyService",
      );
      ms = 100;
    }
    if (ms > 60000) {
      logger.warn(
        "Interval too long, maximum is 1 minute",
        { requested: ms },
        "AutonomyService",
      );
      ms = 60000;
    }

    this.intervalMs = ms;
    logger.info("Loop interval set", { intervalMs: ms }, "AutonomyService");
  }

  /**
   * Get the autonomous room ID for this agent
   */
  getAutonomousRoomId(): UUID {
    return this.autonomousRoomId;
  }

  /**
   * Enable autonomy (sets setting and starts if needed)
   */
  async enableAutonomy(): Promise<void> {
    this.runtime.setSetting("AUTONOMY_ENABLED", true);
    if (!this.isRunning) {
      await this.startLoop();
    }
  }

  /**
   * Disable autonomy (sets setting and stops if running)
   */
  async disableAutonomy(): Promise<void> {
    this.runtime.setSetting("AUTONOMY_ENABLED", false);
    if (this.isRunning) {
      await this.stopLoop();
    }
  }

  /**
   * Get current autonomy status
   */
  getStatus(): {
    enabled: boolean;
    running: boolean;
    interval: number;
    autonomousRoomId: UUID;
  } {
    const enabled = this.runtime.getSetting("AUTONOMY_ENABLED");
    return {
      enabled: enabled === true || enabled === "true",
      running: this.isRunning,
      interval: this.intervalMs,
      autonomousRoomId: this.autonomousRoomId,
    };
  }

  async stop(): Promise<void> {
    await this.stopLoop();
  }

  get capabilityDescription(): string {
    return "Autonomous loop service for continuous agent thinking and actions";
  }
}
