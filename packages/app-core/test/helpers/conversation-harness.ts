/** Sends messages through a runtime and captures responses plus action calls. */
import crypto from "node:crypto";
import type { AgentRuntime, Memory, UUID } from "@elizaos/core";
import { ChannelType, createMessageMemory, stringToUuid } from "@elizaos/core";
import {
  type ActionSpy,
  type ActionSpyCall,
  createActionSpy,
} from "./action-spy.js";

export interface ConversationTurn {
  text: string;
  responseText: string;
  responses: Memory[];
  actions: ActionSpyCall[];
  startedAt: number;
  durationMs: number;
}

export interface ConversationHarnessOptions {
  roomId?: UUID;
  userId?: UUID;
  worldId?: UUID;
  userName?: string;
  source?: string;
  spy?: ActionSpy;
}

const DEFAULT_TIMEOUT_MS = 120_000;

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

export class ConversationHarness {
  readonly runtime: AgentRuntime;
  readonly spy: ActionSpy;
  readonly roomId: UUID;
  readonly userId: UUID;
  readonly worldId: UUID;
  readonly userName: string;
  readonly source: string;

  private attached = false;
  private readonly turns: ConversationTurn[] = [];

  constructor(runtime: AgentRuntime, opts: ConversationHarnessOptions = {}) {
    this.runtime = runtime;
    this.spy = opts.spy ?? createActionSpy();
    this.roomId = opts.roomId ?? (crypto.randomUUID() as UUID);
    this.userId = opts.userId ?? (crypto.randomUUID() as UUID);
    this.worldId = opts.worldId ?? stringToUuid("conversation-harness-world");
    this.userName = opts.userName ?? "TestUser";
    this.source = opts.source ?? "test";
  }

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
    await this.runtime.ensureParticipantInRoom(this.runtime.agentId, this.roomId);
    await this.runtime.ensureParticipantInRoom(this.userId, this.roomId);
    if (!this.attached) {
      this.spy.attach(this.runtime);
      this.attached = true;
    }
  }

  async send(
    text: string,
    opts?: { timeoutMs?: number },
  ): Promise<ConversationTurn> {
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

    const messageService = (
      this.runtime as unknown as {
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
      opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
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

    // Let completed-action events and memory writes catch up.
    await new Promise((r) => setTimeout(r, 500));

    const allCalls = this.spy.getCalls();
    const actions = allCalls.slice(callsBefore);

    const turn: ConversationTurn = {
      text,
      responseText,
      responses,
      actions,
      startedAt,
      durationMs: Date.now() - startedAt,
    };
    this.turns.push(turn);
    return turn;
  }

  getTurns(): ConversationTurn[] {
    return [...this.turns];
  }

  getLastTurn(): ConversationTurn | undefined {
    return this.turns[this.turns.length - 1];
  }

  async cleanup(): Promise<void> {
    if (this.attached) {
      this.spy.detach(this.runtime);
      this.attached = false;
    }
  }
}
