/**
 * Inbound m.replace edits must correct the stored original instead of being
 * dispatched as a new message carrying the "* " fallback body (#31766).
 * Deterministic: real setupEventHandlers/handleRoomMessage over an in-memory
 * event-emitter client and a recording runtime; no homeserver, no model.
 */
import { EventEmitter } from "node:events";
import { createUniqueUuid, type IAgentRuntime } from "@elizaos/core";
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

const fakeRoom = {
  name: "ops",
  roomId: ROOM,
  getMember: () => ({ name: "alice", getMxcAvatarUrl: () => undefined }),
  getJoinedMemberCount: () => 2,
  currentState: { getStateEvents: () => undefined },
  getCanonicalAlias: () => null,
  hasEncryptionStateEvent: () => false,
};

function harness() {
  const client = Object.assign(new EventEmitter(), {
    getAccountData: () => undefined,
    getCrypto: () => undefined,
  });
  const runtime = {
    agentId: "00000000-0000-0000-0000-000000000001",
    emitEvent: vi.fn(async () => undefined),
    ensureConnection: vi.fn(async () => undefined),
    createMemory: vi.fn(async () => undefined),
    getMemoryById: vi.fn(async () => null),
    updateMemory: vi.fn(async () => true),
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
      requireMention: false,
      rooms: [],
    },
    client,
    connected: true,
    syncing: true,
  };
  (service as unknown as { setupEventHandlers: (s: unknown) => void }).setupEventHandlers(state);
  const emit = (event: ReturnType<typeof fakeEvent>) =>
    client.emit("Room.timeline", event, fakeRoom, false, false, {});
  return { runtime, emit };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("matrix inbound edits", () => {
  it("stores the original and does not re-dispatch its edit", async () => {
    const { runtime, emit } = harness();
    emit(fakeEvent("$original", { msgtype: "m.text", body: "what is 2+2?" }));
    await settle();
    expect(runtime.createMemory).toHaveBeenCalledTimes(1);
    const stored = runtime.createMemory.mock.calls[0][0] as {
      id: string;
      content: { text: string };
    };
    expect(stored.content.text).toBe("what is 2+2?");
    runtime.getMemoryById.mockResolvedValueOnce(stored);

    emit(
      fakeEvent("$edit-1", {
        msgtype: "m.text",
        body: "* what is 2+3?",
        "m.new_content": { msgtype: "m.text", body: "what is 2+3?" },
        "m.relates_to": { rel_type: "m.replace", event_id: "$original" },
      })
    );
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
    expect(patch.id).toBe(createUniqueUuid(runtime as unknown as IAgentRuntime, "$original"));
    expect(patch.id).toBe(stored.id);
    expect(patch.content.text).toBe("what is 2+3?");
  });

  it("ignores an edit whose original was never stored", async () => {
    const { runtime, emit } = harness();
    emit(
      fakeEvent("$edit-2", {
        msgtype: "m.text",
        body: "* orphan edit",
        "m.new_content": { msgtype: "m.text", body: "orphan edit" },
        "m.relates_to": { rel_type: "m.replace", event_id: "$never-seen" },
      })
    );
    await settle();
    expect(runtime.createMemory).not.toHaveBeenCalled();
    expect(runtime.updateMemory).not.toHaveBeenCalled();
    expect(runtime.messageService.handleMessage).not.toHaveBeenCalled();
  });
});
