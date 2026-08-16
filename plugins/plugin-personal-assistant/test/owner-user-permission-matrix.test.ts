/**
 * Exercises the credential-free LifeOps OWNER-versus-USER authorization matrix
 * against a real AgentRuntime, PGLite database, action handlers, and planned-tool
 * executor. Actor roles use the core OWNER/ADMIN/USER/GUEST vocabulary; the
 * separate `agent` term below refers only to a connector grant side.
 *
 * Live provider and device validation remains in credential-gated connector
 * lanes. These structural checks always run in the package's ordinary test lane.
 */

import crypto from "node:crypto";
import {
  type AgentRuntime,
  ChannelType,
  executePlannedToolCall,
  hasRoleAccess,
  type Memory,
  setEntityRole,
  type UUID,
} from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { connectorAction } from "../src/actions/connector.js";
import { credentialsAction } from "../src/actions/credentials.js";
import {
  ownerFinancesAction,
  personalAssistantAction,
} from "../src/actions/owner-surfaces.js";
import { voiceCallAction } from "../src/actions/voice-call.js";
import {
  createLifeOpsConnectorGrant,
  LifeOpsRepository,
} from "../src/lifeops/repository.js";
import { createLifeOpsTestRuntime } from "./helpers/runtime.js";

/**
 * Owner-gated LifeOps action surfaces. Each carries `roleGate: { minRole:
 * "OWNER" }`, which the planned-tool execution boundary must enforce before
 * dispatching to the action handler.
 */
const OWNER_GATED_ACTIONS = [
  connectorAction,
  credentialsAction,
  ownerFinancesAction,
  personalAssistantAction,
  voiceCallAction,
] as const;

const OWNER_GATED_ACTION_CASES = [
  [
    connectorAction.name,
    connectorAction,
    { action: "status", connector: "google" },
  ],
  [
    credentialsAction.name,
    credentialsAction,
    { action: "fill", url: "https://example.com" },
  ],
  [ownerFinancesAction.name, ownerFinancesAction, { action: "dashboard" }],
  [
    personalAssistantAction.name,
    personalAssistantAction,
    { action: "book_travel" },
  ],
  [
    voiceCallAction.name,
    voiceCallAction,
    { action: "dial", recipientKind: "owner" },
  ],
] as const;

let runtime: AgentRuntime;
let cleanup: () => Promise<void>;
let repository: LifeOpsRepository;

const OWNER_ROOM_ID = crypto.randomUUID() as UUID;
const NON_OWNER_ENTITY_ID = crypto.randomUUID() as UUID;
const NON_OWNER_ROOM_ID = crypto.randomUUID() as UUID;
const WORLD_ID = crypto.randomUUID() as UUID;

function ownerMessage(text: string): Memory {
  // entityId === agentId → isAgentSelf short-circuits every role tier OWNER.
  return {
    id: crypto.randomUUID() as UUID,
    entityId: runtime.agentId as UUID,
    roomId: OWNER_ROOM_ID,
    worldId: WORLD_ID,
    agentId: runtime.agentId as UUID,
    content: { text, source: "test" },
  } as Memory;
}

function nonOwnerMessage(text: string): Memory {
  return {
    id: crypto.randomUUID() as UUID,
    entityId: NON_OWNER_ENTITY_ID,
    roomId: NON_OWNER_ROOM_ID,
    worldId: WORLD_ID,
    agentId: runtime.agentId as UUID,
    content: { text, source: "test" },
  } as Memory;
}

