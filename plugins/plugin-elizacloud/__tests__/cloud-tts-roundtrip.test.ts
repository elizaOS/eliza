/**
 * Roundtrip tests for the Eliza Cloud TEXT_TO_SPEECH handler.
 *
 * `handleTextToSpeech` lives at `src/models/speech.ts` and uses the cloud
 * SDK via `createElizaCloudClient(runtime).routes.postApiV1VoiceTts`. We
 * replace that with `setCloudTtsClientFactoryForTesting` so the tests never
 * hit the network and never need a configured SDK client.
 *
 * Coverage:
 *   - voiceId + modelId are forwarded to the upstream endpoint
 *   - the handler returns a Uint8Array / ReadableStream-compatible body
 *   - serves in capability-only mode (key + ELIZAOS_CLOUD_USE_TTS=true,
 *     ELIZAOS_CLOUD_ENABLED unset — elizaOS/eliza#10819 / #10961)
 *   - throws `CloudTtsUnavailableError` when cloud TTS is not available
 *     (no key, or key without ENABLED / USE_TTS)
 *   - each call respects its own voiceId (no hidden default lock-in)
 */
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type CloudTtsClient,
  CloudTtsUnavailableError,
  handleTextToSpeech,
  setCloudTtsClientFactoryForTesting,
} from "../src/models/speech";

interface RuntimeOptions {
  connected?: boolean;
  apiKey?: string | null;
  baseUrl?: string;
  /** Explicit ELIZAOS_CLOUD_ENABLED value; null leaves it unset. */
  enabled?: string | null;
  /** Explicit ELIZAOS_CLOUD_USE_TTS value; null leaves it unset. */
  useTts?: string | null;
}

function makeRuntime(opts: RuntimeOptions = {}): IAgentRuntime {
  const apiKey =
    opts.apiKey !== undefined ? opts.apiKey : opts.connected === false ? null : "test-cloud-key";
  const baseUrl = opts.baseUrl ?? "https://cloud.test.local/api/v1";
  const enabled =
    opts.enabled !== undefined ? opts.enabled : opts.connected === false ? "false" : "true";
  const settings: Record<string, string | null> = {
    ELIZAOS_CLOUD_API_KEY: apiKey,
    ELIZAOS_CLOUD_ENABLED: enabled,
    ELIZAOS_CLOUD_USE_TTS: opts.useTts ?? null,
    ELIZAOS_CLOUD_BASE_URL: baseUrl,
  };
  return {
    getSetting: (key: string) => settings[key] ?? undefined,
  } as unknown as IAgentRuntime;
}

// The availability gate reads via the plugin's getSetting, which falls back
// to process.env — isolate the suite from the outer environment so a
// host-written cloud key/flag can't skew the disconnected assertions.
const GATE_ENV_KEYS = [
  "ELIZAOS_CLOUD_API_KEY",
  "ELIZAOS_CLOUD_ENABLED",
  "ELIZAOS_CLOUD_USE_TTS",
] as const;
let savedGateEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  savedGateEnv = {};
  for (const key of GATE_ENV_KEYS) {
    savedGateEnv[key] = process.env[key];
    delete process.env[key];
  }
});
afterEach(() => {
  for (const key of GATE_ENV_KEYS) {
    const saved = savedGateEnv[key];
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  }
});

interface RecordedCall {
  voiceId?: string;
  modelId?: string;
  text: string;
  acceptHeader: string | undefined;
}

function makeFakeClient(bodyBytes: Uint8Array): { client: CloudTtsClient; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const client: CloudTtsClient = {
    routes: {
      async postApiV1VoiceTts<T = unknown>(options: {
        headers?: Record<string, unknown>;
        json: { text: string; voiceId?: string; modelId?: string };
      }): Promise<T> {
        calls.push({
          voiceId: options.json.voiceId,
          modelId: options.json.modelId,
          text: options.json.text,
          acceptHeader: options.headers?.Accept as string | undefined,
        });
        // Return a Response-shaped object whose `body` is a web ReadableStream
        // of `bodyBytes`. Mirrors the upstream HTTP response contract used by
        // `webStreamToNodeStream`.
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bodyBytes);
            controller.close();
          },
        });
        const fakeResponse = {
          ok: true,
          status: 200,
          statusText: "OK",
          body,
          text: async () => "",
        };
        return fakeResponse as unknown as T;
      },
    },
  };
  return { client, calls };
}

