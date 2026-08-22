/**
 * Owner-scope parity across the three LifeOps identity surfaces: the chat
 * write path (`resolveClientChatAdminEntityId`), the HTTP read path (route
 * `LifeOpsService` with no explicit owner), and the scheduler
 * (`runLifeOpsScheduledWork` constructs `new LifeOpsService(runtime)`). All
 * three must derive the same owner `subject_id` in every provisioning state,
 * or rows written on one surface are invisible to the others: the write side
 * used to seed its fallback UUID from the agent NAME while reads and the
 * scheduler seeded from the agent ID, so every chat-created reminder landed
 * in a scope no reader or scheduler ever scanned. Real service construction
 * against the minimal runtime stub; no mocks of the code under test.
 */

import { resolveClientChatAdminEntityId } from "@elizaos/agent/api/client-chat-admin";
import { type IAgentRuntime, stringToUuid, type UUID } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { LifeOpsService } from "../src/lifeops/service.js";
import { createMinimalRuntimeStub } from "./first-run-helpers.ts";

const AGENT_NAME = "Eliza";
const CONFIGURED_OWNER_UUID = "7b3e2f7a-1111-4222-8333-944445555666";

function ownerScopes(runtime: IAgentRuntime): {
  writeScope: string;
  readScope: string;
  schedulerScope: string;
} {
  // Chat write surface: fresh state per call, exactly what the client-chat
  // admin resolution sees on this rig (no prior adminEntityId, no config).
  const writeScope = resolveClientChatAdminEntityId({
    runtime,
    agentName: AGENT_NAME,
  });
  // HTTP route surface: `getService` passes `ctx.state.adminEntityId`, which
  // is undefined on the local route surface.
  const readScope = new LifeOpsService(runtime, {
    ownerEntityId: undefined,
  }).ownerEntityId();
  // Scheduler surface: `runLifeOpsScheduledWork` constructs the service with
  // no options at all.
  const schedulerScope = new LifeOpsService(runtime).ownerEntityId();
  return { writeScope, readScope, schedulerScope };
}

describe("LifeOps owner scope invariant (write == read == scheduler)", () => {
  it("agrees on the agent-id seed when no canonical owner is configured", () => {
    const runtime = createMinimalRuntimeStub();
    const { writeScope, readScope, schedulerScope } = ownerScopes(runtime);

    const agentIdSeed = stringToUuid(`${runtime.agentId}-admin-entity`);
    expect(writeScope).toBe(agentIdSeed);
    expect(readScope).toBe(agentIdSeed);
    expect(schedulerScope).toBe(agentIdSeed);

    // The historical fork: the write side seeded from the agent NAME, which
    // no read or scheduler scope ever scanned.
    const legacyNameSeed = stringToUuid(`${AGENT_NAME}-admin-entity`);
    expect(writeScope).not.toBe(legacyNameSeed);
  });

  it("agrees on the configured canonical owner when ELIZA_ADMIN_ENTITY_ID is a UUID", () => {
    const runtime = createMinimalRuntimeStub({
      getSetting: ((key: string) =>
        key === "ELIZA_ADMIN_ENTITY_ID"
          ? CONFIGURED_OWNER_UUID
          : undefined) as never,
    });
    const { writeScope, readScope, schedulerScope } = ownerScopes(runtime);

    expect(writeScope).toBe(CONFIGURED_OWNER_UUID as UUID);
    expect(readScope).toBe(CONFIGURED_OWNER_UUID);
    expect(schedulerScope).toBe(CONFIGURED_OWNER_UUID);
  });

  it("agrees on the agent-id seed when the configured owner is not a UUID", () => {
    const runtime = createMinimalRuntimeStub({
      getSetting: ((key: string) =>
        key === "ELIZA_ADMIN_ENTITY_ID"
          ? "owner-entity-1"
          : undefined) as never,
    });
    const { writeScope, readScope, schedulerScope } = ownerScopes(runtime);

    const agentIdSeed = stringToUuid(`${runtime.agentId}-admin-entity`);
    expect(writeScope).toBe(agentIdSeed);
    expect(readScope).toBe(agentIdSeed);
    expect(schedulerScope).toBe(agentIdSeed);
  });
});
