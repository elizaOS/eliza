import {
  asUUID,
  ChannelType,
  type Content,
  EventType,
  type IAgentRuntime,
  type Memory,
  Service,
  type UUID,
} from '@elizaos/core';
import { v4 as uuidv4 } from 'uuid';
import { AutonomousServiceType } from './types';

/** Minimum interval between autonomous thoughts (5 seconds) */
const MIN_INTERVAL_MS = 5000;
/** Maximum interval between autonomous thoughts (10 minutes) */
const MAX_INTERVAL_MS = 600000;
/** Default interval between autonomous thoughts (30 seconds) */
const DEFAULT_INTERVAL_MS = 30000;

/**
 * Autonomous loop service that can be toggled on/off via API.
 * Continuously triggers agent thinking in a separate autonomous context.
 */
export class AutonomyService extends Service {
  static serviceType = AutonomousServiceType.AUTONOMOUS;
  static serviceName = 'Autonomy';

  private isRunning = false;
  private isThinking = false; // Guard to prevent overlapping think cycles
  private loopInterval?: NodeJS.Timeout;
  private settingsMonitorInterval?: NodeJS.Timeout;
  private intervalMs = DEFAULT_INTERVAL_MS;
  private autonomousRoomId: UUID;
  private autonomousWorldId: UUID;

