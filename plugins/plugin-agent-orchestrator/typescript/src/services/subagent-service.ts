import { EventEmitter } from "node:events";
import crypto from "node:crypto";
import {
  type IAgentRuntime,
  type Memory,
  type Metadata,
  type Room,
  type UUID,
  EventType,
  ChannelType,
  Service,
} from "@elizaos/core";
import type { JsonObject } from "@elizaos/core";
import type {
  AgentToAgentPolicy,
  DeliveryContext,
  SendToAgentParams,
  SendToAgentResult,
  SpawnSubagentParams,
  SpawnSubagentResult,
  SubagentConfig,
  SubagentEventPayload,
  SubagentEventType,
  SubagentRoomMetadata,
  SubagentRunOutcome,
  SubagentRunRecord,
} from "../types/subagent.js";
import {
  buildSessionKey,
  createSubagentSessionKey,
  extractAgentIdFromSessionKey,
  formatDurationShort,
  hashToUUID,
  isSubagentSessionKey,
  normalizeAgentId,
  normalizeDeliveryContext,
  parseSessionKey,
  sessionKeyToRoomId,
} from "../utils/session.js";

type InternalEventType = "task" | SubagentEventType;

/**
 * SubagentService manages subagent lifecycles within the Eliza framework.
 *
 * This replaces Otto's gateway-based subagent system with native Eliza
 * events and services. Subagents are represented as rooms with special metadata.
 */
export class SubagentService extends Service {
  static serviceType = "SUBAGENT";
  capabilityDescription = "Manages subagent spawning, lifecycle, and communication";

  private readonly emitter = new EventEmitter();
  private readonly subagentRuns = new Map<string, SubagentRunRecord>();
  private readonly activeRuns = new Map<string, AbortController>();
  private sweeper: NodeJS.Timeout | null = null;
  private initialized = false;

  static async start(runtime: IAgentRuntime): Promise<Service> {
    const service = new SubagentService(runtime);
    await service.initialize();
    return service;
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    this.initialized = true;

    // Register event handlers for run lifecycle
    this.runtime.registerEvent(EventType.RUN_ENDED, async (payload) => {
      await this.handleRunEnded(payload);
    });

    this.runtime.registerEvent(EventType.RUN_TIMEOUT, async (payload) => {
      await this.handleRunTimeout(payload);
    });

    // Start the sweeper for archiving old runs
    this.startSweeper();
  }

  // ============================================================================
  // Configuration
  // ============================================================================

  /**
   * Gets the subagent configuration from character settings.
   */
  getConfig(): SubagentConfig {
    const settings = this.runtime.character?.settings as Record<string, unknown> | undefined;
    const subagents = (settings?.subagents ?? {}) as SubagentConfig;

    return {
      enabled: subagents.enabled !== false, // Enabled by default
      model: subagents.model,
      thinking: subagents.thinking,
      timeoutSeconds: subagents.timeoutSeconds ?? 300, // 5 min default
      allowAgents: subagents.allowAgents ?? [], // Empty = same agent only
      archiveAfterMinutes: subagents.archiveAfterMinutes ?? 60,
    };
  }

  /**
   * Gets the agent-to-agent communication policy.
   */
  getAgentToAgentPolicy(): AgentToAgentPolicy {
    const settings = this.runtime.character?.settings as Record<string, unknown> | undefined;
    const a2aConfig = (settings?.agentToAgent ?? {}) as {
      enabled?: boolean;
      allow?: Array<{ source?: string; target?: string }>;
    };

    const enabled = a2aConfig.enabled === true;
    const allowRules = (a2aConfig.allow ?? []).map((rule) => ({
      source: rule.source ?? "*",
      target: rule.target ?? "*",
    }));

    return {
      enabled,
      allowRules,
      isAllowed: (sourceAgentId: string, targetAgentId: string): boolean => {
        if (!enabled) {
          return false;
        }
        if (sourceAgentId === targetAgentId) {
          return true; // Same agent always allowed
        }
        const sourceNorm = normalizeAgentId(sourceAgentId);
        const targetNorm = normalizeAgentId(targetAgentId);

        for (const rule of allowRules) {
          const sourceMatch = rule.source === "*" || normalizeAgentId(rule.source) === sourceNorm;
          const targetMatch = rule.target === "*" || normalizeAgentId(rule.target) === targetNorm;
          if (sourceMatch && targetMatch) {
            return true;
          }
        }
        return false;
      },
    };
  }

