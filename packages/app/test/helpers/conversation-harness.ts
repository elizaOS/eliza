/**
 * Multi-turn conversation test harness with action tracking.
 *
 * Wraps the elizaOS runtime's message handling to simulate user/agent
 * conversations and inspect which actions were invoked at each turn. Action
 * tracking is event-bus based (`ActionSpy`); see `action-spy.ts`.
 *
 * @example
 * ```ts
 * const harness = new ConversationHarness(runtime);
 * await harness.setup();
 * const turn = await harness.send("Do something");
 * expectActionCalled(harness.spy, "SOME_ACTION");
 * await harness.cleanup();
 * ```
 */
import crypto from "node:crypto";
import type {
  AgentRuntime,
  Memory,
  MessageMetadata,
  UUID,
} from "@elizaos/core";
import { ChannelType, createMessageMemory } from "@elizaos/core";
import {
  type ActionSpy,
  type ActionSpyCall,
  createActionSpy,
} from "./action-spy.js";

/** A single user-sends / agent-replies exchange with tracked actions. */
export interface ConversationTurn {
  /** What the user sent. */
  text: string;
  /** What the agent replied. */
  responseText: string;
  /** Agent response messages, when the message service surfaces them. */
  responses: Memory[];
  /** Action calls (started + completed) captured during this turn. */
  actions: ActionSpyCall[];
  /** Epoch ms when the turn began. */
  startedAt: number;
  /** Alias of `startedAt` for callers that used the older field name. */
  timestamp: number;
  /** Wall-clock duration of the turn in ms. */
  durationMs: number;
}

export interface ConversationHarnessOptions {
  roomId?: UUID;
  userId?: UUID;
  worldId?: UUID;
  userName?: string;
  /** Source tag for created messages. Defaults to "test". */
  source?: string;
  /** Pre-built `ActionSpy`. If omitted, a fresh one is created and room-filtered. */
  spy?: ActionSpy;
  /** Default timeout in ms for each `send()`. Defaults to 120_000. */
  defaultTimeoutMs?: number;
  /**
   * Override the action-settle idle window in ms. When set, `send()` waits
   * this many ms after the message handler resolves rather than polling the
   * spy until events stop arriving. Useful for deterministic tests against
   * mock runtimes that emit synchronously.
   */
  actionSettleMs?: number;
}

export interface ConversationSendOptions {
  timeoutMs?: number;
  metadata?: Partial<MessageMetadata>;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const ACTION_SETTLE_MIN_MS = 1_000;
const ACTION_SETTLE_MAX_MS = 5_000;
const ACTION_SETTLE_IDLE_MS = 400;
const ACTION_SETTLE_POLL_MS = 100;

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(t);
        resolve(value);
      },
      (err) => {
        clearTimeout(t);
        reject(err);
      },
    );
  });
}

/**
 * Polls the spy until no new events have arrived for `ACTION_SETTLE_IDLE_MS`
 * (or until `ACTION_SETTLE_MAX_MS` elapses). Action events and follow-up
 * callbacks can land slightly after `handleMessage` resolves, especially
 * under Vitest workers.
 */
async function waitForActionSettle(spy: ActionSpy): Promise<void> {
  const startedAt = Date.now();
  const deadline = startedAt + ACTION_SETTLE_MAX_MS;
  let lastCount = spy.getCalls().length;
  let lastChangeAt = startedAt;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, ACTION_SETTLE_POLL_MS));

    const currentCount = spy.getCalls().length;
    if (currentCount !== lastCount) {
      lastCount = currentCount;
      lastChangeAt = Date.now();
      continue;
    }

    const minWaitElapsed = Date.now() - startedAt >= ACTION_SETTLE_MIN_MS;
    const idleElapsed = Date.now() - lastChangeAt >= ACTION_SETTLE_IDLE_MS;
    if (minWaitElapsed && idleElapsed) {
      return;
    }
  }
}

export class ConversationHarness {
  readonly runtime: AgentRuntime;
  readonly spy: ActionSpy;
  readonly roomId: UUID;
  readonly userId: UUID;
  readonly worldId: UUID;
  readonly userName: string;
  readonly source: string;

  private attached = false;
  private setupDone = false;
  private readonly turns: ConversationTurn[] = [];
  private readonly defaultTimeoutMs: number;
  private readonly fixedSettleMs: number | null;

  constructor(runtime: AgentRuntime, opts: ConversationHarnessOptions = {}) {
    this.runtime = runtime;
    this.roomId = opts.roomId ?? (crypto.randomUUID() as UUID);
    this.userId = opts.userId ?? (crypto.randomUUID() as UUID);
    this.worldId = opts.worldId ?? (crypto.randomUUID() as UUID);
    this.userName = opts.userName ?? "TestUser";
    this.source = opts.source ?? "test";
    this.spy = opts.spy ?? createActionSpy();
    this.spy.setRoomFilter(this.roomId);
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fixedSettleMs = opts.actionSettleMs ?? null;
  }

