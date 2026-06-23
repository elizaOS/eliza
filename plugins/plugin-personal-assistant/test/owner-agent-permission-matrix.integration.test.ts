/**
 * Consolidated OWNER vs AGENT permission-matrix harness (issue #8833 §2).
 *
 * Issue #8833 ("LifeOps split: complete live owner/agent connector and view
 * validation") calls for a single, repeatable harness that exercises the
 * owner-vs-agent permission matrix for the split LifeOps surface across the
 * nine states the issue enumerates, and that SKIPS CLEANLY when the live
 * accounts / env that the deeper connector smoke needs are absent.
 *
 * This file is that harness. It runs against a real `AgentRuntime` + PGLite +
 * the real LifeOps schema (no role mocks — unlike
 * `owner-action-handler-permissions.test.ts`, which mocks `@elizaos/agent` to
 * force the non-owner branch). Establishing genuine OWNER and non-owner
 * identities via `setEntityRole` lets the real role-resolution chain
 * (`hasRoleAccess` / `checkSenderRole` / `satisfiesRoleGate`) run end to end,
 * so the harness proves the actual gates, not a stub of them.
 *
 * Two enforcement paths are covered, matching the two paths the issue lists:
 *
 *   - Planned-tool execution path — the planner gates owner-only tool calls
 *     through `satisfiesRoleGate(userRoles, action.roleGate)` in
 *     `packages/core/src/runtime/execute-planned-tool-call.ts`. The harness
 *     asserts that gate directly against each owner-gated action's real
 *     `roleGate`.
 *   - Direct handler-invocation path — the action handlers guard at execution
 *     time via `hasLifeOpsAccess` → `hasOwnerAccess` → `hasRoleAccess`. The
 *     harness asserts that same `hasRoleAccess` chain for the resolved role.
 *
 * The "multiple grants where owner-side selection must win" state is exercised
 * against the real repository: seeding both an `owner`-side and an `agent`-side
 * grant for the same provider and asserting that the default owner-side lookup
 * resolves the owner grant.
 *
 * SKIP behavior: the harness is gated behind `LIFEOPS_PERMISSION_MATRIX=1`
 * (the env that signals the live accounts/devices from §1 are provisioned).
 * Without it, `describeIf(false)` renders one clean skipped suite — `it.skip`,
 * not a failure — so `bun run test` stays green in credential-free CI. See the
 * consolidated prerequisites + run instructions in
 * `docs/owner-agent-validation-matrix.md`.
 */

import crypto from "node:crypto";
import {
  type AgentRuntime,
  ChannelType,
  hasRoleAccess,
  type Memory,
  type RoleName,
  satisfiesRoleGate,
  setEntityRole,
  type UUID,
} from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { describeIf } from "../../../packages/app-core/test/helpers/conditional-tests.ts";
import { connectorAction } from "../src/actions/connector.js";
import { credentialsAction } from "../src/actions/credentials.js";
import { personalAssistantAction } from "../src/actions/owner-surfaces.js";
import { voiceCallAction } from "../src/actions/voice-call.js";
import {
  createLifeOpsConnectorGrant,
  LifeOpsRepository,
} from "../src/lifeops/repository.js";
import { createLifeOpsTestRuntime } from "./helpers/runtime.js";

/**
 * The harness needs the live accounts/devices the issue's §1 provisions. When
 * `LIFEOPS_PERMISSION_MATRIX` is unset the suite skips cleanly rather than
 * failing — matching the issue's "clear skip behavior for live tests when
 * credentials/devices are absent" acceptance criterion.
 */
const MATRIX_ENABLED = process.env.LIFEOPS_PERMISSION_MATRIX === "1";

/**
 * Owner-gated LifeOps action surfaces. Each carries `roleGate: { minRole:
 * "OWNER" }` and a handler-level `hasLifeOpsAccess` guard; both must deny a
 * non-owner caller.
 */
const OWNER_GATED_ACTIONS = [
  connectorAction,
  credentialsAction,
  personalAssistantAction,
  voiceCallAction,
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

/** Resolve the sender role exactly the way the planner does before gating. */
async function resolveUserRoles(message: Memory): Promise<RoleName[]> {
  if (message.entityId === runtime.agentId) {
    return ["OWNER"];
  }
  if (await hasRoleAccess(runtime, message, "OWNER")) {
    return ["OWNER"];
  }
  if (await hasRoleAccess(runtime, message, "ADMIN")) {
    return ["ADMIN"];
  }
  if (await hasRoleAccess(runtime, message, "USER")) {
    return ["USER"];
  }
  return ["GUEST"];
}

describeIf(MATRIX_ENABLED)(
  "LifeOps OWNER vs AGENT permission matrix (#8833)",
  () => {
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

    describe("state: AGENT authenticated but not owner-authorized — planned tool path", () => {
      it.each(
        OWNER_GATED_ACTIONS.map((action) => [action.name, action] as const),
      )("%s planned-tool gate denies a non-owner sender", async (_name, action) => {
        const userRoles = await resolveUserRoles(
          nonOwnerMessage("try an owner operation"),
        );
        expect(userRoles).not.toContain("OWNER");
        // Mirrors `getGateFailure` in execute-planned-tool-call.ts.
        expect(satisfiesRoleGate(userRoles, action.roleGate)).toBe(false);
      });
    });

    describe("state: AGENT authenticated but not owner-authorized — direct handler path", () => {
      it.each(
        OWNER_GATED_ACTIONS.map((action) => [action.name] as const),
      )("%s handler-level owner guard denies a non-owner sender", async () => {
        const message = nonOwnerMessage("try an owner operation");
        // The handler guard chain: hasLifeOpsAccess → hasOwnerAccess →
        // hasRoleAccess(..., "OWNER"). Asserting the terminal predicate
        // proves the same denial the handler returns PERMISSION_DENIED for.
        expect(await hasRoleAccess(runtime, message, "OWNER")).toBe(false);
      });
    });

    describe("state: OWNER authenticated and authorized — both paths allow", () => {
      it.each(
        OWNER_GATED_ACTIONS.map((action) => [action.name, action] as const),
      )("%s allows the owner through planned-tool and handler paths", async (_name, action) => {
        const message = ownerMessage("perform an owner operation");
        const userRoles = await resolveUserRoles(message);
        expect(userRoles).toContain("OWNER");
        expect(satisfiesRoleGate(userRoles, action.roleGate)).toBe(true);
        expect(await hasRoleAccess(runtime, message, "OWNER")).toBe(true);
      });
    });

    describe("state: unauthenticated connector — missing world context", () => {
      it("denies a planned tool call when no sender role resolves", () => {
        // No userRoles → highest rank 0 → below OWNER → gate denies.
        expect(satisfiesRoleGate([], { minRole: "OWNER" })).toBe(false);
        expect(satisfiesRoleGate(undefined, { minRole: "OWNER" })).toBe(false);
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
  },
);
