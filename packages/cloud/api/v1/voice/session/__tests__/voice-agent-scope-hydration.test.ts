/**
 * Proves realtime voice cold-start hydration warms EVERY cache a turn reads.
 *
 * The production voice turn is cache-only twice: the scope gate reads the voice
 * shared-agent entry, and `SharedRuntimeChatService.characterFor` then reads
 * `character:data:{characterId}`. Warming only the first left the second cold,
 * so a session that survived `agent_cache_warming` immediately failed with
 * `shared_runtime_cache_warming` on the next turn (measured live on staging,
 * 2026-08-05: turns alternated between the two 503s and produced no audio).
 *
 * These tests are bidirectional: hydration must FILL both entries, and must
 * still publish the authorization scope when the optional character prefill
 * fails, so a character outage cannot regress cold start into a hard failure.
 */

import { afterEach, expect, mock, test } from "bun:test";

process.env.MOCK_REDIS = "1";

const AGENT_ID = "0f1f3a2a-32c1-4f10-8a3f-3b6a3a4bb001";
const CHARACTER_ID = "6a1c8bf0-6d54-4f21-9c31-2a0cbb77aa02";
const ORGANIZATION_ID = "org-voice-hydration";
const USER_ID = "user-voice-hydration";
const CONVERSATION_ID = "conversation-voice-hydration";

const claims = {
  agentId: AGENT_ID,
  conversationId: CONVERSATION_ID,
  organizationId: ORGANIZATION_ID,
  userId: USER_ID,
};

const sharedAgent = {
  id: AGENT_ID,
  organization_id: ORGANIZATION_ID,
  user_id: USER_ID,
  execution_tier: "shared",
  agent_name: "Voice Hydration",
  character_id: CHARACTER_ID,
};

const linkedCharacter = {
  id: CHARACTER_ID,
  organization_id: ORGANIZATION_ID,
  name: "Hydrated Character",
};

const findByIdAndOrg = mock(async () => sharedAgent);
const findByIdInOrganization = mock(async () => linkedCharacter);

mock.module("@/db/repositories/agent-sandboxes", () => ({
  agentSandboxesRepository: { findByIdAndOrg },
}));
mock.module("@/db/repositories/characters", () => ({
  userCharactersRepository: { findByIdInOrganization },
}));
mock.module("@/db/client", () => ({
  runWithDbCacheAsync: async (fn: () => Promise<void>) => await fn(),
}));
const warmInferenceAdmissionSnapshot = mock(async () => undefined);
mock.module("@/lib/services/inference-admission-snapshot", () => ({
  warmInferenceAdmissionSnapshot,
}));

const { cache } = await import("@/lib/cache/client");
const { CacheKeys } = await import("@/lib/cache/keys");
const { runWithCloudBindingsAsync } = await import(
  "@/lib/runtime/cloud-bindings"
);
const { hydrateVoiceSharedAgentScope } = await import(
  "../lib/voice-agent-scope-hydration"
);

const SCOPE_KEY = CacheKeys.sharedAgentScope.voice(
  ORGANIZATION_ID,
  USER_ID,
  AGENT_ID,
);
const CHARACTER_KEY = `character:data:${CHARACTER_ID}`;
const env = {
  CACHE_ENABLED: "true",
  DATABASE_URL: "postgresql://must-not-connect.invalid/eliza",
};

afterEach(async () => {
  await runWithCloudBindingsAsync(env, async () => {
    await cache.del(SCOPE_KEY);
    await cache.del(CHARACTER_KEY);
  });
  findByIdAndOrg.mockClear();
  findByIdInOrganization.mockClear();
  warmInferenceAdmissionSnapshot.mockClear();
  findByIdInOrganization.mockImplementation(async () => linkedCharacter);
});

test("one cold hydration warms BOTH the scope gate and the linked character", async () => {
  await runWithCloudBindingsAsync(env, async () => {
    expect(await cache.get(SCOPE_KEY)).toBeFalsy();
    expect(await cache.get(CHARACTER_KEY)).toBeFalsy();

    await hydrateVoiceSharedAgentScope(
      env as unknown as Parameters<typeof hydrateVoiceSharedAgentScope>[0],
      claims,
    );

    // Both cache-only reads the next turn performs must now hit. Warming only
    // the scope entry is exactly what burned a second turn on staging.
    expect(await cache.get(SCOPE_KEY)).toMatchObject({ id: AGENT_ID });
    expect(await cache.get(CHARACTER_KEY)).toMatchObject({ id: CHARACTER_ID });
    expect(findByIdInOrganization).toHaveBeenCalledWith(
      CHARACTER_ID,
      ORGANIZATION_ID,
    );
    expect(warmInferenceAdmissionSnapshot).toHaveBeenCalledWith(
      ORGANIZATION_ID,
    );
  });
});

test("publishes the authorization scope even when the character prefill fails", async () => {
  findByIdInOrganization.mockImplementation(async () => {
    throw new Error("character store unavailable");
  });

  await runWithCloudBindingsAsync(env, async () => {
    await hydrateVoiceSharedAgentScope(
      env as unknown as Parameters<typeof hydrateVoiceSharedAgentScope>[0],
      claims,
    );

    // The scope entry is the authorization gate: an optional prefill outage
    // must not hold it back, or cold start regresses into a hard failure.
    expect(await cache.get(SCOPE_KEY)).toMatchObject({ id: AGENT_ID });
    expect(await cache.get(CHARACTER_KEY)).toBeFalsy();
  });
});

test("does not overwrite an already-warm character entry", async () => {
  await runWithCloudBindingsAsync(env, async () => {
    await cache.set(CHARACTER_KEY, { id: CHARACTER_ID, name: "Existing" }, 60);

    await hydrateVoiceSharedAgentScope(
      env as unknown as Parameters<typeof hydrateVoiceSharedAgentScope>[0],
      claims,
    );

    expect(findByIdInOrganization).not.toHaveBeenCalled();
    expect(await cache.get(CHARACTER_KEY)).toMatchObject({ name: "Existing" });
  });
});

test("refuses to publish scope for an agent outside the verified voice claims", async () => {
  findByIdAndOrg.mockImplementation(async () => ({
    ...sharedAgent,
    user_id: "someone-else",
  }));

  await runWithCloudBindingsAsync(env, async () => {
    await hydrateVoiceSharedAgentScope(
      env as unknown as Parameters<typeof hydrateVoiceSharedAgentScope>[0],
      claims,
    );

    expect(await cache.get(SCOPE_KEY)).toBeFalsy();
    expect(await cache.get(CHARACTER_KEY)).toBeFalsy();
  });

  findByIdAndOrg.mockImplementation(async () => sharedAgent);
});
