/**
 * Inbound m.replace edits must correct the stored original instead of being
 * dispatched as a new message carrying the "* " fallback body (#31766), apply
 * at most once per edit event, bypass the group mention gate, and wait for an
 * original whose persist is still in flight. Deterministic: real
 * setupEventHandlers/handleRoomMessage over an in-memory event-emitter client
 * and a recording runtime with a Map-backed memory store; no homeserver, no model.
 */
import { EventEmitter } from "node:events";
import { createUniqueUuid, type IAgentRuntime, type Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { MatrixService } from "../service.js";

const ROOM = "!ops:example";
const BOT = "@bot:example";
const ALICE = "@alice:example";

function fakeEvent(id: string, content: Record<string, unknown>) {
  return {
    getContent: () => content,
    getSender: () => ALICE,
    getType: () => "m.room.message",
    getRoomId: () => ROOM,
    getId: () => id,
    getTs: () => 1_700_000_000_000,
    isEncrypted: () => false,
    isDecryptionFailure: () => false,
    once: () => undefined,
  };
}

function editOf(id: string, original: string, text: string) {
  return fakeEvent(id, {
    msgtype: "m.text",
    body: `* ${text}`,
    "m.new_content": { msgtype: "m.text", body: text },
    "m.relates_to": { rel_type: "m.replace", event_id: original },
  });
}

type HarnessOptions = {
  memberCount?: number;
  requireMention?: boolean;
  persistDelayMs?: number;
};

function harness(options: HarnessOptions = {}) {
  const memberCount = options.memberCount ?? 2;
  const fakeRoom = {
    name: "ops",
    roomId: ROOM,
    getMember: () => ({ name: "alice", getMxcAvatarUrl: () => undefined }),
    getJoinedMemberCount: () => memberCount,
    currentState: { getStateEvents: () => undefined },
    getCanonicalAlias: () => null,
    hasEncryptionStateEvent: () => false,
  };
  const client = Object.assign(new EventEmitter(), {
    getAccountData: () => undefined,
    getCrypto: () => undefined,
  });
  const store = new Map<string, Memory>();
  const runtime = {
    agentId: "00000000-0000-0000-0000-000000000001",
    emitEvent: vi.fn(async () => undefined),
    ensureConnection: vi.fn(async () => undefined),
    createMemory: vi.fn(async (memory: Memory) => {
      if (options.persistDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.persistDelayMs));
      }
      store.set(memory.id as string, memory);
      return memory.id;
    }),
    getMemoryById: vi.fn(async (id: string) => store.get(id) ?? null),
    updateMemory: vi.fn(async (patch: { id: string; content: Memory["content"] }) => {
      const existing = store.get(patch.id);
      if (existing) store.set(patch.id, { ...existing, content: patch.content });
      return true;
    }),
    reportError: vi.fn(),
    getSetting: vi.fn(() => undefined),
    messageService: { handleMessage: vi.fn(async () => undefined) },
  };
  const service = Object.create(MatrixService.prototype) as MatrixService;
  Object.assign(service, {
    runtime: runtime as unknown as IAgentRuntime,
    defaultAccountId: "work",
  });
  const state = {
    accountId: "work",
    settings: {
      userId: BOT,
      autoJoin: false,
      verifyAllowlist: [],
      requireMention: options.requireMention ?? false,
      rooms: [],
    },
    client,
    connected: true,
    syncing: true,
    appliedEditIds: new Set<string>(),
    pendingDispatches: new Map<string, Promise<void>>(),
  };
  (service as unknown as { setupEventHandlers: (s: unknown) => void }).setupEventHandlers(state);
  const emit = (event: ReturnType<typeof fakeEvent>) =>
    client.emit("Room.timeline", event, fakeRoom, false, false, {});
  const originalId = (eventId: string) =>
    createUniqueUuid(runtime as unknown as IAgentRuntime, eventId);
  return { runtime, emit, store, originalId };
}