  constructor(runtime: IAgentRuntime) {
    super();
    this.runtime = runtime;

    // Use a dedicated room ID for autonomous thoughts to avoid conflicts
    // This ensures we have a clean room that's not shared with other functionality
    // Generate a proper UUID - ensure it's a valid v4 UUID format
    const roomUUID = uuidv4();
    console.log('[AUTONOMY] Generated room UUID:', roomUUID);
    this.autonomousRoomId = asUUID(roomUUID);
    this.autonomousWorldId = asUUID('00000000-0000-0000-0000-000000000001'); // Default world

    console.log(
      '[AUTONOMY] Service initialized with room ID:',
      this.autonomousRoomId
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

    console.log(
      `[Autonomy] Using autonomous room ID: ${this.autonomousRoomId}`
    );

    // Check current autonomy setting
    const autonomyEnabled = this.runtime.getSetting('AUTONOMY_ENABLED');
    const autoStart = this.runtime.getSetting('AUTONOMY_AUTO_START');

    // Ensure the autonomous room exists with proper world context
    const worldId = asUUID('00000000-0000-0000-0000-000000000001'); // Use a fixed world ID for autonomy

    // Only set up world/room if runtime has these methods (not available in test mocks)
    if (this.runtime.ensureWorldExists) {
      await this.runtime.ensureWorldExists({
        id: worldId,
        name: 'Autonomy World',
        agentId: this.runtime.agentId,
        serverId: asUUID('00000000-0000-0000-0000-000000000000'), // Default server ID
        metadata: {
          type: 'autonomy',
          description: 'World for autonomous agent thinking',
        },
      });
    }

    // Store the world ID for later use
    this.autonomousWorldId = worldId;

    // Always ensure room exists with correct world ID
    if (this.runtime.ensureRoomExists) {
      await this.runtime.ensureRoomExists({
        id: this.autonomousRoomId,
        name: 'Autonomous Thoughts',
        worldId,
        agentId: this.runtime.agentId,
        source: 'autonomy-plugin',
        type: ChannelType.SELF, // Use SELF channel for private autonomous thoughts
        metadata: {
          source: 'autonomy-plugin',
          description: 'Room for autonomous agent thinking',
          isAutonomous: true,
        },
      });
    }

    // Add agent as participant
    if (this.runtime.addParticipant) {
      await this.runtime.addParticipant(
        this.runtime.agentId,
        this.autonomousRoomId
      );
    }
    if (this.runtime.ensureParticipantInRoom) {
      await this.runtime.ensureParticipantInRoom(
        this.runtime.agentId,
        this.autonomousRoomId
      );
    }

    console.log(
      '[Autonomy] Ensured autonomous room exists with world ID:',
      this.autonomousWorldId
    );

    console.log(
      `[Autonomy] Settings check - AUTONOMY_ENABLED: ${autonomyEnabled}, AUTONOMY_AUTO_START: ${autoStart}`
    );

    // Start disabled by default - autonomy should only run when explicitly enabled from frontend
    if (autonomyEnabled === true || autonomyEnabled === 'true') {
      console.log('[Autonomy] Autonomy is enabled in settings, starting...');
      await this.startLoop();
    } else {
      console.log(
        '[Autonomy] Autonomy disabled by default - will wait for frontend activation'
      );
    }

    // Set up settings monitoring (check for changes every 10 seconds)
    this.setupSettingsMonitoring();
  }

  /**
   * Monitor settings for changes and react accordingly
   */
  private setupSettingsMonitoring(): void {
    this.settingsMonitorInterval = setInterval(async () => {
      const autonomyEnabled = this.runtime.getSetting('AUTONOMY_ENABLED');
      const shouldBeRunning =
        autonomyEnabled === true || autonomyEnabled === 'true';

      if (shouldBeRunning && !this.isRunning) {
        console.log(
          '[Autonomy] Settings indicate autonomy should be enabled, starting...'
        );
        await this.startLoop();
      } else if (!shouldBeRunning && this.isRunning) {
        console.log(
          '[Autonomy] Settings indicate autonomy should be disabled, stopping...'
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
      console.log('[Autonomy] Loop already running');
      return;
    }

    this.isRunning = true;

    // Set setting to persist state
    this.runtime.setSetting('AUTONOMY_ENABLED', true);

    console.log(
      `[Autonomy] Starting continuous autonomous loop (${this.intervalMs}ms delay between iterations)`
    );

    // Start the loop
    this.scheduleNextThink();
  }

  /**
   * Stop the autonomous loop
   */
  async stopLoop(): Promise<void> {
    if (!this.isRunning) {
      console.log('[Autonomy] Loop not running');
      return;
    }

    this.isRunning = false;

    // Clear interval and persist state
    if (this.loopInterval) {
      clearTimeout(this.loopInterval);
      this.loopInterval = undefined;
    }

    this.runtime.setSetting('AUTONOMY_ENABLED', false);
    console.log('[Autonomy] Stopped autonomous loop');
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
        console.log(
          '[Autonomy] Previous think cycle still in progress, skipping this iteration'
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
   * Perform one iteration of autonomous thinking
   */
  private async performAutonomousThink(): Promise<void> {
    console.log(
      `[Autonomy] Performing autonomous monologue... (${new Date().toLocaleTimeString()})`
    );

    // Get the agent's entity first - we'll need it throughout this function
    const agentEntity = this.runtime.getEntityById
      ? await this.runtime.getEntityById(this.runtime.agentId)
      : { id: this.runtime.agentId };
    if (!agentEntity) {
      console.error(
        '[Autonomy] Failed to get agent entity, skipping autonomous thought'
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
      tableName: 'memories',
    });

    // Find the most recent agent-generated autonomous thought
    const lastAgentThought = recentMemories
      .filter(
        (m) =>
          m.entityId === agentEntity.id &&
          m.content?.text &&
          m.content?.metadata &&
          (m.content.metadata as Record<string, unknown>)?.isAutonomous === true
      )
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0];

    if (lastAgentThought?.content?.text) {
      lastThought = lastAgentThought.content.text;
      console.log(
        `[Autonomy] Continuing from last thought: "${lastThought.substring(0, 50)}..."`
      );
    } else {
      isFirstThought = true;
      console.log(
        '[Autonomy] No previous autonomous thoughts found, starting fresh monologue'
      );
    }

    // Create introspective monologue prompt (not conversational)
    const monologuePrompt = this.createMonologuePrompt(
      lastThought,
      isFirstThought
    );
    console.log(
      `[Autonomy] Monologue prompt: "${monologuePrompt.substring(0, 100)}..."`
    );

    // Create an autonomous message that will be processed through the full agent pipeline
    const autonomousMessage: Memory = {
      id: asUUID(uuidv4()), // Generate unique ID for this autonomous message
      entityId: agentEntity.id ? asUUID(agentEntity.id) : this.runtime.agentId, // Use the agent's entity ID or fallback to agentId
      content: {
        text: monologuePrompt,
        source: 'autonomous-trigger',
        metadata: {
          type: 'autonomous-prompt',
          isAutonomous: true,
          isInternalThought: true,
          channelId: 'autonomous',
          timestamp: Date.now(),
          isContinuation: !isFirstThought,
        },
      },
      roomId: this.autonomousRoomId,
      agentId: this.runtime.agentId,
      createdAt: Date.now(),
    };

    console.log(
      '[Autonomy] Processing autonomous message through full agent pipeline...'
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
      message: autonomousMessage,
      callback: async (content: Content) => {
        console.log(
          '[Autonomy] Response generated:',
          `${content.text?.substring(0, 100)}...`
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
                typeof content.source === 'string'
                  ? content.source
                  : 'autonomous',
              metadata: {
                ...(typeof content.metadata === 'object' &&
                content.metadata !== null
                  ? content.metadata
                  : {}),
                isAutonomous: true,
                isInternalThought: true,
                channelId: 'autonomous',
                timestamp: Date.now(),
              },
            },
            roomId: this.autonomousRoomId,
            createdAt: Date.now(),
          };

          // Save the autonomous thought
          await this.runtime.createMemory(responseMemory, 'messages');

          // Broadcast the thought to WebSocket clients
          await this.broadcastThoughtToMonologue(
            content.text!,
            responseMemory.id || asUUID(uuidv4())
          );
        }
      },
      onComplete: async () => {
        console.log('[Autonomy] ✅ Autonomous message processing completed');
      },
    });

    console.log(
      '[Autonomy] ✅ Autonomous message event emitted to agent pipeline'
    );
  }
  /**
   * Create an introspective monologue prompt suited for internal thoughts
   */
  private createMonologuePrompt(
    lastThought: string | undefined,
    isFirstThought: boolean
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
   * Broadcast autonomous thought to WebSocket clients for real-time monologue display.
   * This is optional - only broadcasts if AUTONOMY_BROADCAST_URL is configured.
   */
  private async broadcastThoughtToMonologue(
    thoughtText: string,
    messageId: string
  ): Promise<void> {
    // Check if broadcasting is enabled
    const broadcastUrl = this.runtime.getSetting('AUTONOMY_BROADCAST_URL');
    if (!broadcastUrl || typeof broadcastUrl !== 'string') {
      // Broadcasting not configured - this is fine, thoughts are still stored in memory
      return;
    }

    const broadcastData = {
      channel_id: this.autonomousRoomId,
      server_id: '00000000-0000-0000-0000-000000000000',
      author_id: this.runtime.agentId,
      content: thoughtText,
      source_type: 'autonomous_thought',
      raw_message: {
        thought: thoughtText,
        actions: [],
      },
      metadata: {
        agentName: this.runtime.character?.name || 'Agent',
        channelId: 'autonomous',
        isAutonomous: true,
        isInternalThought: true,
        messageId,
        timestamp: Date.now(),
      },
    };

    try {
      const response = await fetch(broadcastUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(broadcastData),
      });

      if (!response.ok) {
        console.warn(
          `[Autonomy] Failed to broadcast thought: ${response.status} ${response.statusText}`
        );
      }
    } catch (error) {
      // Don't fail the whole autonomy cycle if broadcast fails
      console.warn('[Autonomy] Broadcast error (non-fatal):', error);
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
    if (ms < MIN_INTERVAL_MS) {
      console.warn(
        `[Autonomy] Interval too short, minimum is ${MIN_INTERVAL_MS}ms (5 seconds)`
      );
      ms = MIN_INTERVAL_MS;
    }
    if (ms > MAX_INTERVAL_MS) {
      console.warn(
        `[Autonomy] Interval too long, maximum is ${MAX_INTERVAL_MS}ms (10 minutes)`
      );
      ms = MAX_INTERVAL_MS;
    }

    this.intervalMs = ms;
    console.log(`[Autonomy] Loop interval set to ${ms}ms`);
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
    this.runtime.setSetting('AUTONOMY_ENABLED', true);
    if (!this.isRunning) {
      await this.startLoop();
    }
  }

  /**
   * Disable autonomy (sets setting and stops if running)
   */
  async disableAutonomy(): Promise<void> {
    this.runtime.setSetting('AUTONOMY_ENABLED', false);
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
    thinking: boolean;
    interval: number;
    autonomousRoomId: UUID;
  } {
    const enabled = this.runtime.getSetting('AUTONOMY_ENABLED');
    return {
      enabled: enabled === true || enabled === 'true',
      running: this.isRunning,
      thinking: this.isThinking,
      interval: this.intervalMs,
      autonomousRoomId: this.autonomousRoomId,
    };
  }

  async stop(): Promise<void> {
    // Stop the autonomous loop
    await this.stopLoop();

    // Clean up settings monitoring
    if (this.settingsMonitorInterval) {
      clearInterval(this.settingsMonitorInterval);
      this.settingsMonitorInterval = undefined;
    }

    console.log('[Autonomy] Service stopped completely');
  }

  get capabilityDescription(): string {
    return 'Autonomous loop service for continuous agent thinking and actions';
  }
}
