/**
 * Multi-turn conversation test harness with action tracking.
 *
 * Wraps the elizaOS runtime's message handling to simulate user/agent
 * conversations and inspect which actions were invoked at each turn.
 *
 * Usage:
 *   const harness = new ConversationHarness(runtime);
 *   await harness.setup();
 *   const turn = await harness.send("Do something");
 *   expectActionCalled(turn.actions, "SOME_ACTION", { status: "success" });
 */

import crypto from "node:crypto";
import {
  type AgentRuntime,
  ChannelType,
  createMessageMemory,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import {
  type ActionInvocation,
  getActionInvocations,
} from "./action-assertions";
import { sleep, withTimeout } from "./test-utils";

/** A single user-sends / agent-replies exchange with tracked actions. */
export interface ConversationTurn {
  /** What the user sent. */
  text: string;
  /** What the agent replied. */
  responseText: string;
  /** Actions invoked during this turn. */
  actions: ActionInvocation[];
  /** Epoch ms when the turn started. */
  timestamp: number;
}

export interface ConversationHarnessOptions {
  /** Room ID for the conversation. Defaults to a random UUID. */
  roomId?: UUID;
  /** Entity ID representing the test user. Defaults to a random UUID. */
  userId?: UUID;
  /** World ID for the conversation. Defaults to a deterministic UUID from "test-convo-world". */
  worldId?: UUID;
  /** Display name for the test user entity. Defaults to "TestUser". */
  userName?: string;
  /** Default timeout in ms for each send(). Defaults to 90_000. */
  defaultTimeoutMs?: number;
  /** Delay in ms after handleMessage before querying action memories. Defaults to 500. */
  actionSettleMs?: number;
}

/**
 * Simulates multi-turn conversations against a live AgentRuntime and tracks
 * which actions the agent invoked at each turn.
 */
export class ConversationHarness {
  private readonly runtime: AgentRuntime;
  private readonly roomId: UUID;
  private readonly userId: UUID;
  private readonly worldId: UUID;
  private readonly userName: string;
  private readonly defaultTimeoutMs: number;
  private readonly actionSettleMs: number;
  private readonly turns: ConversationTurn[] = [];
  private setupDone = false;

  constructor(runtime: AgentRuntime, opts?: ConversationHarnessOptions) {
    this.runtime = runtime;
    this.roomId = opts?.roomId ?? (crypto.randomUUID() as UUID);
    this.userId = opts?.userId ?? (crypto.randomUUID() as UUID);
    this.worldId = opts?.worldId ?? stringToUuid("test-convo-world");
    this.userName = opts?.userName ?? "TestUser";
    this.defaultTimeoutMs = opts?.defaultTimeoutMs ?? 90_000;
    this.actionSettleMs = opts?.actionSettleMs ?? 500;
  }

  /**
   * Ensure the connection, room, and entity exist in the runtime.
   * Must be called before the first send().
   */
  async setup(): Promise<void> {
    if (!this.runtime.messageService) {
      throw new Error(
        "ConversationHarness: runtime.messageService is null. " +
          "The runtime must be fully initialized with a message service before use.",
      );
    }

    await this.runtime.ensureConnection({
      entityId: this.userId,
      roomId: this.roomId,
      worldId: this.worldId,
      userName: this.userName,
      source: "test",
      channelId: this.roomId,
      type: ChannelType.DM,
    });

    this.setupDone = true;
  }

  /**
   * Send a message as the test user and collect the agent's response and
   * any actions it invoked.
   *
   * @param text - The user message text.
   * @param opts.timeoutMs - Override the default timeout for this turn.
   * @returns The completed ConversationTurn.
   */
  async send(
    text: string,
    opts?: { timeoutMs?: number },
  ): Promise<ConversationTurn> {
    if (!this.setupDone) {
      throw new Error(
        "ConversationHarness: setup() must be called before send().",
      );
    }

    if (!this.runtime.messageService) {
      throw new Error(
        "ConversationHarness: runtime.messageService is null. " +
          "Cannot send messages without a message service.",
      );
    }

    const timeoutMs = opts?.timeoutMs ?? this.defaultTimeoutMs;
    const beforeTimestamp = Date.now();

    const message = createMessageMemory({
      id: crypto.randomUUID() as UUID,
      entityId: this.userId,
      roomId: this.roomId,
      content: {
        text,
        source: "test",
        channelType: ChannelType.DM,
      },
    });

    // Collect response text from the callback and/or the result.
    let responseText = "";
    const result = await withTimeout(
      Promise.resolve(
        this.runtime.messageService.handleMessage(
          this.runtime,
          message,
          async (content: { text?: string }) => {
            if (content.text) responseText += content.text;
            return [];
          },
        ),
      ),
      timeoutMs,
      `ConversationHarness.send("${text.slice(0, 40)}...")`,
    );

    // Fall back to responseContent.text if the callback didn't capture anything.
    if (!responseText && result?.responseContent?.text) {
      responseText = result.responseContent.text;
    }

    // Allow action memories to persist before querying.
    await sleep(this.actionSettleMs);

    // Retrieve action invocations that occurred during this turn.
    const actions = await getActionInvocations(
      this.runtime,
      this.roomId,
      beforeTimestamp,
    );

    const turn: ConversationTurn = {
      text,
      responseText,
      actions,
      timestamp: beforeTimestamp,
    };

    this.turns.push(turn);
    return turn;
  }

  /** Return all turns recorded so far. */
  getTurns(): ConversationTurn[] {
    return [...this.turns];
  }

  /** Return the most recent turn, or undefined if no turns yet. */
  getLastTurn(): ConversationTurn | undefined {
    return this.turns.length > 0
      ? this.turns[this.turns.length - 1]
      : undefined;
  }

  /** The room ID used by this harness. */
  getRoomId(): UUID {
    return this.roomId;
  }

  /** The user entity ID used by this harness. */
  getUserId(): UUID {
    return this.userId;
  }
}
