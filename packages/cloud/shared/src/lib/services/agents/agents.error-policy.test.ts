/**
 * Error-policy tests for AgentsService.getRoomContext (#13415). This is
 * tenant-DB read domain: a failed DB read (findMessages / participants) must
 * FAIL CLOSED — propagate, never be swallowed into an empty-messages context
 * that a caller would read as "room has no history". A legitimately-empty room
 * (no messages, no participants) is a distinct, designed empty result that must
 * still be returned. Repositories and the state cache are mocked; the real
 * getRoomContext control flow runs unmocked.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

let findMessagesImpl: () => Promise<unknown[]> = async () => [];
let getEntityIdsImpl: () => Promise<string[]> = async () => [];
let _setRoomContextCalls = 0;

// Mock the repository submodules (not the barrel) so the barrel's `export *`
// re-export resolves to these — the idiom used by characters.test.ts.
mock.module("../../../db/repositories/agents/memories", () => ({
  memoriesRepository: {
    findMessages: () => findMessagesImpl(),
  },
}));

mock.module("../../../db/repositories/agents/participants", () => ({
  participantsRepository: {
    getEntityIdsByRoomId: () => getEntityIdsImpl(),
    // getRoomContext also touches participantsRepository elsewhere; only the
    // one method is exercised here.
  },
}));

// Stub the runtime/message-handler imports pulled in transitively by agents.ts
// (used only by sendMessage, not getRoomContext) — they otherwise drag in an
// uninstalled plugin package and break the import.
mock.module("../../eliza/runtime-factory", () => ({
  runtimeFactory: { createRuntimeForUser: async () => ({}) },
}));
mock.module("../../eliza/message-handler", () => ({
  createMessageHandler: () => ({ process: async () => ({ message: {} }) }),
}));

// Cache miss on read forces the DB path; setRoomContext is best-effort (J7).
mock.module("../../cache/agent-state-cache", () => ({
  agentStateCache: {
    getRoomContext: async () => null,
    setRoomContext: async () => {
      _setRoomContextCalls++;
    },
  },
}));

const ROOM_ID = "44444444-4444-4444-8444-444444444444";

describe("AgentsService.getRoomContext — fail-closed on DB read failure", () => {
  beforeEach(() => {
    findMessagesImpl = async () => [];
    getEntityIdsImpl = async () => [];
    _setRoomContextCalls = 0;
  });

  afterEach(() => {
    mock.restore();
  });

  test("legitimately-empty room returns its designed empty context (not a failure)", async () => {
    const { agentsService } = await import("./agents");

    const context = await agentsService.getRoomContext(ROOM_ID);

    expect(context.roomId).toBe(ROOM_ID);
    expect(context.messages).toEqual([]);
    expect(context.participants).toEqual([]);
  });

  test("findMessages DB failure PROPAGATES — never swallowed into an empty context", async () => {
    const { agentsService } = await import("./agents");
    const dbError = new Error("connection reset by peer");
    findMessagesImpl = async () => {
      throw dbError;
    };
    // Participants would succeed; the message read is the one that fails.
    getEntityIdsImpl = async () => ["entity-1"];

    let caught: unknown;
    let resolved: unknown;
    try {
      resolved = await agentsService.getRoomContext(ROOM_ID);
    } catch (error) {
      caught = error;
    }

    expect(resolved).toBeUndefined();
    expect(caught).toBe(dbError);
  });

  test("participants DB failure PROPAGATES — distinct from an empty participant list", async () => {
    const { agentsService } = await import("./agents");
    const dbError = new Error("participants query timeout");
    getEntityIdsImpl = async () => {
      throw dbError;
    };

    let caught: unknown;
    try {
      await agentsService.getRoomContext(ROOM_ID);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(dbError);
  });

  test("the two are distinguishable: empty succeeds, failure rejects", async () => {
    const { agentsService } = await import("./agents");

    // Empty room path.
    const emptyContext = await agentsService.getRoomContext(ROOM_ID);
    expect(emptyContext.messages).toEqual([]);

    // Failure path on the same function.
    findMessagesImpl = async () => {
      throw new Error("boom");
    };
    await expect(agentsService.getRoomContext(ROOM_ID)).rejects.toThrow("boom");
  });
});