  // ============================================================================
  // Subagent Spawning
  // ============================================================================

  /**
   * Spawns a new subagent to execute a task.
   *
   * Instead of calling the gateway, this creates an Eliza room with special
   * metadata and triggers message processing.
   */
  async spawnSubagent(
    params: SpawnSubagentParams,
    requesterContext: {
      sessionKey?: string;
      roomId?: UUID;
      origin?: DeliveryContext;
    },
  ): Promise<SpawnSubagentResult> {
    const config = this.getConfig();

    if (!config.enabled) {
      return {
        status: "forbidden",
        error: "Subagent spawning is disabled",
      };
    }

    // Check if requester is a subagent (subagents can't spawn subagents)
    if (
      requesterContext.sessionKey &&
      isSubagentSessionKey(requesterContext.sessionKey)
    ) {
      return {
        status: "forbidden",
        error: "sessions_spawn is not allowed from sub-agent sessions",
      };
    }

    // Resolve agent IDs
    const requesterAgentId = requesterContext.sessionKey
      ? extractAgentIdFromSessionKey(requesterContext.sessionKey)
      : this.runtime.character?.name ?? "unknown";

    const targetAgentId = params.agentId
      ? normalizeAgentId(params.agentId)
      : requesterAgentId;

    // Check cross-agent permission
    if (targetAgentId !== requesterAgentId) {
      const allowAgents = config.allowAgents ?? [];
      const allowAny = allowAgents.some((v) => v.trim() === "*");
      const allowSet = new Set(
        allowAgents
          .filter((v) => v.trim() && v.trim() !== "*")
          .map((v) => normalizeAgentId(v)),
      );

      if (!allowAny && !allowSet.has(targetAgentId)) {
        return {
          status: "forbidden",
          error: `agentId "${targetAgentId}" is not allowed for subagent spawning`,
        };
      }
    }

    // Create the subagent session key
    const childSessionKey = createSubagentSessionKey(targetAgentId);
    const runId = crypto.randomUUID();

    // Create a room for the subagent
    const childRoomId = sessionKeyToRoomId(childSessionKey, targetAgentId);

    const roomMetadata: SubagentRoomMetadata = {
      isSubagent: true,
      sessionKey: childSessionKey,
      parentRoomId: requesterContext.roomId,
      parentSessionKey: requesterContext.sessionKey,
      task: params.task,
      label: params.label,
      spawnedAt: Date.now(),
      cleanup: params.cleanup ?? "keep",
    };

    const childRoom: Room = {
      id: childRoomId,
      name: params.label || `Subagent: ${params.task.slice(0, 50)}`,
      type: ChannelType.SELF,
      channelId: childSessionKey,
      agentId: this.runtime.agentId,
      worldId: this.runtime.agentId, // Use agent as world for simplicity
      source: "subagent",
metadata: roomMetadata as unknown as Metadata,
    };

    // Create the room
    await this.runtime.ensureRoomExists(childRoom);

    // Register the subagent run
    const now = Date.now();
    const archiveAfterMs = config.archiveAfterMinutes
      ? config.archiveAfterMinutes * 60_000
      : undefined;

    const record: SubagentRunRecord = {
      runId,
      childSessionKey,
      requesterSessionKey: requesterContext.sessionKey ?? "unknown",
      requesterDisplayKey: requesterContext.sessionKey ?? "main",
      task: params.task,
      cleanup: params.cleanup ?? "keep",
      createdAt: now,
      startedAt: now,
      cleanupHandled: false,
      roomId: childRoomId,
      worldId: this.runtime.agentId,
    };
    const normalizedOrigin = normalizeDeliveryContext(requesterContext.origin);
    if (normalizedOrigin) record.requesterOrigin = normalizedOrigin;
    if (params.label) record.label = params.label;
    if (archiveAfterMs) record.archiveAtMs = now + archiveAfterMs;

    this.subagentRuns.set(runId, record);

    // Emit spawn event, only including defined values
    const spawnPayload: SubagentEventPayload = {
      runId,
      childSessionKey,
      childRoomId,
      task: params.task,
    };
    if (requesterContext.sessionKey) spawnPayload.requesterSessionKey = requesterContext.sessionKey;
    if (requesterContext.roomId) spawnPayload.requesterRoomId = requesterContext.roomId;
    if (params.label) spawnPayload.label = params.label;
    this.emitSubagentEvent("SUBAGENT_SPAWN_REQUESTED", spawnPayload);

    // Build the system prompt for the subagent
    const systemPrompt = this.buildSubagentSystemPrompt({
      requesterSessionKey: requesterContext.sessionKey,
      requesterOrigin: requesterContext.origin,
      childSessionKey,
      label: params.label,
      task: params.task,
    });

    // Build metadata, only including defined values
    const taskMetadata: Record<string, unknown> = {
      isSubagentTask: true,
      runId,
      systemPromptOverride: systemPrompt,
    };
    const modelOverride = params.model || config.model;
    const thinkingOverride = params.thinking || config.thinking;
    if (modelOverride) taskMetadata.modelOverride = modelOverride;
    if (thinkingOverride) taskMetadata.thinkingOverride = thinkingOverride;

    // Create the initial message to kick off the subagent
    const initialMessage: Memory = {
      id: hashToUUID(`${runId}-initial`),
      entityId: this.runtime.agentId,
      agentId: this.runtime.agentId,
      roomId: childRoomId,
      content: {
        text: params.task,
        type: "text",
metadata: taskMetadata as JsonObject,
      },
    };

    // Process the message (this triggers the agent to work on the task)
    // We don't await here - the subagent runs in the background
    this.executeSubagentRun(runId, initialMessage, params.runTimeoutSeconds).catch(
      (error) => {
this.runtime.logger.error({ runId, error }, "Subagent execution error");
        this.handleSubagentError(runId, error);
      },
    );

    return {
      status: "accepted",
      childSessionKey,
      childRoomId,
      runId,
      modelApplied: !!(params.model || config.model),
    };
  }

