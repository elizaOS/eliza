/**
 * Unit tests for MiniMax TTS handler
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleTextToSpeech } from "../tts";

// Mock runtime
function createMockRuntime(settings: Record<string, string> = {}) {
  return {
    getSetting: vi.fn((key: string) => settings[key] || ""),
    character: {},
  } as any;
}

// Mock fetch
const mockFetch = vi.fn();

describe("MiniMax TTS Handler", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("should call MiniMax TTS API with correct parameters", async () => {
    const runtime = createMockRuntime({
      MINIMAX_API_KEY: "test-api-key",
    });

    const hexAudio = Buffer.from("fake-audio-data").toString("hex");
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: { audio: hexAudio, status: 0 },
        base_resp: { status_code: 0, status_msg: "success" },
      }),
    });

    const result = await handleTextToSpeech(runtime, {
      text: "Hello world",
      voice: "English_Graceful_Lady",
    });

    expect(result).toBeInstanceOf(Buffer);
    expect(result.toString()).toBe("fake-audio-data");

    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.minimax.io/v1/t2a_v2");
    expect(options.headers.Authorization).toBe("Bearer test-api-key");

    const body = JSON.parse(options.body);
    expect(body.model).toBe("speech-2.8-hd");
    expect(body.text).toBe("Hello world");
    expect(body.voice_setting.voice_id).toBe("English_Graceful_Lady");
  });

  it("should handle string params", async () => {
    const runtime = createMockRuntime({
      MINIMAX_API_KEY: "test-api-key",
    });

    const hexAudio = Buffer.from("audio").toString("hex");
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: { audio: hexAudio, status: 0 },
        base_resp: { status_code: 0, status_msg: "success" },
      }),
    });

    const result = await handleTextToSpeech(runtime, "Hello world");

    expect(result).toBeInstanceOf(Buffer);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.text).toBe("Hello world");
    expect(body.voice_setting.voice_id).toBe("English_Graceful_Lady");
  });

  it("should throw when API key is missing", async () => {
    const runtime = createMockRuntime({});
    await expect(
      handleTextToSpeech(runtime, { text: "test" })
    ).rejects.toThrow("MINIMAX_API_KEY is not set");
  });

  it("should throw on API error", async () => {
    const runtime = createMockRuntime({
      MINIMAX_API_KEY: "test-api-key",
    });

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => "Internal Server Error",
    });

    await expect(
      handleTextToSpeech(runtime, { text: "test" })
    ).rejects.toThrow("MiniMax TTS API request failed (500)");
  });

  it("should throw on TTS error response", async () => {
    const runtime = createMockRuntime({
      MINIMAX_API_KEY: "test-api-key",
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: { audio: "", status: 1 },
        base_resp: { status_code: 1000, status_msg: "Invalid parameters" },
      }),
    });

    await expect(
      handleTextToSpeech(runtime, { text: "test" })
    ).rejects.toThrow("MiniMax TTS error: Invalid parameters");
  });

  it("should throw on empty text", async () => {
    const runtime = createMockRuntime({
      MINIMAX_API_KEY: "test-api-key",
    });

    await expect(
      handleTextToSpeech(runtime, { text: "" })
    ).rejects.toThrow("TTS text cannot be empty");
  });

  it("should truncate text exceeding 10000 characters", async () => {
    const runtime = createMockRuntime({
      MINIMAX_API_KEY: "test-api-key",
    });

    const longText = "a".repeat(15000);
    const hexAudio = Buffer.from("audio").toString("hex");
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: { audio: hexAudio, status: 0 },
        base_resp: { status_code: 0, status_msg: "success" },
      }),
    });

    await handleTextToSpeech(runtime, { text: longText });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.text.length).toBe(10000);
  });
});
