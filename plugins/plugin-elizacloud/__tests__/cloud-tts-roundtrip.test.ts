/**
 * Roundtrip tests for the Eliza Cloud TEXT_TO_SPEECH handler.
 *
 * `handleTextToSpeech` lives at `src/models/speech.ts` and uses the cloud
 * SDK via `createElizaCloudClient(runtime).routes.postApiV1VoiceTts`. We
 * stub that with `setCloudTtsClientFactoryForTesting` so the tests never
 * hit the network and never need a configured SDK client.
 *
 * Coverage:
 *   - voiceId + modelId are forwarded to the upstream endpoint
 *   - the handler returns a Uint8Array / ReadableStream-compatible body
 *   - throws `CloudTtsUnavailableError` when cloud is not connected
 *   - each call respects its own voiceId (no hidden default lock-in)
 */
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it } from "vitest";

import {
  type CloudTtsClient,
  CloudTtsUnavailableError,
  handleTextToSpeech,
  setCloudTtsClientFactoryForTesting,
} from "../src/models/speech";

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

    // Node-side returns a `Readable`; collect bytes off it to assert shape.
    // `Readable` is async-iterable.
    const chunks: Uint8Array[] = [];
    for await (const chunk of out as AsyncIterable<unknown>) {
      if (chunk instanceof Uint8Array) {
        chunks.push(chunk);
      } else if (typeof chunk === "object" && chunk !== null) {
        // Buffer is Uint8Array under the hood; some node streams hand back
        // Buffer instances. Coerce defensively.
        chunks.push(new Uint8Array(chunk as ArrayBufferLike));
      }
    }
    const merged = new Uint8Array(chunks.reduce((acc, c) => acc + c.byteLength, 0));
    let off = 0;
    for (const c of chunks) {
      merged.set(c, off);
      off += c.byteLength;
    }
    expect(Array.from(merged)).toEqual(Array.from(expected));
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
