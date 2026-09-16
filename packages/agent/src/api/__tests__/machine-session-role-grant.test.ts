/**
 * Pairing -> chat -> VIEWS attribution flow for authenticated machine-session
 * (paired-device) principals. Chat ingress must grant the session's minted
 * external entity USER world membership (source "session") so core's
 * checkSenderRole resolves at least the session's boundary role, while
 * OWNER-gated surfaces keep denying and unauthenticated external principals
 * stay GUEST. Uses the production ensureCompatChatConnection /
 * resolveTrustedApiPrincipal, core role resolution, the real action gate, and
 * the real VIEWS action over a stubbed runtime adapter.
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
  type TrustedApiPrincipal,
  type UUID,
} from "@elizaos/core";
import { viewsAction } from "@elizaos/plugin-app-control";
import { describe, expect, it, vi } from "vitest";
import type { ChatRouteState } from "../chat-routes.ts";
import {
  ensureCompatChatConnection,
  resolveTrustedApiPrincipal,
} from "../chat-routes.ts";

const MACHINE_IDENTITY = "machine-session-identity-48bb15ed";

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
    agentId: "10000000-0000-4000-8000-000000000001" as UUID,
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
  };
  return { runtime, worlds, updateWorld };
}

function createState(): ChatRouteState {
  return {
    runtime: null,
    config: {} as ChatRouteState["config"],
    agentName: "Test Agent",
    logBuffer: [],
    chatRoomId: null,
    chatUserId: null,
    chatConnectionReady: null,
    chatConnectionPromise: null,
    adminEntityId: "20000000-0000-4000-8000-000000000002" as UUID,
  };
}

function makeUnauthenticatedRequest(): http.IncomingMessage {
  const request = new http.IncomingMessage(new Socket());
  request.headers = { host: "agent.example.test" };
  Object.defineProperty(request.socket, "remoteAddress", {
    value: "203.0.113.19",
    configurable: true,
  });
  return request;
}

async function connect(
  harness: ReturnType<typeof createRuntimeHarness>,
  principal: TrustedApiPrincipal,
) {
  return ensureCompatChatConnection(
    createState(),
    harness.runtime as never,
    "Test Agent",
    "compat-chat",
    "default",
    principal,
  );
}

function messageFor(userId: UUID, roomId: UUID): Memory {
  return {
    entityId: userId,
    roomId,
    content: { text: "go home", source: "client_chat" },
  } as unknown as Memory;
}

const machineSessionPrincipal: TrustedApiPrincipal = {
  kind: "service_gateway",
  principalId: MACHINE_IDENTITY,
  sessionRole: "USER",
  sessionIdentityId: MACHINE_IDENTITY,
};

type GateableFixture = Pick<Action, "name" | "roleGate"> &
  Partial<Pick<Action, "contexts" | "contextGate">>;

/**
 * Mirrors the role/context stages of core's actionGateRejection (VIEWS
 * declares no private/disclosure gate and no ACTION_ROLE_POLICY override is
 * set in tests): contextGate.roleGate ?? roleGate, then the contextGate, then
 * the top-level roleGate. The gate-parity suites pin that every execution path
 * routes through that one composed gate.
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

describe("machine-session chat attribution (pairing -> chat -> VIEWS)", () => {
  it("pins the real VIEWS gate at minRole USER", () => {
    expect(viewsAction.roleGate).toEqual({ minRole: "USER" });
  });

  it("grants the minted entity USER world membership with audit source 'session'", async () => {
    const harness = createRuntimeHarness();
    const { userId, worldId } = await connect(harness, machineSessionPrincipal);

    const world = harness.worlds.get(worldId);
    expect(harness.updateWorld).toHaveBeenCalledTimes(1);
    expect(world?.metadata?.roles?.[userId]).toBe("USER");
    expect(world?.metadata?.roleSources?.[userId]).toBe("session");
    // No ownership and no OWNER/ADMIN grant leaks in through this seam.
    expect(world?.metadata?.ownership).toBeUndefined();
    expect(
      Object.values(world?.metadata?.roles ?? {}).every((r) => r === "USER"),
    ).toBe(true);
  });

  it("machine-session turns resolve USER and pass the real VIEWS gate; OWNER gates still deny", async () => {
    const harness = createRuntimeHarness();
    const { userId, roomId } = await connect(harness, machineSessionPrincipal);
    const message = messageFor(userId, roomId);

    const senderRole = await checkSenderRole(harness.runtime as never, message);
    expect(senderRole?.role).toBe("USER");
    expect(senderRole?.isOwner).toBe(false);
    expect(senderRole?.isAdmin).toBe(false);

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

  it("keeps an unauthenticated external principal GUEST and VIEWS-denied", async () => {
    const harness = createRuntimeHarness();
    // A revoked/expired session fails boundary auth, so ingress classifies the
    // caller exactly like any unauthenticated external request.
    const principal = resolveTrustedApiPrincipal(
      makeUnauthenticatedRequest(),
      undefined,
    );
    expect(principal).toEqual({
      kind: "service_gateway",
      principalId: "non-owner-api",
    });

    const { userId, roomId } = await connect(harness, principal);
    expect(harness.updateWorld).not.toHaveBeenCalled();

    const message = messageFor(userId, roomId);
    const senderRole = await checkSenderRole(harness.runtime as never, message);
    expect(senderRole?.role).toBe("GUEST");
    expect(
      gateAllows(
        viewsAction,
        [senderRole?.role ?? "GUEST"] as RoleGateRole[],
        ["general"] as AgentContext[],
      ),
    ).toBe(false);
  });

  it("mints a different entity for the revoked-session caller than for the live session", async () => {
    const harness = createRuntimeHarness();
    const live = await connect(harness, machineSessionPrincipal);
    const revoked = await connect(harness, {
      kind: "service_gateway",
      principalId: "non-owner-api",
    });
    // The USER grant is reachable only through boundary-authenticated turns:
    // the plain external principal resolves a different entity with no grant.
    expect(revoked.userId).not.toBe(live.userId);
    const world = harness.worlds.get(live.worldId);
    expect(world?.metadata?.roles?.[revoked.userId]).toBeUndefined();
  });

  it("never overwrites an existing USER-or-higher grant for the minted entity", async () => {
    const harness = createRuntimeHarness();
    const first = await connect(harness, machineSessionPrincipal);
    const world = harness.worlds.get(first.worldId);
    if (!world) throw new Error("web-chat world missing after connection");
    world.metadata = {
      roles: { [first.userId]: "ADMIN" },
      roleSources: { [first.userId]: "manual" },
    };
    harness.updateWorld.mockClear();

    const second = await connect(harness, machineSessionPrincipal);
    expect(second.userId).toBe(first.userId);
    expect(harness.updateWorld).not.toHaveBeenCalled();
    expect(world.metadata?.roles?.[first.userId]).toBe("ADMIN");
    expect(world.metadata?.roleSources?.[first.userId]).toBe("manual");
  });

  it("re-asserts the grant idempotently on later turns of the same session", async () => {
    const harness = createRuntimeHarness();
    const first = await connect(harness, machineSessionPrincipal);
    harness.updateWorld.mockClear();
    const second = await connect(harness, machineSessionPrincipal);
    expect(second.userId).toBe(first.userId);
    // Existing USER grant satisfies the boundary role — no redundant write.
    expect(harness.updateWorld).not.toHaveBeenCalled();
  });
});