describe("plugin-elizacloud TEXT_TO_SPEECH roundtrip", () => {
  afterEach(() => {
    setCloudTtsClientFactoryForTesting(null);
  });

  it("forwards voiceId and modelId to the cloud endpoint", async () => {
    const { client, calls } = makeFakeClient(new Uint8Array([1, 2, 3]));
    setCloudTtsClientFactoryForTesting(() => client);

    await handleTextToSpeech(makeRuntime(), {
      text: "hello world",
      voiceId: "EXAVITQu4vr4xnSDxMaL",
      modelId: "eleven_flash_v2_5",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      voiceId: "EXAVITQu4vr4xnSDxMaL",
      modelId: "eleven_flash_v2_5",
      text: "hello world",
    });
    // mp3 is the default format → Accept header is set.
    expect(calls[0].acceptHeader).toBe("audio/mpeg");
  });

  it("returns a Uint8Array / ReadableStream payload (mp3 bytes round-trip cleanly)", async () => {
    const expected = new Uint8Array([0xff, 0xfb, 0x00, 0x00, 0x10, 0x20]);
    const { client } = makeFakeClient(expected);
    setCloudTtsClientFactoryForTesting(() => client);

    const out = await handleTextToSpeech(makeRuntime(), {
      text: "hello",
      voiceId: "21m00Tcm4TlvDq8ikWAM",
      modelId: "eleven_flash_v2_5",
    });

    // `handleTextToSpeech` materializes the cloud audio stream into a single
    // Uint8Array (see ttsStreamToBytes in src/models/speech.ts) so callers
    // can hand the buffer to a downstream encoder / file write without
    // managing the stream lifecycle. Assert the bytes round-trip cleanly.
    expect(out).toBeInstanceOf(Uint8Array);
    expect(Array.from(out as Uint8Array)).toEqual(Array.from(expected));
  });

  it("returns an AudioStreamResult that yields chunks + resolves full bytes when audioStream is set", async () => {
    // Multi-chunk body so chunking is observable.
    const chunks = [new Uint8Array([1, 2]), new Uint8Array([3, 4, 5])];
    const calls: RecordedCall[] = [];
    const client: CloudTtsClient = {
      routes: {
        async postApiV1VoiceTts<T = unknown>(options: {
          headers?: Record<string, unknown>;
          json: { text: string; voiceId?: string; modelId?: string };
        }): Promise<T> {
          calls.push({
            voiceId: options.json.voiceId,
            modelId: options.json.modelId,
            text: options.json.text,
            acceptHeader: options.headers?.Accept as string | undefined,
          });
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              for (const c of chunks) controller.enqueue(c);
              controller.close();
            },
          });
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            body,
            text: async () => "",
          } as unknown as T;
        },
      },
    };
    setCloudTtsClientFactoryForTesting(() => client);

    const out = (await handleTextToSpeech(makeRuntime(), {
      text: "stream me",
      voiceId: "voice-S",
      audioStream: true,
    } as never)) as {
      audioStream: AsyncIterable<Uint8Array>;
      bytes: Promise<Uint8Array>;
      mimeType: string;
    };

    expect(out).not.toBeInstanceOf(Uint8Array);
    expect(out.mimeType).toBe("audio/mpeg");

    const received: number[] = [];
    for await (const chunk of out.audioStream) received.push(...chunk);
    // Audio surfaced incrementally (≥1 chunk; exact boundaries depend on the
    // web→node stream plumbing) and reassembles to the full clip.
    expect(received).toEqual([1, 2, 3, 4, 5]);
    // `bytes` resolves to the full concatenated clip after the stream drains.
    expect(Array.from(await out.bytes)).toEqual([1, 2, 3, 4, 5]);
  });

  it("throws CloudTtsUnavailableError when cloud is NOT connected", async () => {
    const { client, calls } = makeFakeClient(new Uint8Array([1]));
    setCloudTtsClientFactoryForTesting(() => client);

    await expect(
      handleTextToSpeech(makeRuntime({ connected: false }), {
        text: "hello",
        voiceId: "EXAVITQu4vr4xnSDxMaL",
        modelId: "eleven_flash_v2_5",
      })
    ).rejects.toBeInstanceOf(CloudTtsUnavailableError);
    // The gate runs before the HTTP fetch, so the SDK was never called.
    expect(calls).toHaveLength(0);
  });

  it("serves in capability-only mode: key + USE_TTS=true, ENABLED unset (#10961)", async () => {
    // applyCloudConfigToEnv writes exactly this shape when an external
    // provider owns the text brain but the operator cloud-routed TTS:
    // key kept, ELIZAOS_CLOUD_ENABLED deleted, ELIZAOS_CLOUD_USE_TTS=true.
    const expected = new Uint8Array([0xff, 0xfb, 0x42]);
    const { client, calls } = makeFakeClient(expected);
    setCloudTtsClientFactoryForTesting(() => client);

    const out = await handleTextToSpeech(makeRuntime({ enabled: null, useTts: "true" }), {
      text: "capability-only hello",
      voiceId: "EXAVITQu4vr4xnSDxMaL",
      modelId: "eleven_flash_v2_5",
    });

    // The gate let the request through to the (mocked) HTTP call…
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      voiceId: "EXAVITQu4vr4xnSDxMaL",
      modelId: "eleven_flash_v2_5",
      text: "capability-only hello",
    });
    // …and the audio round-trips.
    expect(out).toBeInstanceOf(Uint8Array);
    expect(Array.from(out as Uint8Array)).toEqual(Array.from(expected));
  });

  it("serves in capability-only mode when USE_TTS arrives via process.env", async () => {
    // applyCloudConfigToEnv writes the per-service flags to process.env, not
    // runtime settings — the gate must honor the env fallback of the
    // plugin's getSetting.
    process.env.ELIZAOS_CLOUD_USE_TTS = "true";
    const { client, calls } = makeFakeClient(new Uint8Array([7]));
    setCloudTtsClientFactoryForTesting(() => client);

    await handleTextToSpeech(makeRuntime({ enabled: null }), {
      text: "env-flag hello",
      voiceId: "voice-env",
      modelId: "eleven_flash_v2_5",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].text).toBe("env-flag hello");
  });

  it("throws CloudTtsUnavailableError when the key is set but neither ENABLED nor USE_TTS is", async () => {
    const { client, calls } = makeFakeClient(new Uint8Array([1]));
    setCloudTtsClientFactoryForTesting(() => client);

    await expect(
      handleTextToSpeech(makeRuntime({ enabled: null, useTts: null }), {
        text: "hello",
        voiceId: "EXAVITQu4vr4xnSDxMaL",
        modelId: "eleven_flash_v2_5",
      })
    ).rejects.toBeInstanceOf(CloudTtsUnavailableError);
    // Falls through to the next TTS handler without touching the SDK.
    expect(calls).toHaveLength(0);
  });

  it("throws CloudTtsUnavailableError when USE_TTS=true but no API key is present", async () => {
    const { client, calls } = makeFakeClient(new Uint8Array([1]));
    setCloudTtsClientFactoryForTesting(() => client);

    await expect(
      handleTextToSpeech(makeRuntime({ apiKey: null, enabled: null, useTts: "true" }), {
        text: "hello",
        voiceId: "EXAVITQu4vr4xnSDxMaL",
        modelId: "eleven_flash_v2_5",
      })
    ).rejects.toBeInstanceOf(CloudTtsUnavailableError);
    expect(calls).toHaveLength(0);
  });

  it("honors the voiceId override on each call (not hardcoded)", async () => {
    const { client, calls } = makeFakeClient(new Uint8Array([1, 2]));
    setCloudTtsClientFactoryForTesting(() => client);

    await handleTextToSpeech(makeRuntime(), {
      text: "first",
      voiceId: "voice-A",
      modelId: "eleven_flash_v2_5",
    });
    await handleTextToSpeech(makeRuntime(), {
      text: "second",
      voiceId: "voice-B",
      modelId: "eleven_flash_v2_5",
    });

    expect(calls).toHaveLength(2);
    expect(calls[0].voiceId).toBe("voice-A");
    expect(calls[1].voiceId).toBe("voice-B");
    // Each request carries its own voice — no stale-state lock-in.
    expect(calls[0].text).toBe("first");
    expect(calls[1].text).toBe("second");
  });
});
