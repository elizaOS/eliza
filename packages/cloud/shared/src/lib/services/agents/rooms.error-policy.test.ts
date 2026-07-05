/**
 * Error-policy tests for RoomsService (#13415). This is auth/tenant-DB domain,
 * so it must FAIL CLOSED: an internal repository/DB failure must PROPAGATE, not
 * be swallowed into a "no room" (null) or "no access" (false) result that would
 * read a broken pipeline as a legitimately-empty answer. These tests pin that
 * an internal throw rejects, while a genuine not-found stays a designed empty
 * result — the two must remain distinguishable. Repositories and the DB client
 * are mocked; the real RoomsService logic runs unmocked.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// Mutable behavior for the mocked repositories. Each test sets the impl it needs.
const repoState: {
  roomFindById: (roomId: string) => Promise<unknown>;
  memoriesFindMessages: (...args: unknown[]) => Promise<unknown[]>;
  participantsGetEntityIds: (roomId: string) => Promise<string[]>;
  participantsIsParticipant: (roomId: string, entityId: string) => Promise<boolean>;
  conversationsFindById: (roomId: string) => Promise<unknown>;
} = {
  roomFindById: async () => null,
  memoriesFindMessages: async () => [],
  participantsGetEntityIds: async () => [],
  participantsIsParticipant: async () => false,
  conversationsFindById: async () => undefined,
};

mock.module("../../../db/client", () => ({
  dbWrite: {},
  dbRead: {},
}));

mock.module("../../../db/schemas/eliza", () => ({
  entityTable: {},
  participantTable: {},
  roomTable: {},
}));

mock.module("../../../db/repositories", () => ({
  roomsRepository: {
    findById: (roomId: string) => repoState.roomFindById(roomId),
  },
  memoriesRepository: {
    findMessages: (...args: unknown[]) => repoState.memoriesFindMessages(...args),
  },
  participantsRepository: {
    getEntityIdsByRoomId: (roomId: string) => repoState.participantsGetEntityIds(roomId),
    isParticipant: (roomId: string, entityId: string) =>
      repoState.participantsIsParticipant(roomId, entityId),
  },
  conversationsRepository: {
    findById: (roomId: string) => repoState.conversationsFindById(roomId),
  },
  entitiesRepository: {},
}));

const ROOM_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function resetRepoState() {
  repoState.roomFindById = async () => null;
  repoState.memoriesFindMessages = async () => [];
  repoState.participantsGetEntityIds = async () => [];
  repoState.participantsIsParticipant = async () => false;
  repoState.conversationsFindById = async () => undefined;
}

describe("RoomsService fail-closed error policy (#13415)", () => {
  beforeEach(() => {
    resetRepoState();
  });

  afterEach(() => {
    resetRepoState();
  });

  describe("getRoomWithMessages", () => {
    test("internal DB failure PROPAGATES (not swallowed to null)", async () => {
      const { roomsService } = await import("./rooms");
      const dbError = new Error("connection reset by peer");
      repoState.roomFindById = async () => {
        throw dbError;
      };

      await expect(roomsService.getRoomWithMessages(ROOM_ID)).rejects.toThrow(
        "connection reset by peer",
      );
    });

    test("genuinely-missing room returns the designed null (distinct from failure)", async () => {
      const { roomsService } = await import("./rooms");
      repoState.roomFindById = async () => null;

      const result = await roomsService.getRoomWithMessages(ROOM_ID);
      expect(result).toBeNull();
    });

    test("existing room with no messages returns an empty message list, not null", async () => {
      const { roomsService } = await import("./rooms");
      repoState.roomFindById = async () => ({ id: ROOM_ID, agentId: null });
      repoState.memoriesFindMessages = async () => [];
      repoState.participantsGetEntityIds = async () => [];

      const result = await roomsService.getRoomWithMessages(ROOM_ID);
      expect(result).not.toBeNull();
      expect(result?.messages).toEqual([]);
    });

    test("a message-load failure on an existing room PROPAGATES (not swallowed to empty)", async () => {
      const { roomsService } = await import("./rooms");
      repoState.roomFindById = async () => ({ id: ROOM_ID, agentId: null });
      repoState.memoriesFindMessages = async () => {
        throw new Error("memories query timeout");
      };

      await expect(roomsService.getRoomWithMessages(ROOM_ID)).rejects.toThrow(
        "memories query timeout",
      );
    });
  });

  describe("hasAccess (auth-critical, must fail closed)", () => {
    test("participant lookup failure PROPAGATES (never silently grants OR denies as 'empty')", async () => {
      const { roomsService } = await import("./rooms");
      repoState.participantsIsParticipant = async () => {
        throw new Error("participant table unavailable");
      };

      await expect(roomsService.hasAccess(ROOM_ID, USER_ID)).rejects.toThrow(
        "participant table unavailable",
      );
    });

    test("no participant, no room, no conversation -> designed false (distinct from failure)", async () => {
      const { roomsService } = await import("./rooms");
      repoState.participantsIsParticipant = async () => false;
      repoState.roomFindById = async () => null;
      repoState.conversationsFindById = async () => undefined;

      const granted = await roomsService.hasAccess(ROOM_ID, USER_ID);
      expect(granted).toBe(false);
    });

    test("legitimate participant -> true", async () => {
      const { roomsService } = await import("./rooms");
      repoState.participantsIsParticipant = async () => true;

      const granted = await roomsService.hasAccess(ROOM_ID, USER_ID);
      expect(granted).toBe(true);
    });
  });
});
