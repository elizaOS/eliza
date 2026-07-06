import type { IAgentRuntime } from "@elizaos/core";
import { fetchWithSsrfGuard, ModelType } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { elizaOSCloudPlugin } from "../src/index";
import { CloudSttUnavailableError, handleTranscription } from "../src/models/transcription";

// Audio-URL fetches go through core's SSRF guard (the repo convention for
// every server-side attachment fetch). Stub only that boundary — the cloud
// STT POST itself still goes through the real client against a mocked
// globalThis.fetch, matching the sibling contract tests.
vi.mock("@elizaos/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@elizaos/core")>();
  return {
    ...actual,
    fetchWithSsrfGuard: vi.fn(),
  };
});

function makeRuntime(overrides: Record<string, string | undefined> = {}): IAgentRuntime {
  const settings: Record<string, string | undefined> = {
    ELIZAOS_CLOUD_API_KEY: "test-key",
    ELIZAOS_CLOUD_BASE_URL: "https://cloud.test.local/api/v1",
    ELIZAOS_CLOUD_ENABLED: "true",
    ...overrides,
  };
  return {
    getSetting: (key: string) => settings[key],
  } as unknown as IAgentRuntime;
}

function mockSttResponse(body: Record<string, unknown>) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  );
}

// getSetting falls back to process.env in the plugin's config helpers;
// isolate the suite from host-written cloud flags.
const ISOLATED_ENV_KEYS = [
  "ELIZAOS_CLOUD_API_KEY",
  "ELIZAOS_CLOUD_ENABLED",
  "ELIZAOS_CLOUD_USE_STT",
] as const;
let savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  savedEnv = {};
  for (const key of ISOLATED_ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});
afterEach(() => {
  for (const key of ISOLATED_ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  vi.restoreAllMocks();
  vi.mocked(fetchWithSsrfGuard).mockReset();
});

describe("plugin-elizacloud TRANSCRIPTION registration", () => {
  it("registers TRANSCRIPTION in the always-on capability models map", () => {
    const models = elizaOSCloudPlugin.models;
    expect(models).toBeDefined();
    expect(models?.[ModelType.TRANSCRIPTION]).toBe(handleTranscription);
  });
});

describe("plugin-elizacloud TRANSCRIPTION availability gate", () => {
  it("throws CloudSttUnavailableError without an API key", async () => {
    await expect(
      handleTranscription(makeRuntime({ ELIZAOS_CLOUD_API_KEY: undefined }), Buffer.from("RIFF"))
    ).rejects.toBeInstanceOf(CloudSttUnavailableError);
  });

  it("throws CloudSttUnavailableError when neither ENABLED nor USE_STT is set", async () => {
    await expect(
      handleTranscription(makeRuntime({ ELIZAOS_CLOUD_ENABLED: undefined }), Buffer.from("RIFF"))
    ).rejects.toBeInstanceOf(CloudSttUnavailableError);
  });

  it("serves in capability-only mode via ELIZAOS_CLOUD_USE_STT=true", async () => {
    mockSttResponse({ transcript: "capability-only stt" });
    const text = await handleTranscription(
      makeRuntime({ ELIZAOS_CLOUD_ENABLED: undefined, ELIZAOS_CLOUD_USE_STT: "true" }),
      Buffer.from("RIFF....WAVEfmt ")
    );
    expect(text).toBe("capability-only stt");
  });
});

describe("plugin-elizacloud TRANSCRIPTION param shapes", () => {
  it("accepts a raw Buffer", async () => {
    const fetchSpy = mockSttResponse({ transcript: "hello from cloud" });
    const text = await handleTranscription(makeRuntime(), Buffer.from("RIFF....WAVEfmt "));
    expect(text).toBe("hello from cloud");
    const body = (fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined)?.body as FormData;
    expect(body.get("audio")).toBeInstanceOf(Blob);
  });

  it("accepts { audio: Buffer, language } and forwards languageCode only", async () => {
    const fetchSpy = mockSttResponse({ text: "param object" });
    const text = await handleTranscription(makeRuntime(), {
      audio: Buffer.from("RIFF....WAVEfmt "),
      language: "de",
      mimeType: "audio/wav",
      model: "custom-stt",
    });
    expect(text).toBe("param object");
    const body = (fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined)?.body as FormData;
    expect(body.get("languageCode")).toBe("de");
    expect(body.get("model")).toBeNull();
  });

  it("fetches a string audio URL through the SSRF guard", async () => {
    mockSttResponse({ transcript: "from url" });
    vi.mocked(fetchWithSsrfGuard).mockResolvedValue({
      response: new Response(Buffer.from("RIFF....WAVEfmt "), {
        status: 200,
        headers: { "content-type": "audio/wav" },
      }),
      finalUrl: "https://audio.example.com/rec.wav",
      release: async () => {},
    });

    const text = await handleTranscription(makeRuntime(), "https://audio.example.com/rec.wav");
    expect(text).toBe("from url");
    expect(vi.mocked(fetchWithSsrfGuard)).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://audio.example.com/rec.wav" })
    );
  });

  it("fetches core TranscriptionParams { audioUrl } through the SSRF guard", async () => {
    mockSttResponse({ text: "from audioUrl" });
    vi.mocked(fetchWithSsrfGuard).mockResolvedValue({
      response: new Response(Buffer.from("OggS....."), {
        status: 200,
        headers: { "content-type": "audio/ogg" },
      }),
      finalUrl: "https://audio.example.com/meeting.ogg",
      release: async () => {},
    });

    const text = await handleTranscription(makeRuntime(), {
      audioUrl: "https://audio.example.com/meeting.ogg",
    });
    expect(text).toBe("from audioUrl");
    expect(vi.mocked(fetchWithSsrfGuard)).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://audio.example.com/meeting.ogg" })
    );
  });

  it("surfaces a failed audioUrl fetch instead of posting empty audio", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    vi.mocked(fetchWithSsrfGuard).mockResolvedValue({
      response: new Response(null, { status: 404, statusText: "Not Found" }),
      finalUrl: "https://audio.example.com/missing.wav",
      release: async () => {},
    });
    await expect(
      handleTranscription(makeRuntime(), { audioUrl: "https://audio.example.com/missing.wav" })
    ).rejects.toThrow(/Failed to fetch TRANSCRIPTION audioUrl: 404/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects unsupported input shapes with a descriptive error", async () => {
    await expect(
      handleTranscription(makeRuntime(), { pcm: new Float32Array(4) } as never)
    ).rejects.toThrow(/TRANSCRIPTION expects/);
  });
});

describe("plugin-elizacloud TRANSCRIPTION contract", () => {
  it("accepts the cloud STT transcript response shape", async () => {
    mockSttResponse({ transcript: "hello from cloud", duration_ms: 42 });
    const text = await handleTranscription(makeRuntime(), Buffer.from("RIFF....WAVEfmt "));
    expect(text).toBe("hello from cloud");
  });

  it("keeps backward compatibility with text responses", async () => {
    mockSttResponse({ text: "legacy text" });
    const text = await handleTranscription(makeRuntime(), Buffer.from("RIFF....WAVEfmt "));
    expect(text).toBe("legacy text");
  });
});
