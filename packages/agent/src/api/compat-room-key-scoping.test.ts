/**
 * Pins the compat room-key scoping invariant: keys within the historical
 * 120-char limit keep their exact derivation, and longer keys retain the full
 * digest strength needed for collision-resistant room isolation instead of
 * sharing the previous bare `.slice(0, 120)` prefix.
 */

import type http from "node:http";
import {
  type AgentRuntime,
  type Memory,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { type ChatRouteContext, handleChatRoutes } from "./chat-routes.ts";
import {
  COMPAT_ROOM_KEY_MAX_LENGTH,
  resolveCompatRoomKey,
  scopeCompatRoomKey,
} from "./compat-utils.ts";

function roomUuid(principalScopedRoomKey: string): UUID {
  return stringToUuid(`Eliza-openai-room-${principalScopedRoomKey}`) as UUID;
}

describe("scopeCompatRoomKey", () => {
  it("keeps short keys byte-identical to the historical truncation-free path", () => {
    for (const key of [
      "default",
      "user_12345",
      "a".repeat(119),
      "b".repeat(120),
    ]) {
      expect(scopeCompatRoomKey(key)).toBe(key);
    }
  });

  it("derives distinct rooms for distinct long keys sharing a 120-char prefix", () => {
    const prefix = "conversation:org-acme:service=relay:".padEnd(120, "x");
    const first = `${prefix}00000000-0000-4000-8000-000000000001`;
    const second = `${prefix}00000000-0000-4000-8000-000000000002`;
    expect(first.length).toBeGreaterThan(COMPAT_ROOM_KEY_MAX_LENGTH);
    expect(first.slice(0, COMPAT_ROOM_KEY_MAX_LENGTH)).toBe(
      second.slice(0, COMPAT_ROOM_KEY_MAX_LENGTH),
    );

    const scopedFirst = scopeCompatRoomKey(first);
    const scopedSecond = scopeCompatRoomKey(second);
    expect(scopedFirst).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(scopedFirst).not.toBe(scopedSecond);
    expect(roomUuid(scopedFirst)).not.toBe(roomUuid(scopedSecond));

    // The old behavior aliased both onto one room — the defect.
    expect(roomUuid(first.slice(0, COMPAT_ROOM_KEY_MAX_LENGTH))).toBe(
      roomUuid(second.slice(0, COMPAT_ROOM_KEY_MAX_LENGTH)),
    );
  });

  it("is deterministic for the same long key across requests", () => {
    const key = "k".repeat(300);
    expect(scopeCompatRoomKey(key)).toBe(scopeCompatRoomKey(key));
  });

  it("keeps prefix-colliding identifiers in distinct rooms through the OpenAI route", async () => {
    const prefix = "route-conversation:".padEnd(120, "x");
    const roomIds: UUID[] = [];
    const inboundTurns: Memory[] = [];
    const roomActors = new Map<UUID, UUID>();
    const agentId = stringToUuid("compat-route-agent") as UUID;
    const ownerId = stringToUuid("compat-route-owner") as UUID;
    const roomLease = {};
    const runtime = {
      agentId,
      character: { name: "Eliza" },
      getSetting: (key: string) =>
        key === "ELIZA_ADMIN_ENTITY_ID" ? ownerId : undefined,
      ensureConnection: async (connection: {
        entityId: UUID;
        roomId: UUID;
      }) => {
        roomIds.push(connection.roomId);
        roomActors.set(connection.roomId, connection.entityId);
      },
      getParticipantsForRoom: async (roomId: UUID) => [
        agentId,
        roomActors.get(roomId) as UUID,
      ],
      roomHandlerQueue: {
        currentLease: () => roomLease,
        ownsLease: () => true,
      },
      reportError: () => undefined,
      emitEvent: async (_type: unknown, payload: { message: Memory }) => {
        inboundTurns.push(payload.message);
        throw new Error("stop after route constructs the inbound turn");
      },
    } as unknown as AgentRuntime;

    const invoke = async (conversationKey: string): Promise<void> => {
      const responses: Array<{ data: unknown; status?: number }> = [];
      const handled = await handleChatRoutes({
        req: { headers: {} } as http.IncomingMessage,
        res: {} as http.ServerResponse,
        method: "POST",
        pathname: "/v1/chat/completions",
        readJsonBody: async <T extends object>() =>
          ({
            model: "eliza",
            user: conversationKey,
            messages: [{ role: "user", content: "remember this room" }],
          }) as T,
        json: (_response, data, status) => responses.push({ data, status }),
        error: () =>
          expect.unreachable("compat failures use the JSON responder"),
        state: {
          runtime,
          config: {},
          agentName: "Eliza",
          logBuffer: [],
          chatRoomId: null,
          chatUserId: null,
          chatConnectionReady: null,
          chatConnectionPromise: null,
          adminEntityId: null,
        },
      } as ChatRouteContext);
      expect(handled).toBe(true);
      expect(responses.at(-1)).toEqual({
        data: {
          error: {
            message: "stop after route constructs the inbound turn",
            type: "server_error",
          },
        },
        status: 500,
      });
    };

    await invoke(`${prefix}first`);
    await invoke(`${prefix}second`);

    expect(roomIds).toHaveLength(2);
    expect(roomIds[0]).not.toBe(roomIds[1]);
    expect(inboundTurns.map((turn) => turn.roomId)).toEqual(roomIds);
  });
});

describe("resolveCompatRoomKey", () => {
  it("resolves user and metadata identifiers used by compat clients", () => {
    expect(resolveCompatRoomKey({ user: "u-1" })).toBe("u-1");
    expect(resolveCompatRoomKey({ metadata: { conversation_id: "c-2" } })).toBe(
      "c-2",
    );
    expect(resolveCompatRoomKey({ metadata: { user_id: "v-3" } })).toBe("v-3");
    expect(resolveCompatRoomKey({})).toBe("default");
  });
});