  /**
   * Executes a subagent run with timeout handling.
   */
  private async executeSubagentRun(
    runId: string,
    initialMessage: Memory,
    timeoutSeconds?: number,
  ): Promise<void> {
    const config = this.getConfig();
    const timeout = (timeoutSeconds ?? config.timeoutSeconds ?? 300) * 1000;

    const controller = new AbortController();
    this.activeRuns.set(runId, controller);

    // Set up timeout
    const timeoutId =
      timeout > 0
        ? setTimeout(() => {
            controller.abort();
            this.handleSubagentTimeout(runId);
          }, timeout)
        : null;

    try {
      // Emit the message for processing
      await this.runtime.emitEvent(EventType.MESSAGE_RECEIVED, {
        runtime: this.runtime,
        message: initialMessage,
        source: "subagent",
      });

      // Wait for completion (the RUN_ENDED event handler will update the record)
      // This is a polling approach - we check the record status
      await this.waitForCompletion(runId, timeout, controller.signal);
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      this.activeRuns.delete(runId);
    }
  }

  /**
   * Waits for a subagent run to complete.
   */
  private async waitForCompletion(
    runId: string,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<void> {
    const startTime = Date.now();
    const pollInterval = 500;

    while (!signal.aborted) {
      const record = this.subagentRuns.get(runId);
      if (!record) {
        return; // Record was deleted
      }
      if (record.endedAt) {
        return; // Completed
      }
      if (Date.now() - startTime > timeoutMs + 5000) {
        return; // Timed out with buffer
      }

      await new Promise<void>((resolve) => setTimeout(resolve, pollInterval));
    }
  }

  /**
   * Handles subagent timeout.
   */
  private handleSubagentTimeout(runId: string): void {
    const record = this.subagentRuns.get(runId);
    if (!record || record.endedAt) {
      return;
    }

    record.endedAt = Date.now();
    record.outcome = { status: "timeout" };

    const timeoutPayload: SubagentEventPayload = {
      runId,
      childSessionKey: record.childSessionKey,
      task: record.task,
      status: "timeout",
    };
    if (record.roomId) timeoutPayload.childRoomId = record.roomId;
    this.emitSubagentEvent("SUBAGENT_RUN_TIMEOUT", timeoutPayload);

    // Trigger announcement
    this.announceSubagentResult(runId).catch((err) => {
this.runtime.logger.error({ runId, error: err }, "Failed to announce timeout");
    });
  }

  /**
   * Handles subagent error.
   */
  private handleSubagentError(runId: string, error: unknown): void {
    const record = this.subagentRuns.get(runId);
    if (!record) {
      return;
    }

    record.endedAt = Date.now();
    record.outcome = {
      status: "error",
      error: error instanceof Error ? error.message : String(error),
    };

    const errorPayload: SubagentEventPayload = {
      runId,
      childSessionKey: record.childSessionKey,
      task: record.task,
      status: "error",
      error: record.outcome.error,
    };
    if (record.roomId) errorPayload.childRoomId = record.roomId;
    this.emitSubagentEvent("SUBAGENT_RUN_FAILED", errorPayload);

    // Trigger announcement
    this.announceSubagentResult(runId).catch((err) => {
this.runtime.logger.error(
        { runId, error: err },
        "Failed to announce error"
      );
    });
  }

  /**
   * Handles the RUN_ENDED event to update subagent records.
   */
  private async handleRunEnded(payload: unknown): Promise<void> {
    const p = payload as { roomId?: UUID; status?: string };
    if (!p.roomId) {
      return;
    }

    // Find the subagent run by room ID
    for (const [runId, record] of this.subagentRuns.entries()) {
      if (record.roomId === p.roomId && !record.endedAt) {
        record.endedAt = Date.now();
        record.outcome = { status: "ok" };

        const completedPayload: SubagentEventPayload = {
          runId,
          childSessionKey: record.childSessionKey,
          childRoomId: record.roomId,
          task: record.task,
          status: "completed",
          endedAt: record.endedAt,
          durationMs: record.endedAt - (record.startedAt ?? record.createdAt),
        };
        if (record.startedAt) completedPayload.startedAt = record.startedAt;
        this.emitSubagentEvent("SUBAGENT_RUN_COMPLETED", completedPayload);

        // Trigger announcement
        await this.announceSubagentResult(runId);
        break;
      }
    }
  }

  /**
   * Handles the RUN_TIMEOUT event.
   */
  private async handleRunTimeout(payload: unknown): Promise<void> {
    const p = payload as { roomId?: UUID };
    if (!p.roomId) {
      return;
    }

    for (const [runId, record] of this.subagentRuns.entries()) {
      if (record.roomId === p.roomId && !record.endedAt) {
        this.handleSubagentTimeout(runId);
        break;
      }
    }
  }

  // ============================================================================
  // Announcement
  // ============================================================================

  /**
   * Announces a subagent's result to the requester.
   */
  private async announceSubagentResult(runId: string): Promise<boolean> {
    const record = this.subagentRuns.get(runId);
    if (!record) {
      return false;
    }

    if (record.cleanupCompletedAt || record.cleanupHandled) {
      return false;
    }

    record.cleanupHandled = true;

    // Get the last assistant reply from the subagent's room
    let reply: string | undefined;
    if (record.roomId) {
      const memories = await this.runtime.getMemories({
        tableName: "messages",
        roomId: record.roomId,
        count: 10,
      });

      // Find the last assistant message
      const lastAssistant = memories
        .filter((m) => m.entityId === this.runtime.agentId)
        .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0];

      reply = lastAssistant?.content?.text;
    }

    // Build stats line
    const durationMs = record.endedAt
      ? record.endedAt - (record.startedAt ?? record.createdAt)
      : undefined;
    const statsLine = `Runtime: ${formatDurationShort(durationMs) ?? "n/a"} • Session: ${record.childSessionKey}`;

    // Build status label
    const outcome = record.outcome ?? { status: "unknown" };
    const statusLabel =
      outcome.status === "ok"
        ? "completed successfully"
        : outcome.status === "timeout"
          ? "timed out"
          : outcome.status === "error"
            ? `failed: ${outcome.error || "unknown error"}`
            : "finished with unknown status";

    // Build announcement message for the main agent
    const taskLabel = record.label || record.task || "background task";
    const triggerMessage = [
      `A background task "${taskLabel}" just ${statusLabel}.`,
      "",
      "Findings:",
      reply || "(no output)",
      "",
      statsLine,
      "",
      "Summarize this naturally for the user. Keep it brief (1-2 sentences).",
      "Do not mention technical details like tokens, stats, or that this was a background task.",
      "You can respond with NO_REPLY if no announcement is needed.",
    ].join("\n");

    // Send to the requester's room
    if (record.requesterSessionKey && record.requesterSessionKey !== "unknown") {
      const requesterRoomId = sessionKeyToRoomId(
        record.requesterSessionKey,
        extractAgentIdFromSessionKey(record.requesterSessionKey),
      );

      // Build metadata, only including defined values
      const metadata: Record<string, unknown> = {
        isSubagentAnnouncement: true,
        subagentRunId: runId,
      };
      if (record.requesterOrigin) {
        metadata.deliveryContext = record.requesterOrigin;
      }

      const announceMessage: Memory = {
        id: hashToUUID(`${runId}-announce`),
        entityId: this.runtime.agentId,
        agentId: this.runtime.agentId,
        roomId: requesterRoomId,
        content: {
          text: triggerMessage,
          type: "text",
metadata: metadata as JsonObject,
        },
      };

      await this.runtime.emitEvent(EventType.MESSAGE_RECEIVED, {
        runtime: this.runtime,
        message: announceMessage,
        source: "subagent_announce",
      });
    }

    const announcePayload: SubagentEventPayload = {
      runId,
      childSessionKey: record.childSessionKey,
      task: record.task,
      outcome,
    };
    if (record.requesterSessionKey) announcePayload.requesterSessionKey = record.requesterSessionKey;
    this.emitSubagentEvent("SUBAGENT_ANNOUNCE_SENT", announcePayload);

    // Handle cleanup
    record.cleanupCompletedAt = Date.now();

    if (record.cleanup === "delete") {
      this.subagentRuns.delete(runId);
    }

    return true;
  }