  /**
   * Ensure the world, connection, and participants exist on the runtime, and
   * attach the action spy. Must be called before `send()`.
   */
  async setup(): Promise<void> {
    const worldMetadata = {
      ownership: {
        ownerId: this.userId,
      },
      roles: {
        [this.userId]: "OWNER",
      },
    } as const;

    await this.runtime.ensureWorldExists({
      id: this.worldId,
      name: `${this.userName}'s World`,
      agentId: this.runtime.agentId,
      messageServerId: this.userId,
      metadata: worldMetadata,
    } as Parameters<typeof this.runtime.ensureWorldExists>[0]);

    await this.runtime.ensureConnection({
      entityId: this.userId,
      roomId: this.roomId,
      worldId: this.worldId,
      worldName: `${this.userName}'s World`,
      userName: this.userName,
      name: this.userName,
      source: this.source,
      channelId: this.roomId,
      type: ChannelType.DM,
      messageServerId: this.userId,
      metadata: worldMetadata,
    });
    await this.runtime.ensureParticipantInRoom(
      this.runtime.agentId,
      this.roomId,
    );
    await this.runtime.ensureParticipantInRoom(this.userId, this.roomId);
    if (!this.attached) {
      this.spy.attach(this.runtime);
      this.attached = true;
    }
    this.setupDone = true;
  }

  /**
   * Send a message as the test user and collect the agent's response and
   * any actions invoked during this turn.
   */
  async send(
    text: string,
    opts?: ConversationSendOptions,
  ): Promise<ConversationTurn> {
    if (!this.setupDone) {
      throw new Error(
        "ConversationHarness: setup() must be called before send().",
      );
    }
    const startedAt = Date.now();
    let responseText = "";
    const callsBefore = this.spy.getCalls().length;

    const message = createMessageMemory({
      id: crypto.randomUUID() as UUID,
      entityId: this.userId,
      roomId: this.roomId,
      content: {
        text,
        source: this.source,
        channelType: ChannelType.DM,
      },
    });
    if (opts?.metadata) {
      message.metadata = {
        ...message.metadata,
        ...opts.metadata,
      };
    }

    const messageService = (
      this.runtime as AgentRuntime & {
        messageService?: {
          handleMessage: (
            runtime: AgentRuntime,
            message: Memory,
            callback: (content: { text?: string }) => Promise<unknown>,
            options?: Record<string, unknown>,
          ) => Promise<{
            responseContent?: { text?: string };
            responseMessages?: Memory[];
          }>;
        };
      }
    ).messageService;

    if (!messageService) {
      throw new Error(
        "ConversationHarness: runtime.messageService is unavailable; cannot send messages",
      );
    }

    const responses: Memory[] = [];
    const callback = async (content: { text?: string }) => {
      if (content.text) responseText += content.text;
      return [];
    };

    const result = await withTimeout(
      messageService.handleMessage(this.runtime, message, callback, {}),
      opts?.timeoutMs ?? this.defaultTimeoutMs,
      "ConversationHarness.send",
    );

    if (!responseText && result?.responseContent?.text) {
      responseText = result.responseContent.text;
    }
    if (result?.responseMessages) {
      for (const m of result.responseMessages) {
        responses.push(m);
      }
    }

    if (this.fixedSettleMs !== null) {
      await new Promise((resolve) => setTimeout(resolve, this.fixedSettleMs));
    } else {
      await waitForActionSettle(this.spy);
    }

    const allCalls = this.spy.getCalls();
    const actions = allCalls.slice(callsBefore);

    const turn: ConversationTurn = {
      text,
      responseText,
      responses,
      actions,
      startedAt,
      timestamp: startedAt,
      durationMs: Date.now() - startedAt,
    };
    this.turns.push(turn);
    return turn;
  }

  /** All turns recorded so far. */
  getTurns(): ConversationTurn[] {
    return [...this.turns];
  }

  /** The most recent turn, or undefined if no turns yet. */
  getLastTurn(): ConversationTurn | undefined {
    return this.turns[this.turns.length - 1];
  }

  /** Room id used by this harness. */
  getRoomId(): UUID {
    return this.roomId;
  }

  /** User entity id used by this harness. */
  getUserId(): UUID {
    return this.userId;
  }

  /** Detach the spy and release runtime hooks. Safe to call repeatedly. */
  async cleanup(): Promise<void> {
    if (this.attached) {
      this.spy.detach(this.runtime);
      this.attached = false;
    }
  }
}
