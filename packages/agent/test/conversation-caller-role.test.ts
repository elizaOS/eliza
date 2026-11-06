/**
 * ELIZA_CONVERSATION_CALLER_ROLE=USER runs owner-authenticated chat turns as
 * the product user at role USER, on the conversation and compat chat routes.
 */
import type http from "node:http";
import {
  type AgentRuntime,
  getEntityRole,
  type RolesWorldMetadata,
  type TrustedApiPrincipal,
  type UUID,
  type World,
} from "@elizaos/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ChatRouteState,
  ensureCompatChatConnection,
} from "../src/api/chat-routes.ts";
import { resolveOwnerChatCallerRole } from "../src/api/client-chat-admin.ts";
import {
  type ConversationRouteState,
  resolveConversationCaller,
} from "../src/api/conversation-routes.ts";

const agentId = "00000000-0000-4000-8000-0000000000a1" as UUID;
const ownerToken: TrustedApiPrincipal = {
  kind: "owner_api_token",
  principalId: "direct-owner-api",
};
const request = { headers: {} } as http.IncomingMessage;

function routeState(): ConversationRouteState & ChatRouteState {
  return {
    runtime: null,
    config: {},
    agentName: "Eliza",
    adminEntityId: null,
    chatUserId: null,
  } as unknown as ConversationRouteState & ChatRouteState;
}

function worldRuntime() {
  const worlds = new Map<UUID, World>();
  const runtime = {
    agentId,
    getSetting: () => undefined,
    ensureConnection: async ({ worldId }: { worldId: UUID }) => {
      if (!worlds.has(worldId))
        worlds.set(worldId, { id: worldId, agentId, metadata: {} } as World);
    },
    getWorld: async (id: UUID) => structuredClone(worlds.get(id) ?? null),
    updateWorld: async (world: World) => {
      worlds.set(world.id, world);
    },
  } as unknown as AgentRuntime;
  return { runtime, worlds };
}

afterEach(() => {
  delete process.env.ELIZA_CONVERSATION_CALLER_ROLE;
});

describe("ELIZA_CONVERSATION_CALLER_ROLE", () => {
  it("keeps owner-authenticated conversation turns at OWNER by default", () => {
    const state = routeState();
    const caller = resolveConversationCaller(request, state, ownerToken);
    expect(caller).toMatchObject({ role: "OWNER", grantSource: "owner" });
    expect(caller.entityId).toBe(state.adminEntityId);
  });

  it("runs owner-authenticated conversation turns as the product user at USER", () => {
    const adminEntityId = resolveConversationCaller(
      request,
      routeState(),
      ownerToken,
    ).entityId;
    process.env.ELIZA_CONVERSATION_CALLER_ROLE = "USER";
    for (const principal of [
      ownerToken,
      { kind: "owner_session", principalId: "paired-owner" },
    ] as TrustedApiPrincipal[]) {
      const caller = resolveConversationCaller(
        request,
        routeState(),
        principal,
      );
      expect(caller).toMatchObject({ role: "USER", grantSource: "session" });
      expect(caller.entityId).not.toBe(adminEntityId);
    }
  });

  it("gives the product user an entity no external principal id can derive", () => {
    process.env.ELIZA_CONVERSATION_CALLER_ROLE = "USER";
    const product = resolveConversationCaller(
      request,
      routeState(),
      ownerToken,
    ).entityId;
    for (const principal of [
      {
        kind: "service_gateway",
        principalId: "product-user",
        sessionRole: "USER",
      },
      { kind: "service_gateway", principalId: "product-user" },
    ] as TrustedApiPrincipal[]) {
      expect(
        resolveConversationCaller(request, routeState(), principal).entityId,
      ).not.toBe(product);
    }
  });

  it("grants the compat chat turn USER on a separate entity in the same room", async () => {
    process.env.ELIZA_CONVERSATION_CALLER_ROLE = "USER";
    const { runtime, worlds } = worldRuntime();
    const connect = () =>
      ensureCompatChatConnection(
        routeState(),
        runtime,
        "Eliza",
        "web",
        "default",
        ownerToken,
      );
    const user = await connect();
    const metadata = worlds.get(user.worldId)?.metadata as RolesWorldMetadata;
    expect(getEntityRole(metadata, user.userId)).toBe("USER");
    expect(metadata.roleSources?.[user.userId]).toBe("session");
    expect(metadata.ownership).toBeUndefined();

    delete process.env.ELIZA_CONVERSATION_CALLER_ROLE;
    const owner = await connect();
    expect(owner.userId).not.toBe(user.userId);
    expect(owner.roomId).toBe(user.roomId);
  });

  it("throws on any value other than OWNER or USER", () => {
    for (const value of ["user", "ADMIN", ""]) {
      expect(() =>
        resolveOwnerChatCallerRole({ ELIZA_CONVERSATION_CALLER_ROLE: value }),
      ).toThrow(
        expect.objectContaining({ code: "INVALID_CONVERSATION_CALLER_ROLE" }),
      );
    }
  });
});
