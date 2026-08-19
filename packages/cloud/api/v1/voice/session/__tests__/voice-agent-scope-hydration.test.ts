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
  PRE_DELETE_BACKUP_RETENTION_MS: 0,
  agentSandboxesRepository: { findByIdAndOrg },
  prepareAgentBackupInsertData: mock(async (value: unknown) => value),
}));
mock.module("@/db/repositories/characters", () => ({
  userCharactersRepository: { findByIdInOrganization },
}));
mock.module("@/db/client", () => ({
  runWithDbCacheAsync: async (fn: () => Promise<void>) => await fn(),
}));
const warmInferenceAdmissionSnapshot = mock(async () => undefined);
mock.module("@/lib/services/inference-admission-snapshot", () => ({
  InferenceAdmissionSnapshotCacheWarmingError: class extends Error {},
  getInferenceAdmissionSnapshotCacheOnly: mock(async () => null),
  inferenceRateLimitConfig: mock(() => undefined),
  loadInferenceAdmissionSnapshot: mock(async () => null),
  warmInferenceAdmissionSnapshot,
}));
const warmInferenceAdmissionGate = mock(async () => undefined);
const warmInferenceRateLimitGate = mock(async () => undefined);
mock.module("@/lib/services/inference-admission-gate", () => ({
  warmInferenceAdmissionGate,
  warmInferenceRateLimitGate,
}));
const calculateCost = mock(async () => ({
  inputCost: 0,
  outputCost: 0,
  totalCost: 0,
}));
mock.module("@/lib/pricing", () => ({
  calculateCost,
  getProviderFromModel: () => "cerebras",
  normalizeModelName: (model: string) => model.replace(/^cerebras\//, ""),
}));
mock.module("@/lib/voice-session/config", () => ({
  resolveElizaModel: () => "cerebras/gemma-4-31b",
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
  warmInferenceAdmissionGate.mockClear();
  warmInferenceRateLimitGate.mockClear();
  calculateCost.mockClear();
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
    expect(warmInferenceAdmissionGate).toHaveBeenCalledWith(ORGANIZATION_ID);
    expect(warmInferenceRateLimitGate).toHaveBeenCalledWith(ORGANIZATION_ID);
    expect(calculateCost).toHaveBeenCalledWith(
      "gemma-4-31b",
      "cerebras",
      1,
      1,
      "bitrouter",
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

test("publishes the authorization scope before optional admission prefill completes", async () => {
  let resolveAdmission: () => void = () => {};
  warmInferenceAdmissionSnapshot.mockImplementationOnce(
    () =>
      new Promise<undefined>((resolve) => {
        resolveAdmission = () => resolve(undefined);
      }),
  );

  await runWithCloudBindingsAsync(env, async () => {
    const hydration = hydrateVoiceSharedAgentScope(
      env as unknown as Parameters<typeof hydrateVoiceSharedAgentScope>[0],
      claims,
    );

    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (await cache.get(SCOPE_KEY)) break;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(await cache.get(SCOPE_KEY)).toMatchObject({ id: AGENT_ID });

    resolveAdmission();
    await hydration;
  });
});

test("prewarms the call conversation while the fixed greeting is playing", async () => {
  const requests: Request[] = [];
  const voiceEnv = {
    ...env,
    SHARED_RUNTIME_CONVERSATIONS: {
      getByName(name: string) {
        expect(name).toBe(`${AGENT_ID}:${CONVERSATION_ID}`);
        return {
          async fetch(input: RequestInfo | URL, init?: RequestInit) {
            requests.push(new Request(input, init));
            return Response.json({ success: true });
          },
        };
      },
    },
  };

  await runWithCloudBindingsAsync(voiceEnv, async () => {
    await hydrateVoiceSharedAgentScope(
      voiceEnv as unknown as Parameters<typeof hydrateVoiceSharedAgentScope>[0],
      claims,
      sharedAgent as never,
    );
  });

  expect(requests).toHaveLength(1);
  const request = requests[0];
  if (!request) throw new Error("expected conversation prewarm request");
  expect(request.url).toBe("https://shared-runtime.internal/prewarm");
  const body = (await request.json()) as unknown;
  expect(body).toEqual({
    operation: "prewarm",
    agentId: AGENT_ID,
    roomId: CONVERSATION_ID,
    startEmpty: false,
  });
});

test("marks a newly minted phone-call conversation as empty", async () => {
  const requests: Request[] = [];
  const voiceEnv = {
    ...env,
    SHARED_RUNTIME_CONVERSATIONS: {
      getByName() {
        return {
          async fetch(input: RequestInfo | URL, init?: RequestInit) {
            requests.push(new Request(input, init));
            return Response.json({ success: true });
          },
        };
      },
    },
  };

  await runWithCloudBindingsAsync(voiceEnv, async () => {
    await hydrateVoiceSharedAgentScope(
      voiceEnv as unknown as Parameters<typeof hydrateVoiceSharedAgentScope>[0],
      claims,
      sharedAgent as never,
      { freshConversation: true },
    );
  });

  const request = requests[0];
  if (!request) throw new Error("expected fresh conversation prewarm request");
  const body = (await request.json()) as unknown;
  expect(body).toEqual({
    operation: "prewarm",
    agentId: AGENT_ID,
    roomId: CONVERSATION_ID,
    startEmpty: true,
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
