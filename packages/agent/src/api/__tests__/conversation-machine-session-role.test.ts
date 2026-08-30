/**
 * Machine-session (paired-device) attribution on the web-conversation surface.
 *
 * ea44f571ec1 taught compat chat ingress (ensureCompatChatConnection) to grant
 * an authenticated machine-session principal's minted entity USER world
 * membership, but the conversation routes resolve their caller through
 * resolveConversationCaller, which dropped `sessionRole` and granted GUEST —
 * so "go home" turns in a dashboard conversation still failed the VIEWS
 * minRole:USER gate (live tj-92e47fe5ea3e5c: deterministic VIEWS call ->
 * "Action VIEWS is not allowed for the current role"). This suite drives the
 * production conversation route + connection seam with a stubbed runtime
 * adapter, then core checkSenderRole and the real VIEWS action gate.
 */

import http from "node:http";
import { Socket } from "node:net";
import type { Action, AgentContext } from "@elizaos/core";
import {
  checkSenderRole,
  logger,
  type Memory,
  type RoleGateRole,
  satisfiesContextGate,
  satisfiesRoleGate,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import { viewsAction } from "@elizaos/plugin-app-control";
import { describe, expect, it, vi } from "vitest";
import type { AgentHttpRequestAuthorization } from "../../runtime/host-bridge.ts";
import { resolveTrustedApiPrincipal } from "../chat-routes.ts";
import type {
  ConversationRouteContext,
  ConversationRouteState,
} from "../conversation-routes.ts";
import {
  ensureConversationRoom,
  handleConversationRoutes,
  resolveConversationCaller,
} from "../conversation-routes.ts";
import type { ConversationMeta } from "../server-types.ts";

vi.mock("../server-helpers.ts", async () => {
  const actual = await vi.importActual<typeof import("../server-helpers.ts")>(
    "../server-helpers.ts",
  );
  return {
    ...actual,
    resolveAppUserName: () => "tester",
  };
});

const AGENT_ID = stringToUuid("machine-session-agent") as UUID;
const OWNER_ID = stringToUuid("machine-session-owner") as UUID;
const MACHINE_IDENTITY = "machine-session-identity-48bb15ed";
const CALLER_ENTITY_ID = stringToUuid(
  `conversation-external:${MACHINE_IDENTITY}`,
) as UUID;

const machineSessionAuthorization: AgentHttpRequestAuthorization = {
  ok: true,
  role: "USER",
  identityId: MACHINE_IDENTITY,
};

type StoredWorld = {
  id: UUID;
  metadata?: {
    ownership?: { ownerId?: string };
    roles?: Record<string, string>;
    roleSources?: Record<string, string>;
  };
};

function createRuntimeHarness() {
  const worlds = new Map<string, StoredWorld>();
  const roomWorlds = new Map<string, UUID>();
  const updateWorld = vi.fn(async (world: StoredWorld) => {
    worlds.set(world.id, world);
  });
  const runtime = {
    agentId: AGENT_ID,
    character: { name: "Test Agent" },
    logger,
    getSetting: () => undefined,
    getRelationships: async () => [],
    getEntityById: async () => null,
    ensureConnection: vi.fn(async (params: { roomId: UUID; worldId: UUID }) => {
      roomWorlds.set(params.roomId, params.worldId);
      if (!worlds.has(params.worldId)) {
        worlds.set(params.worldId, { id: params.worldId, metadata: {} });
      }
    }),
    getWorld: async (id: UUID) => worlds.get(id) ?? null,
    updateWorld,
    getRoom: async (id: UUID) => {
      const worldId = roomWorlds.get(id);
      return worldId ? { id, worldId } : null;
    },
    adapter: {},
  };
  return { runtime, worlds, roomWorlds, updateWorld };
}

function createState(runtime: unknown): ConversationRouteState {
  return {
    runtime: runtime as never,
    config: { user: { name: "tester" } } as never,
    agentName: "Test Agent",
    adminEntityId: OWNER_ID,
    chatUserId: OWNER_ID,
    logBuffer: [],
    conversations: new Map<string, ConversationMeta>(),
    activeChatTurnCount: 0,
    conversationRestorePromise: null,
    deletedConversationIds: new Set(),
    broadcastWs: null,
  } as unknown as ConversationRouteState;
}

function createReq(): http.IncomingMessage {
  const request = new http.IncomingMessage(new Socket());
  request.method = "POST";
  request.url = "/api/conversations";
  request.headers = { host: "agent.example.test" };
  Object.defineProperty(request.socket, "remoteAddress", {
    value: "203.0.113.19",
    configurable: true,
  });
  return request;
}

function createCtx(
  state: ConversationRouteState,
  callerAuthorization: AgentHttpRequestAuthorization | undefined,
): ConversationRouteContext & { json: ReturnType<typeof vi.fn> } {
  return {
    req: createReq(),
    res: {} as http.ServerResponse,
    method: "POST",
    pathname: "/api/conversations",
    state,
    callerAuthorization,
    readJsonBody: vi.fn(async () => ({ title: "Machine session turn" })),
    json: vi.fn(),
    error: vi.fn(),
  } as unknown as ConversationRouteContext & { json: ReturnType<typeof vi.fn> };
}

function messageFor(userId: UUID, roomId: UUID): Memory {
  return {
    entityId: userId,
    roomId,
    content: { text: "go home", source: "client_chat" },
  } as unknown as Memory;
}

type GateableFixture = Pick<Action, "name" | "roleGate"> &
  Partial<Pick<Action, "contexts" | "contextGate">>;

/**
 * Mirrors the role/context stages of core's actionGateRejection (VIEWS
 * declares no private/disclosure gate and no ACTION_ROLE_POLICY override is
 * set in tests) — same fixture as machine-session-role-grant.test.ts.
 */
function gateAllows(
  action: GateableFixture,
  userRoles: readonly RoleGateRole[],
  activeContexts: readonly AgentContext[],
): boolean {
  const contextRoleGate = action.contextGate?.roleGate ?? action.roleGate;
  if (!satisfiesRoleGate(userRoles, contextRoleGate)) return false;
  const contextGate = action.contextGate ?? { contexts: action.contexts };
  if (!satisfiesContextGate(activeContexts, contextGate, userRoles)) {
    return false;
  }
  return satisfiesRoleGate(userRoles, action.roleGate);
}

async function createConversationThroughRoute(
  harness: ReturnType<typeof createRuntimeHarness>,
  callerAuthorization: AgentHttpRequestAuthorization | undefined,
): Promise<{ state: ConversationRouteState; conv: ConversationMeta }> {
  const state = createState(harness.runtime);
  const ctx = createCtx(state, callerAuthorization);
  const handled = await handleConversationRoutes(ctx);
  expect(handled).toBe(true);
  expect(ctx.error).not.toHaveBeenCalled();
  const conv = [...state.conversations.values()][0];
  if (!conv) throw new Error("conversation was not created");
  return { state, conv };
}

describe("machine-session attribution on the conversation surface", () => {
  it("grants the conversation caller USER world membership with audit source 'session'", async () => {
    const harness = createRuntimeHarness();
    const { conv } = await createConversationThroughRoute(
      harness,
      machineSessionAuthorization,
    );

    const worldId = stringToUuid("Test Agent-web-chat-world") as UUID;
    const world = harness.worlds.get(worldId);
    expect(world?.metadata?.roles?.[CALLER_ENTITY_ID]).toBe("USER");
    expect(world?.metadata?.roleSources?.[CALLER_ENTITY_ID]).toBe("session");
    // The conversation world keeps its canonical owner attribution.
    expect(world?.metadata?.roles?.[OWNER_ID]).toBe("OWNER");
    expect(world?.metadata?.roleSources?.[OWNER_ID]).toBe("owner");

    const senderRole = await checkSenderRole(
      harness.runtime as never,
      messageFor(CALLER_ENTITY_ID, conv.roomId),
    );
    expect(senderRole?.role).toBe("USER");
    expect(senderRole?.isOwner).toBe(false);

    const userRoles = [senderRole?.role ?? "GUEST"] as RoleGateRole[];
    const activeContexts = ["general"] as AgentContext[];
    expect(gateAllows(viewsAction, userRoles, activeContexts)).toBe(true);
    expect(
      gateAllows(
        { name: "OWNER_ONLY_SURFACE", roleGate: { minRole: "OWNER" } },
        userRoles,
        activeContexts,
      ),
    ).toBe(false);
  });

  it("upgrades a pre-existing conversation whose caller was granted GUEST before the fix", async () => {
    // Live worlds recorded roles[caller]="GUEST" for every earlier
    // machine-session turn; the next turn's connection ensure must upgrade the
    // stale grant in place (same conversation, same entity id).
    const harness = createRuntimeHarness();
    const state = createState(harness.runtime);
    const worldId = stringToUuid("Test Agent-web-chat-world") as UUID;
    const conv: ConversationMeta = {
      id: "5331baf6-pre-existing",
      title: "Pre-existing chat",
      roomId: stringToUuid("web-conv-5331baf6-pre-existing") as UUID,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    state.conversations.set(conv.id, conv);
    harness.worlds.set(worldId, {
      id: worldId,
      metadata: {
        ownership: { ownerId: OWNER_ID },
        roles: { [OWNER_ID]: "OWNER", [CALLER_ENTITY_ID]: "GUEST" },
        roleSources: { [OWNER_ID]: "owner" },
      },
    });

    const principal = resolveTrustedApiPrincipal(
      createReq(),
      machineSessionAuthorization,
    );
    expect(principal).toEqual({
      kind: "service_gateway",
      principalId: MACHINE_IDENTITY,
      sessionRole: "USER",
      sessionIdentityId: MACHINE_IDENTITY,
    });
    const caller = resolveConversationCaller(
      createReq(),
      state,
      principal,
      harness.runtime as never,
    );
    expect(caller.entityId).toBe(CALLER_ENTITY_ID);
    await ensureConversationRoom(state, harness.runtime as never, conv, caller);

    const world = harness.worlds.get(worldId);
    expect(world?.metadata?.roles?.[CALLER_ENTITY_ID]).toBe("USER");
    expect(world?.metadata?.roleSources?.[CALLER_ENTITY_ID]).toBe("session");

    const senderRole = await checkSenderRole(
      harness.runtime as never,
      messageFor(CALLER_ENTITY_ID, conv.roomId),
    );
    expect(senderRole?.role).toBe("USER");
    expect(
      gateAllows(
        viewsAction,
        [senderRole?.role ?? "GUEST"] as RoleGateRole[],
        ["general"] as AgentContext[],
      ),
    ).toBe(true);
  });

  it("never downgrades an existing USER-or-higher grant for the session caller", async () => {
    const harness = createRuntimeHarness();
    const state = createState(harness.runtime);
    const worldId = stringToUuid("Test Agent-web-chat-world") as UUID;
    const conv: ConversationMeta = {
      id: "manual-admin-conv",
      title: "Manual admin chat",
      roomId: stringToUuid("web-conv-manual-admin-conv") as UUID,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    state.conversations.set(conv.id, conv);
    harness.worlds.set(worldId, {
      id: worldId,
      metadata: {
        ownership: { ownerId: OWNER_ID },
        roles: { [OWNER_ID]: "OWNER", [CALLER_ENTITY_ID]: "ADMIN" },
        roleSources: { [OWNER_ID]: "owner", [CALLER_ENTITY_ID]: "manual" },
      },
    });

    const caller = resolveConversationCaller(
      createReq(),
      state,
      resolveTrustedApiPrincipal(createReq(), machineSessionAuthorization),
      harness.runtime as never,
    );
    harness.updateWorld.mockClear();
    await ensureConversationRoom(state, harness.runtime as never, conv, caller);

    const world = harness.worlds.get(worldId);
    expect(harness.updateWorld).not.toHaveBeenCalled();
    expect(world?.metadata?.roles?.[CALLER_ENTITY_ID]).toBe("ADMIN");
    expect(world?.metadata?.roleSources?.[CALLER_ENTITY_ID]).toBe("manual");
  });

  it("keeps a plain external principal GUEST and VIEWS-denied", async () => {
    const harness = createRuntimeHarness();
    const { conv } = await createConversationThroughRoute(harness, undefined);

    const externalEntityId = stringToUuid(
      "conversation-external:non-owner-api",
    ) as UUID;
    const worldId = stringToUuid("Test Agent-web-chat-world") as UUID;
    const world = harness.worlds.get(worldId);
    expect(world?.metadata?.roles?.[externalEntityId]).toBe("GUEST");
    expect(world?.metadata?.roleSources?.[externalEntityId]).toBeUndefined();

    const senderRole = await checkSenderRole(
      harness.runtime as never,
      messageFor(externalEntityId, conv.roomId),
    );
    expect(senderRole?.role).toBe("GUEST");
    expect(
      gateAllows(
        viewsAction,
        [senderRole?.role ?? "GUEST"] as RoleGateRole[],
        ["general"] as AgentContext[],
      ),
    ).toBe(false);
  });
});