describe("LifeOps OWNER vs USER permission matrix (#8833)", () => {
  beforeAll(async () => {
    const result = await createLifeOpsTestRuntime({
      characterName: "lifeops-permission-matrix-agent",
    });
    runtime = result.runtime;
    cleanup = result.cleanup;
    await LifeOpsRepository.bootstrapSchema(runtime);
    repository = new LifeOpsRepository(runtime);

    // Establish a genuine non-owner identity: connect the entity to a real
    // world/room and grant it the USER role so the role-resolution chain
    // returns a non-owner result rather than the lenient no-world default.
    await runtime.ensureConnection({
      entityId: NON_OWNER_ENTITY_ID as never,
      roomId: NON_OWNER_ROOM_ID as never,
      worldId: WORLD_ID as never,
      worldName: "LifeOps Permission Matrix World",
      userName: "non-owner-user",
      name: "Non Owner User",
      source: "test",
      type: ChannelType.GROUP,
      channelId: NON_OWNER_ROOM_ID,
    });
    await setEntityRole(
      runtime,
      nonOwnerMessage("seed non-owner role"),
      NON_OWNER_ENTITY_ID,
      "USER",
    );
  }, 180_000);

  afterAll(async () => {
    await cleanup?.();
  });

  describe("state: owner-only actions declare an OWNER role gate", () => {
    it.each(
      OWNER_GATED_ACTIONS.map((action) => [action.name, action] as const),
    )("%s declares roleGate { minRole: OWNER }", (_name, action) => {
      expect(action.roleGate).toEqual({ minRole: "OWNER" });
    });
  });

  describe("state: USER authenticated but not owner-authorized — planned tool path", () => {
    it.each(OWNER_GATED_ACTION_CASES)(
      "%s planned-tool execution denies before the real handler",
      async (_name, action, params) => {
        const handler = vi.fn(action.handler);
        const guardedAction = { ...action, handler };
        const result = await executePlannedToolCall(
          runtime,
          {
            message: nonOwnerMessage("try an owner operation"),
            activeContexts: action.contexts,
            userRoles: ["USER"],
          },
          { name: action.name, params: { ...params } },
          { actions: [guardedAction] },
        );

        expect(result.success).toBe(false);
        expect(String(result.error)).toContain("not allowed");
        expect(handler).not.toHaveBeenCalled();
      },
    );
  });

  describe("state: OWNER authenticated and authorized", () => {
    it.each(
      OWNER_GATED_ACTIONS.map((action) => [action.name, action] as const),
    )("%s resolves the real sender as OWNER", async (_name, _action) => {
      const message = ownerMessage("perform an owner operation");
      expect(await hasRoleAccess(runtime, message, "OWNER")).toBe(true);
    });

    it("dispatches a credential-free CONNECTOR list through the planned-tool boundary to the real handler", async () => {
      const handler = vi.fn(connectorAction.handler);
      const result = await executePlannedToolCall(
        runtime,
        {
          message: ownerMessage("list configured connectors"),
          activeContexts: ["connectors"],
          userRoles: ["OWNER"],
        },
        { name: connectorAction.name, params: { action: "list" } },
        { actions: [{ ...connectorAction, handler }] },
      );

      expect(handler).toHaveBeenCalledOnce();
      expect(String(result.error ?? "")).not.toContain("not allowed");
    });
  });

  describe("state: unauthenticated connector — missing world context", () => {
    it("denies a planned tool call when no sender role resolves", async () => {
      const result = await executePlannedToolCall(
        runtime,
        {
          message: nonOwnerMessage("list configured connectors"),
          activeContexts: ["connectors"],
          userRoles: [],
        },
        { name: connectorAction.name, params: { action: "list" } },
        { actions: [connectorAction] },
      );

      expect(result.success).toBe(false);
      expect(String(result.error)).toContain("not allowed");
    });
  });

  describe("state: missing required scope — capability not granted", () => {
    it("a grant without the required capability does not advertise it", async () => {
      const grant = createLifeOpsConnectorGrant({
        agentId: String(runtime.agentId),
        provider: "google",
        side: "owner",
        identity: { email: "owner@example.com" },
        identityEmail: "owner@example.com",
        grantedScopes: ["https://www.googleapis.com/auth/calendar.readonly"],
        // Read-only: the write capability is intentionally absent so the
        // "missing required scope" state is concrete and assertable.
        capabilities: ["google.calendar.read"],
        tokenRef: "matrix-scope-token",
        mode: "local",
        metadata: {},
        lastRefreshAt: null,
      });
      await repository.upsertConnectorGrant(grant);

      const resolved = await repository.getConnectorGrant(
        String(runtime.agentId),
        "google",
        "local",
        "owner",
      );
      expect(resolved?.capabilities).toContain("google.calendar.read");
      expect(resolved?.capabilities).not.toContain("google.calendar.write");
    });
  });

  describe("state: multiple grants — owner-side selection must win", () => {
    it("resolves the owner-side grant when both owner and agent grants exist", async () => {
      const agentId = String(runtime.agentId);
      const ownerGrant = createLifeOpsConnectorGrant({
        agentId,
        provider: "telegram",
        side: "owner",
        identity: { handle: "owner_handle" },
        identityEmail: null,
        grantedScopes: [],
        capabilities: ["telegram.read", "telegram.send"],
        tokenRef: "matrix-owner-telegram",
        mode: "local",
        metadata: {},
        lastRefreshAt: null,
      });
      const agentGrant = createLifeOpsConnectorGrant({
        agentId,
        provider: "telegram",
        side: "agent",
        identity: { handle: "agent_handle" },
        identityEmail: null,
        grantedScopes: [],
        capabilities: ["telegram.read"],
        tokenRef: "matrix-agent-telegram",
        mode: "local",
        metadata: {},
        lastRefreshAt: null,
      });
      await repository.upsertConnectorGrant(ownerGrant);
      await repository.upsertConnectorGrant(agentGrant);

      // Owner-only operations resolve the default `side="owner"`; the agent
      // grant must not leak into an owner-side lookup.
      const ownerSide = await repository.getConnectorGrant(
        agentId,
        "telegram",
        "local",
        "owner",
      );
      const agentSide = await repository.getConnectorGrant(
        agentId,
        "telegram",
        "local",
        "agent",
      );
      expect(ownerSide?.tokenRef).toBe("matrix-owner-telegram");
      expect(ownerSide?.side).toBe("owner");
      expect(agentSide?.tokenRef).toBe("matrix-agent-telegram");
      expect(ownerSide?.tokenRef).not.toBe(agentSide?.tokenRef);
    });
  });

  describe("state: expired/revoked grant — disconnect clears the owner grant", () => {
    it("a deleted owner grant no longer resolves on the owner side", async () => {
      const agentId = String(runtime.agentId);
      const grant = createLifeOpsConnectorGrant({
        agentId,
        provider: "discord",
        side: "owner",
        identity: { handle: "owner#0001" },
        identityEmail: null,
        grantedScopes: [],
        capabilities: ["discord.read"],
        tokenRef: "matrix-revoked-discord",
        mode: "local",
        metadata: {},
        lastRefreshAt: null,
      });
      await repository.upsertConnectorGrant(grant);
      expect(
        await repository.getConnectorGrant(
          agentId,
          "discord",
          "local",
          "owner",
        ),
      ).not.toBeNull();

      await repository.deleteConnectorGrant(
        agentId,
        "discord",
        "local",
        "owner",
      );
      expect(
        await repository.getConnectorGrant(
          agentId,
          "discord",
          "local",
          "owner",
        ),
      ).toBeNull();
    });
  });
});
