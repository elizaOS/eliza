/**
 * Unit tests for `fetchCloudVoiceCatalog`.
 *
 * The catalog merges two upstream endpoints (`getApiElevenlabsVoices` for
 * premade voices and `getApiElevenlabsVoicesUser` for user-cloned voices)
 * and caches the result in memory. These tests cover:
 *   - Normalization across the heterogeneous upstream shapes.
 *   - Cache hits within the TTL (no second SDK call).
 *   - Empty-array return when the runtime isn't cloud-connected (no SDK call
 *     at all, since the gate runs before the HTTP fetch).
 *   - Per-endpoint failure isolation (one endpoint erroring still surfaces
 *     the other's voices).
 *
 * The SDK client is swapped via `setCloudVoiceClientFactoryForTesting` so
 * the tests never hit the real network and never need a working
 * `createElizaCloudClient`. After each test we restore the factory.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type CloudVoiceClient,
  fetchCloudVoiceCatalog,
  resetCloudVoiceCatalogCacheForTesting,
  setCloudVoiceClientFactoryForTesting,
} from "./cloud-voice-catalog";

interface RuntimeOptions {
  connected?: boolean;
  apiKey?: string;
  baseUrl?: string;
}

function makeRuntime(opts: RuntimeOptions = {}): IAgentRuntime {
  const apiKey = opts.apiKey ?? "test-cloud-key";
  const baseUrl = opts.baseUrl ?? "https://cloud.test.local/api/v1";
  const enabled = opts.connected === false ? "false" : "true";
  const settings: Record<string, string | null> = {
    ELIZAOS_CLOUD_API_KEY: opts.connected === false ? null : apiKey,
    ELIZAOS_CLOUD_ENABLED: enabled,
    ELIZAOS_CLOUD_BASE_URL: baseUrl,
  };
  return {
    getSetting: (key: string) => settings[key] ?? undefined,
  } as unknown as IAgentRuntime;
}

interface FakeRoutesCallLog {
  premade: number;
  user: number;
}

function makeFakeClient(payloads: {
  premade?: unknown;
  user?: unknown;
  premadeError?: Error;
  userError?: Error;
}): { client: CloudVoiceClient; calls: FakeRoutesCallLog } {
  const calls: FakeRoutesCallLog = { premade: 0, user: 0 };
  const client: CloudVoiceClient = {
    routes: {
      async getApiElevenlabsVoices<T = unknown>(): Promise<T> {
        calls.premade += 1;
        if (payloads.premadeError) throw payloads.premadeError;
        return payloads.premade as T;
      },
      async getApiElevenlabsVoicesUser<T = unknown>(): Promise<T> {
        calls.user += 1;
        if (payloads.userError) throw payloads.userError;
        return payloads.user as T;
      },
    },
  };
  return { client, calls };
}

const PREMADE_VOICES_PAYLOAD = {
  voices: [
    {
      voice_id: "EXAVITQu4vr4xnSDxMaL",
      name: "Sarah",
      preview_url: "https://cdn.example/sarah.mp3",
      category: "premade",
      labels: { gender: "female", language: "en" },
    },
    {
      voice_id: "21m00Tcm4TlvDq8ikWAM",
      name: "Rachel",
      preview_url: "https://cdn.example/rachel.mp3",
      category: "premade",
      labels: { gender: "female" },
    },
    // Bare ID — should still normalize.
    { id: "minimal-id-voice" },
    // Malformed entries should be dropped.
    {},
    null,
    "not-an-object",
  ],
};

const USER_VOICES_PAYLOAD = [
  {
    voice_id: "user-clone-1",
    name: "My Clone",
    category: "cloned",
    labels: { gender: "male", language_code: "es" },
  },
  // Duplicate of a premade ID — premade should be deduped out, but the user
  // entry should win (it comes first in the merge).
  {
    voice_id: "EXAVITQu4vr4xnSDxMaL",
    name: "Sarah (clone)",
  },
];

describe("fetchCloudVoiceCatalog", () => {
  beforeEach(() => {
    resetCloudVoiceCatalogCacheForTesting();
  });
  afterEach(() => {
    setCloudVoiceClientFactoryForTesting(null);
    resetCloudVoiceCatalogCacheForTesting();
  });

  it("returns an empty array when the runtime is not cloud-connected (no SDK calls)", async () => {
    const { client, calls } = makeFakeClient({
      premade: PREMADE_VOICES_PAYLOAD,
      user: USER_VOICES_PAYLOAD,
    });
    setCloudVoiceClientFactoryForTesting(() => client);

    const voices = await fetchCloudVoiceCatalog(makeRuntime({ connected: false }));
    expect(voices).toEqual([]);
    // The gate runs before the HTTP fetch, so neither endpoint is called.
    expect(calls.premade).toBe(0);
    expect(calls.user).toBe(0);
  });

  it("normalizes premade + user voices and dedupes by id (user wins)", async () => {
    const { client, calls } = makeFakeClient({
      premade: PREMADE_VOICES_PAYLOAD,
      user: USER_VOICES_PAYLOAD,
    });
    setCloudVoiceClientFactoryForTesting(() => client);

    const voices = await fetchCloudVoiceCatalog(makeRuntime());

    expect(calls.premade).toBe(1);
    expect(calls.user).toBe(1);

    // Expected order: user voices first (clone + dupe), then unique premade.
    const ids = voices.map((v) => v.id);
    expect(ids).toEqual([
      "user-clone-1",
      "EXAVITQu4vr4xnSDxMaL", // dupe — user copy wins
      "21m00Tcm4TlvDq8ikWAM",
      "minimal-id-voice",
    ]);

    // User clone normalization.
    const userClone = voices.find((v) => v.id === "user-clone-1");
    expect(userClone).toMatchObject({
      id: "user-clone-1",
      name: "My Clone",
      gender: "male",
      category: "cloned",
      language: "es",
    });

    // Premade normalization.
    const rachel = voices.find((v) => v.id === "21m00Tcm4TlvDq8ikWAM");
    expect(rachel).toMatchObject({
      id: "21m00Tcm4TlvDq8ikWAM",
      name: "Rachel",
      preview: "https://cdn.example/rachel.mp3",
      gender: "female",
      category: "premade",
    });

    // Dedupe: the user copy of Sarah (cloned) wins over the premade entry.
    const sarah = voices.find((v) => v.id === "EXAVITQu4vr4xnSDxMaL");
    expect(sarah?.name).toBe("Sarah (clone)");

    // Bare-id entry has a fallback display name.
    const minimal = voices.find((v) => v.id === "minimal-id-voice");
    expect(minimal?.name).toBe("minimal-id-voice");
  });

  it("caches results within the 1h TTL — second call does not refetch", async () => {
    const { client, calls } = makeFakeClient({
      premade: PREMADE_VOICES_PAYLOAD,
      user: USER_VOICES_PAYLOAD,
    });
    setCloudVoiceClientFactoryForTesting(() => client);

    const runtime = makeRuntime();
    const a = await fetchCloudVoiceCatalog(runtime);
    const b = await fetchCloudVoiceCatalog(runtime);
    expect(a).toBe(b);
    expect(calls.premade).toBe(1);
    expect(calls.user).toBe(1);
  });

  it("uses different cache entries per runtime base URL + API key", async () => {
    const { client, calls } = makeFakeClient({
      premade: PREMADE_VOICES_PAYLOAD,
      user: USER_VOICES_PAYLOAD,
    });
    setCloudVoiceClientFactoryForTesting(() => client);

    await fetchCloudVoiceCatalog(makeRuntime({ apiKey: "key-1" }));
    await fetchCloudVoiceCatalog(makeRuntime({ apiKey: "key-2" }));
    // Each runtime gets its own cache slot — both fetched once.
    expect(calls.premade).toBe(2);
    expect(calls.user).toBe(2);
  });

  it("isolates per-endpoint failures — one endpoint erroring still returns the other's voices", async () => {
    const { client } = makeFakeClient({
      premade: PREMADE_VOICES_PAYLOAD,
      userError: new Error("user endpoint down"),
    });
    setCloudVoiceClientFactoryForTesting(() => client);

    const voices = await fetchCloudVoiceCatalog(makeRuntime());
    // Only premade voices come back; the user endpoint failure is swallowed.
    expect(voices.map((v) => v.id).sort()).toEqual(
      ["21m00Tcm4TlvDq8ikWAM", "EXAVITQu4vr4xnSDxMaL", "minimal-id-voice"].sort(),
    );
  });

  it("returns empty array when both endpoints fail", async () => {
    const { client } = makeFakeClient({
      premadeError: new Error("premade endpoint down"),
      userError: new Error("user endpoint down"),
    });
    setCloudVoiceClientFactoryForTesting(() => client);

    const voices = await fetchCloudVoiceCatalog(makeRuntime());
    expect(voices).toEqual([]);
  });

  it("accepts bare-array payloads (some upstream variants return arrays)", async () => {
    const { client } = makeFakeClient({
      premade: [{ voice_id: "premade-1", name: "Premade One" }],
      user: { items: [{ voice_id: "user-1", name: "User One" }] },
    });
    setCloudVoiceClientFactoryForTesting(() => client);

    const voices = await fetchCloudVoiceCatalog(makeRuntime());
    expect(voices.map((v) => v.id).sort()).toEqual(["premade-1", "user-1"]);
  });
});
