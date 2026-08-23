/**
 * Owner-entity parity for the agent host's identity surfaces: the client-chat
 * admin resolution (`resolveClientChatAdminEntityId`), the trust fallback
 * (`resolveFallbackOwnerEntityId`), and core's `resolveOwnerEntityIdOrDefault`
 * must agree on the owner id in every provisioning state, because owner-scoped
 * rows written under one id are invisible to readers scanning another.
 * Deterministic unit harness over hand-built state objects; real derivation
 * code, no mocks.
 */
import {
  deterministicOwnerEntityId,
  type IAgentRuntime,
  resolveOwnerEntityIdOrDefault,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { resolveFallbackOwnerEntityId } from "../runtime/owner-entity.ts";
import { resolveClientChatAdminEntityId } from "./client-chat-admin.ts";

const AGENT_ID = "4c2a1d0e-9f8b-4a7c-8d6e-5f4a3b2c1d0e" as UUID;
const AGENT_NAME = "Eliza";
const CONFIGURED_OWNER = "7b3e2f7a-1111-4222-8333-944445555666" as UUID;

type ParityState = {
  runtime: IAgentRuntime | null;
  agentName: string;
  adminEntityId?: UUID | null;
  chatUserId?: UUID | null;
  config?: { agents?: { defaults?: { adminEntityId?: string } } } | null;
};

function runtimeStub(
  getSetting: (key: string) => unknown = () => null,
): IAgentRuntime {
  return {
    agentId: AGENT_ID,
    character: { name: AGENT_NAME },
    getSetting,
  } as unknown as IAgentRuntime;
}

describe("resolveClientChatAdminEntityId — owner-entity parity", () => {
  it("unconfigured: chat, trust fallback, and core agree on the agent-id seed", () => {
    const runtime = runtimeStub();
    const state: ParityState = { runtime, agentName: AGENT_NAME };

    const chatOwner = resolveClientChatAdminEntityId(state);

    expect(chatOwner).toBe(deterministicOwnerEntityId(AGENT_ID));
    expect(chatOwner).toBe(resolveOwnerEntityIdOrDefault(runtime));
    expect(chatOwner).toBe(resolveFallbackOwnerEntityId(runtime));
    expect(chatOwner).not.toBe(stringToUuid(`${AGENT_NAME}-admin-entity`));
    expect(state.adminEntityId).toBe(chatOwner);
    expect(state.chatUserId).toBe(chatOwner);
  });

  it("configured canonical owner wins on every surface and overrides a cached id", () => {
    const runtime = runtimeStub((key) =>
      key === "ELIZA_ADMIN_ENTITY_ID" ? CONFIGURED_OWNER : null,
    );
    const state: ParityState = {
      runtime,
      agentName: AGENT_NAME,
      adminEntityId: deterministicOwnerEntityId(AGENT_ID),
    };

    expect(resolveClientChatAdminEntityId(state)).toBe(CONFIGURED_OWNER);
    expect(resolveOwnerEntityIdOrDefault(runtime)).toBe(CONFIGURED_OWNER);
    expect(state.chatUserId).toBe(CONFIGURED_OWNER);
  });

  it("a configured agents.defaults.adminEntityId UUID is used before the seed", () => {
    const state = {
      runtime: runtimeStub(),
      agentName: AGENT_NAME,
      config: { agents: { defaults: { adminEntityId: CONFIGURED_OWNER } } },
    };
    expect(resolveClientChatAdminEntityId(state)).toBe(CONFIGURED_OWNER);
  });

  it("a malformed configured admin entity id falls back to the agent-id seed", () => {
    const state = {
      runtime: runtimeStub(),
      agentName: AGENT_NAME,
      config: { agents: { defaults: { adminEntityId: "not-a-uuid" } } },
    };
    expect(resolveClientChatAdminEntityId(state)).toBe(
      deterministicOwnerEntityId(AGENT_ID),
    );
  });

  it("without a runtime the only available seed is the agent name", () => {
    const state = { runtime: null, agentName: AGENT_NAME };
    expect(resolveClientChatAdminEntityId(state)).toBe(
      stringToUuid(`${AGENT_NAME}-admin-entity`),
    );
  });
});