  /**
   * Builds the system prompt for a subagent.
   */
  private buildSubagentSystemPrompt(params: {
    requesterSessionKey?: string;
    requesterOrigin?: DeliveryContext;
    childSessionKey: string;
    label?: string;
    task?: string;
  }): string {
    const taskText =
      typeof params.task === "string" && params.task.trim()
        ? params.task.replace(/\s+/g, " ").trim()
        : "{{TASK_DESCRIPTION}}";

    const lines = [
      "# Subagent Context",
      "",
      "You are a **subagent** spawned by the main agent for a specific task.",
      "",
      "## Your Role",
      `- You were created to handle: ${taskText}`,
      "- Complete this task. That's your entire purpose.",
      "- You are NOT the main agent. Don't try to be.",
      "",
      "## Rules",
      "1. **Stay focused** - Do your assigned task, nothing else",
      "2. **Complete the task** - Your final message will be automatically reported to the main agent",
      "3. **Don't initiate** - No heartbeats, no proactive actions, no side quests",
      "4. **Be ephemeral** - You may be terminated after task completion. That's fine.",
      "",
      "## Output Format",
      "When complete, your final response should include:",
      "- What you accomplished or found",
      "- Any relevant details the main agent should know",
      "- Keep it concise but informative",
      "",
      "## What You DON'T Do",
      "- NO user conversations (that's main agent's job)",
      "- NO external messages unless explicitly tasked with a specific recipient",
      "- NO cron jobs or persistent state",
      "- NO pretending to be the main agent",
      "",
      "## Session Context",
      params.label ? `- Label: ${params.label}` : undefined,
      params.requesterSessionKey
        ? `- Requester session: ${params.requesterSessionKey}`
        : undefined,
      params.requesterOrigin?.channel
        ? `- Requester channel: ${params.requesterOrigin.channel}`
        : undefined,
      `- Your session: ${params.childSessionKey}`,
      "",
    ].filter((line): line is string => line !== undefined);

    return lines.join("\n");
  }