const settle = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

describe("matrix inbound edits", () => {
  it("stores the original and does not re-dispatch its edit", async () => {
    const { runtime, emit, store, originalId } = harness();
    emit(fakeEvent("$original", { msgtype: "m.text", body: "what is 2+2?" }));
    await settle();
    expect(runtime.createMemory).toHaveBeenCalledTimes(1);
    const stored = store.get(originalId("$original"));
    expect(stored?.content.text).toBe("what is 2+2?");

    emit(editOf("$edit-1", "$original", "what is 2+3?"));
    await settle();
    expect(runtime.createMemory).toHaveBeenCalledTimes(1);
    expect(runtime.messageService.handleMessage).not.toHaveBeenCalled();
    expect(runtime.emitEvent).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        message: expect.objectContaining({ content: expect.stringContaining("* ") }),
      })
    );
    expect(runtime.updateMemory).toHaveBeenCalledTimes(1);
    const patch = runtime.updateMemory.mock.calls[0][0] as {
      id: string;
      content: { text: string };
    };
    expect(patch.id).toBe(originalId("$original"));
    expect(patch.content.text).toBe("what is 2+3?");
    expect(store.get(originalId("$original"))?.content.text).toBe("what is 2+3?");
  });

  it("ignores an edit whose original was never stored", async () => {
    const { runtime, emit } = harness();
    emit(editOf("$edit-2", "$never-seen", "orphan edit"));
    await settle();
    expect(runtime.createMemory).not.toHaveBeenCalled();
    expect(runtime.updateMemory).not.toHaveBeenCalled();
    expect(runtime.messageService.handleMessage).not.toHaveBeenCalled();
  });

  it("applies a replayed edit event only once", async () => {
    const { runtime, emit } = harness();
    emit(fakeEvent("$original", { msgtype: "m.text", body: "first draft" }));
    await settle();
    const edit = editOf("$edit-3", "$original", "second draft");
    emit(edit);
    await settle();
    emit(edit);
    await settle();
    expect(runtime.updateMemory).toHaveBeenCalledTimes(1);

    emit(editOf("$edit-4", "$original", "third draft"));
    await settle();
    expect(runtime.updateMemory).toHaveBeenCalledTimes(2);
    expect(runtime.reportError).not.toHaveBeenCalled();
  });

  it("applies a group edit above the mention gate when the original was stored", async () => {
    const { runtime, emit, store, originalId } = harness({
      memberCount: 5,
      requireMention: true,
    });
    emit(fakeEvent("$unaddressed", { msgtype: "m.text", body: "chatter for everyone" }));
    emit(fakeEvent("$original", { msgtype: "m.text", body: "@bot what is 2+2?" }));
    await settle();
    expect(runtime.createMemory).toHaveBeenCalledTimes(1);
    expect(store.has(originalId("$original"))).toBe(true);

    emit(editOf("$edit-5", "$original", "what is 2+3?"));
    emit(editOf("$edit-6", "$unaddressed", "still chatter"));
    await settle();
    expect(runtime.updateMemory).toHaveBeenCalledTimes(1);
    expect(store.get(originalId("$original"))?.content.text).toBe("what is 2+3?");
    expect(runtime.messageService.handleMessage).not.toHaveBeenCalled();
  });

  it("waits for an in-flight original before applying its edit", async () => {
    const { runtime, emit, store, originalId } = harness({ persistDelayMs: 30 });
    emit(fakeEvent("$original", { msgtype: "m.text", body: "typo here" }));
    emit(editOf("$edit-7", "$original", "typo fixed"));
    await settle(10);
    expect(runtime.updateMemory).not.toHaveBeenCalled();
    await settle(60);
    expect(runtime.updateMemory).toHaveBeenCalledTimes(1);
    expect(store.get(originalId("$original"))?.content.text).toBe("typo fixed");
  });
});
