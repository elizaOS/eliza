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
  runtime?:
    | IAgentRuntime
    | { agentId?: UUID; getSetting?: (key: string) => unknown }
    | null;
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

const CACHED_OWNER = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" as UUID;
const NAME_SEED = stringToUuid(`${AGENT_NAME}-admin-entity`);

describe("resolveClientChatAdminEntityId — resolution order and edges", () => {
  it("reuses a previously resolved adminEntityId when no canonical owner is set", () => {
    const state: ParityState = {
      runtime: runtimeStub(),
      agentName: AGENT_NAME,
      adminEntityId: CACHED_OWNER,
    };

    expect(resolveClientChatAdminEntityId(state)).toBe(CACHED_OWNER);
    expect(state.adminEntityId).toBe(CACHED_OWNER);
    expect(state.chatUserId).toBe(CACHED_OWNER);
  });

  it("a cached adminEntityId wins over agents.defaults.adminEntityId", () => {
    const state: ParityState = {
      runtime: runtimeStub(),
      agentName: AGENT_NAME,
      adminEntityId: CACHED_OWNER,
      config: { agents: { defaults: { adminEntityId: CONFIGURED_OWNER } } },
    };

    expect(resolveClientChatAdminEntityId(state)).toBe(CACHED_OWNER);
    expect(state.chatUserId).toBe(CACHED_OWNER);
  });

  it("a non-UUID canonical owner is ignored so a cached id is used", () => {
    const runtime = runtimeStub((key) =>
      key === "ELIZA_ADMIN_ENTITY_ID" ? "not-a-uuid" : null,
    );
    const state: ParityState = {
      runtime,
      agentName: AGENT_NAME,
      adminEntityId: CACHED_OWNER,
    };

    expect(resolveClientChatAdminEntityId(state)).toBe(CACHED_OWNER);
    expect(state.chatUserId).toBe(CACHED_OWNER);
  });

  it("a non-UUID canonical owner with no cache falls through to the agent-id seed", () => {
    const runtime = runtimeStub((key) =>
      key === "ELIZA_ADMIN_ENTITY_ID" ? "not-a-uuid" : null,
    );
    const state: ParityState = { runtime, agentName: AGENT_NAME };

    expect(resolveClientChatAdminEntityId(state)).toBe(
      deterministicOwnerEntityId(AGENT_ID),
    );
  });

  it("skips canonical lookup when runtime.getSetting is not a function", () => {
    const state: ParityState = {
      runtime: { agentId: AGENT_ID },
      agentName: AGENT_NAME,
    };

    expect(resolveClientChatAdminEntityId(state)).toBe(
      deterministicOwnerEntityId(AGENT_ID),
    );
    expect(state.adminEntityId).toBe(deterministicOwnerEntityId(AGENT_ID));
    expect(state.chatUserId).toBe(deterministicOwnerEntityId(AGENT_ID));
  });

  it("skips canonical lookup when runtime is undefined", () => {
    const state: ParityState = { agentName: AGENT_NAME };

    expect(resolveClientChatAdminEntityId(state)).toBe(NAME_SEED);
    expect(state.adminEntityId).toBe(NAME_SEED);
    expect(state.chatUserId).toBe(NAME_SEED);
  });

  it("trims surrounding whitespace on a configured adminEntityId UUID", () => {
    const state: ParityState = {
      runtime: runtimeStub(),
      agentName: AGENT_NAME,
      config: {
        agents: { defaults: { adminEntityId: `  ${CONFIGURED_OWNER}  ` } },
      },
    };

    expect(resolveClientChatAdminEntityId(state)).toBe(CONFIGURED_OWNER);
    expect(state.adminEntityId).toBe(CONFIGURED_OWNER);
    expect(state.chatUserId).toBe(CONFIGURED_OWNER);
  });

  it("accepts an uppercase configured adminEntityId UUID", () => {
    const upper = CONFIGURED_OWNER.toUpperCase();
    const state = {
      runtime: runtimeStub(),
      agentName: AGENT_NAME,
      config: { agents: { defaults: { adminEntityId: upper } } },
    };

    expect(resolveClientChatAdminEntityId(state)).toBe(upper);
  });

  it("treats a whitespace-only configured adminEntityId as absent", () => {
    const state = {
      runtime: runtimeStub(),
      agentName: AGENT_NAME,
      config: { agents: { defaults: { adminEntityId: "   " } } },
    };

    expect(resolveClientChatAdminEntityId(state)).toBe(
      deterministicOwnerEntityId(AGENT_ID),
    );
  });

  it("ignores a non-string configured adminEntityId", () => {
    const state = {
      runtime: runtimeStub(),
      agentName: AGENT_NAME,
      config: {
        agents: {
          defaults: {
            adminEntityId: 42 as unknown as string,
          },
        },
      },
    };

    expect(resolveClientChatAdminEntityId(state)).toBe(
      deterministicOwnerEntityId(AGENT_ID),
    );
  });

  it("ignores an empty-string cached adminEntityId as missing", () => {
    const state = {
      runtime: runtimeStub(),
      agentName: AGENT_NAME,
      adminEntityId: "" as UUID,
    };

    expect(resolveClientChatAdminEntityId(state)).toBe(
      deterministicOwnerEntityId(AGENT_ID),
    );
  });

  it("falls back to the agent-name seed when runtime has no string agentId", () => {
    const state: ParityState = {
      runtime: {
        getSetting: () => null,
      },
      agentName: AGENT_NAME,
    };

    expect(resolveClientChatAdminEntityId(state)).toBe(NAME_SEED);
    expect(state.adminEntityId).toBe(NAME_SEED);
    expect(state.chatUserId).toBe(NAME_SEED);
  });

  it("falls back to the agent-name seed when agentId is not a string", () => {
    const state = {
      runtime: {
        agentId: 123 as unknown as UUID,
        getSetting: () => null,
      },
      agentName: AGENT_NAME,
    };

    expect(resolveClientChatAdminEntityId(state)).toBe(NAME_SEED);
  });

  it("treats missing config.agents.defaults as unconfigured", () => {
    const state: ParityState = {
      runtime: runtimeStub(),
      agentName: AGENT_NAME,
      config: { agents: {} },
    };

    expect(resolveClientChatAdminEntityId(state)).toBe(
      deterministicOwnerEntityId(AGENT_ID),
    );
  });

  it("treats a null config object as unconfigured", () => {
    const state: ParityState = {
      runtime: runtimeStub(),
      agentName: AGENT_NAME,
      config: null,
    };

    expect(resolveClientChatAdminEntityId(state)).toBe(
      deterministicOwnerEntityId(AGENT_ID),
    );
  });

  it("a malformed configured id without a runtime uses the agent-name seed", () => {
    const state: ParityState = {
      runtime: null,
      agentName: AGENT_NAME,
      config: { agents: { defaults: { adminEntityId: "not-a-uuid" } } },
    };

    expect(resolveClientChatAdminEntityId(state)).toBe(NAME_SEED);
    expect(state.adminEntityId).toBe(NAME_SEED);
    expect(state.chatUserId).toBe(NAME_SEED);
  });

  it("does not overwrite a cached id when writing chatUserId", () => {
    const state: ParityState = {
      runtime: runtimeStub(),
      agentName: AGENT_NAME,
      adminEntityId: CACHED_OWNER,
      chatUserId: "00000000-0000-4000-8000-000000000000" as UUID,
    };

    const result = resolveClientChatAdminEntityId(state);
    expect(result).toBe(CACHED_OWNER);
    expect(state.adminEntityId).toBe(CACHED_OWNER);
    expect(state.chatUserId).toBe(CACHED_OWNER);
  });
});