  // ============================================================================
  // Agent-to-Agent Communication
  // ============================================================================

  /**
   * Sends a message to another agent's session.
   */
  async sendToAgent(
    params: SendToAgentParams,
    requesterContext: {
      sessionKey?: string;
      roomId?: UUID;
    },
  ): Promise<SendToAgentResult> {
    const runId = crypto.randomUUID();
    const policy = this.getAgentToAgentPolicy();

    // Resolve target session
    let targetSessionKey = params.sessionKey;

    if (!targetSessionKey && params.label) {
      // Resolve label to session key by searching subagent runs
      const matchingRun = this.findSubagentRunByLabel(params.label, params.agentId);
      if (matchingRun) {
        targetSessionKey = matchingRun.childSessionKey;
      } else {
        return {
          status: "error",
          runId,
          error: `No subagent found with label "${params.label}"`,
        };
      }
    }

    if (!targetSessionKey) {
      return {
        status: "error",
        runId,
        error: "Either sessionKey or label is required",
      };
    }

    // Check cross-agent permission
    const requesterAgentId = requesterContext.sessionKey
      ? extractAgentIdFromSessionKey(requesterContext.sessionKey)
      : this.runtime.character?.name ?? "unknown";
    const targetAgentId = extractAgentIdFromSessionKey(targetSessionKey);

    if (requesterAgentId !== targetAgentId) {
      if (!policy.enabled) {
        return {
          status: "forbidden",
          runId,
          error:
            "Agent-to-agent messaging is disabled. Set settings.agentToAgent.enabled=true to allow cross-agent sends.",
        };
      }
      if (!policy.isAllowed(requesterAgentId, targetAgentId)) {
        return {
          status: "forbidden",
          runId,
          error: "Agent-to-agent messaging denied by policy.",
        };
      }
    }

    // Get or create the target room
    const targetRoomId = sessionKeyToRoomId(targetSessionKey, targetAgentId);

    // Build context for the message
    const contextMessage = this.buildAgentToAgentContext({
      requesterSessionKey: requesterContext.sessionKey,
      targetSessionKey,
    });

    // Build metadata, only including defined values
    const a2aMetadata: Record<string, unknown> = {
      isAgentToAgent: true,
      runId,
      systemPromptOverride: contextMessage,
    };
    if (requesterContext.sessionKey) a2aMetadata.senderSessionKey = requesterContext.sessionKey;
    if (requesterContext.roomId) a2aMetadata.senderRoomId = requesterContext.roomId;

    // Create and send the message
    const message: Memory = {
      id: hashToUUID(`${runId}-a2a`),
      entityId: this.runtime.agentId,
      agentId: this.runtime.agentId,
      roomId: targetRoomId,
      content: {
        text: params.message,
        type: "text",
metadata: a2aMetadata as JsonObject,
      },
    };

    const timeoutMs = (params.timeoutSeconds ?? 30) * 1000;

    if (params.timeoutSeconds === 0) {
      // Fire and forget
      this.runtime
        .emitEvent(EventType.MESSAGE_RECEIVED, {
          runtime: this.runtime,
          message,
          source: "a2a",
        })
        .catch((err) => {
this.runtime.logger.error({ runId, error: err }, "A2A send error");
        });

      const asyncPayload: SubagentEventPayload = {
        runId,
        childSessionKey: targetSessionKey,
        task: params.message,
      };
      if (requesterContext.sessionKey) asyncPayload.requesterSessionKey = requesterContext.sessionKey;
      this.emitSubagentEvent("A2A_MESSAGE_SENT", asyncPayload);

      return {
        status: "accepted",
        runId,
        sessionKey: targetSessionKey,
        delivery: { status: "pending", mode: "async" },
      };
    }

    // Record the timestamp before sending so we can filter for new responses
    const sentAt = Date.now();

    // Synchronous send with wait
    await this.runtime.emitEvent(EventType.MESSAGE_RECEIVED, {
      runtime: this.runtime,
      message,
      source: "a2a",
    });

    // Poll for a reply that's newer than our sent message
    const pollIntervalMs = 500;
    const maxPolls = Math.ceil(timeoutMs / pollIntervalMs);
    let lastReply: Memory | undefined;

    for (let poll = 0; poll < maxPolls; poll++) {
      await new Promise<void>((r) => setTimeout(r, pollIntervalMs));

      const memories = await this.runtime.getMemories({
        tableName: "messages",
        roomId: targetRoomId,
        count: 10,
      });

      // Find a response that:
      // 1. Is from the agent (not from the user/sender)
      // 2. Was created after we sent our message
      // 3. Is not our own message (check by ID)
      const newReplies = memories.filter(
        (m) =>
          m.entityId === this.runtime.agentId &&
          m.id !== message.id &&
          m.createdAt &&
          m.createdAt > sentAt,
      );

      if (newReplies.length > 0) {
        // Get the most recent reply
        lastReply = newReplies.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0];
        break;
      }
    }

