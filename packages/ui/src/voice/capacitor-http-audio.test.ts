import { describe, expect, it, vi } from "vitest";
import {
  isCapacitorHttpAudioUrl,
  requestCapacitorAudio,
} from "./capacitor-http-audio";

describe("requestCapacitorAudio", () => {
  it("only selects native HTTP for remote HTTPS routes", () => {
    expect(isCapacitorHttpAudioUrl("https://api.example/tts")).toBe(true);
    expect(
      isCapacitorHttpAudioUrl("eliza-local-agent://ipc/api/tts/cloud"),
    ).toBe(false);
    expect(isCapacitorHttpAudioUrl("http://127.0.0.1:3000/api/tts/cloud")).toBe(
      false,
    );
    expect(isCapacitorHttpAudioUrl("/api/tts/cloud")).toBe(false);
  });
  it("requests an arraybuffer and preserves arbitrary binary bytes from base64", async () => {
    const bytes = Uint8Array.from([
      0x52, 0x49, 0x46, 0x46, 0x80, 0x9f, 0xc3, 0xff, 0x00, 0x7f,
    ]);
    const request = vi.fn().mockResolvedValue({
      status: 200,
      data: Buffer.from(bytes).toString("base64"),
      headers: { "content-type": "audio/wav" },
    });

    const result = await requestCapacitorAudio(
      request,
      "https://agent.example/api/tts/cloud",
      { text: "hello" },
      { Authorization: "Bearer token" },
      12_345,
    );

    expect(request).toHaveBeenCalledWith({
      url: "https://agent.example/api/tts/cloud",
      method: "POST",
      headers: {
        Accept: "audio/wav, audio/mpeg, audio/*;q=0.9",
        "Content-Type": "application/json",
        Authorization: "Bearer token",
      },
      data: { text: "hello" },
      responseType: "arraybuffer",
      connectTimeout: 12_345,
      readTimeout: 12_345,
    });
    expect(result.status).toBe(200);
    expect([...result.bytes]).toEqual([...bytes]);
  });

  it("returns empty bytes for an empty native response", async () => {
    const request = vi.fn().mockResolvedValue({ status: 503 });

    const result = await requestCapacitorAudio(
      request,
      "/api/tts/cloud",
      { text: "hello" },
      {},
      100,
    );

    expect(result).toEqual({ status: 503, bytes: new Uint8Array() });
  });
});