    const syncPayload: SubagentEventPayload = {
      runId,
      childSessionKey: targetSessionKey,
      task: params.message,
    };
    if (requesterContext.sessionKey) syncPayload.requesterSessionKey = requesterContext.sessionKey;
    this.emitSubagentEvent("A2A_MESSAGE_SENT", syncPayload);

    if (!lastReply) {
      return {
        status: "timeout",
        runId,
        sessionKey: targetSessionKey,
        error: `No response received within ${params.timeoutSeconds ?? 30} seconds`,
        delivery: { status: "timeout", mode: "sync" },
      };
    }

    return {
      status: "ok",
      runId,
      sessionKey: targetSessionKey,
      reply: lastReply.content?.text,
      delivery: { status: "delivered", mode: "sync" },
    };
  }

  /**
   * Builds context for agent-to-agent communication.
   */
  private buildAgentToAgentContext(params: {
    requesterSessionKey?: string;
    targetSessionKey: string;
  }): string {
    return [
      "# Agent-to-Agent Message Context",
      "",
      "This message was sent by another agent session.",
      params.requesterSessionKey
        ? `- Sender: ${params.requesterSessionKey}`
        : undefined,
      `- Target: ${params.targetSessionKey}`,
      "",
      "Process this message and respond appropriately.",
    ]
      .filter((l) => l !== undefined)
      .join("\n");
  }

  // ============================================================================
  // Query Methods
  // ============================================================================

  /**
   * Gets a subagent run record by ID.
   */
  getSubagentRun(runId: string): SubagentRunRecord | undefined {
    return this.subagentRuns.get(runId);
  }

  /**
   * Finds a subagent run by its label.
   * 
   * @param label - The label to search for (case-insensitive)
   * @param agentId - Optional agent ID to filter by
   * @returns The matching run record, or undefined if not found
   */
  findSubagentRunByLabel(label: string, agentId?: string): SubagentRunRecord | undefined {
    const normalizedLabel = label.toLowerCase().trim();
    const normalizedAgentId = agentId ? normalizeAgentId(agentId) : undefined;

    for (const run of this.subagentRuns.values()) {
      // Check if label matches
      const runLabel = run.label?.toLowerCase().trim();
      if (runLabel !== normalizedLabel) {
        continue;
      }

      // Check agent ID if specified
      if (normalizedAgentId) {
        const runAgentId = extractAgentIdFromSessionKey(run.childSessionKey);
        if (normalizeAgentId(runAgentId) !== normalizedAgentId) {
          continue;
        }
      }

      // Prefer active runs over completed ones
      if (!run.endedAt) {
        return run;
      }
    }

    // If no active run found, return the most recent completed one with matching label
    const completedRuns = [...this.subagentRuns.values()]
      .filter((run) => {
        const runLabel = run.label?.toLowerCase().trim();
        if (runLabel !== normalizedLabel) {
          return false;
        }
        if (normalizedAgentId) {
          const runAgentId = extractAgentIdFromSessionKey(run.childSessionKey);
          if (normalizeAgentId(runAgentId) !== normalizedAgentId) {
            return false;
          }
        }
        return true;
      })
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));

    return completedRuns[0];
  }

  /**
   * Lists subagent runs for a requester.
   */
  listSubagentRuns(requesterSessionKey?: string): SubagentRunRecord[] {
    const runs = [...this.subagentRuns.values()];
    if (!requesterSessionKey) {
      return runs;
    }
    return runs.filter((r) => r.requesterSessionKey === requesterSessionKey);
  }

  /**
   * Cancels a running subagent.
   */
  cancelSubagentRun(runId: string): boolean {
    const controller = this.activeRuns.get(runId);
    if (controller) {
      controller.abort();
      return true;
    }
    return false;
  }

  // ============================================================================
  // Events
  // ============================================================================

  on(event: InternalEventType, handler: (payload: SubagentEventPayload) => void): void {
    this.emitter.on(event, handler);
  }

  off(event: InternalEventType, handler: (payload: SubagentEventPayload) => void): void {
    this.emitter.off(event, handler);
  }

  private emitSubagentEvent(
    type: SubagentEventType,
    payload: SubagentEventPayload,
  ): void {
    this.emitter.emit(type, payload);
    this.emitter.emit("task", { type, ...payload });
  }

  // ============================================================================
  // Lifecycle
  // ============================================================================

  private startSweeper(): void {
    if (this.sweeper) {
      return;
    }
    this.sweeper = setInterval(() => {
      this.sweepOldRuns();
    }, 60_000);
    this.sweeper.unref?.();
  }

  private sweepOldRuns(): void {
    const now = Date.now();
    for (const [runId, record] of this.subagentRuns.entries()) {
      if (record.archiveAtMs && record.archiveAtMs <= now) {
        this.subagentRuns.delete(runId);
      }
    }
  }

  async stop(): Promise<void> {
    if (this.sweeper) {
      clearInterval(this.sweeper);
      this.sweeper = null;
    }

    // Cancel all active runs
    for (const controller of this.activeRuns.values()) {
      controller.abort();
    }
    this.activeRuns.clear();
    this.emitter.removeAllListeners();
  }
}
