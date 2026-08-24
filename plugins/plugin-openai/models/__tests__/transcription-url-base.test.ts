import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  detectAudioMimeType: vi.fn(() => "audio/mpeg"),
}));

vi.mock("../utils/audio", () => ({ detectAudioMimeType: mocks.detectAudioMimeType }));

import {
  fetchAudioFromUrl,
  installTranscriptionUrlFetcher,
  toAudioBlob,
} from "./transcription-url.ts";

describe("fetchAudioFromUrl", () => {
  it("rejects empty urls", async () => {
    await expect(fetchAudioFromUrl("")).rejects.toThrow(/valid audio URL/);
    await expect(fetchAudioFromUrl("   ")).rejects.toThrow(/valid audio URL/);
  });

  it("fails closed without an installed fetcher", async () => {
    await expect(fetchAudioFromUrl("https://x.com/a.mp3")).rejects.toThrow(
      /platform build entrypoint/
    );
  });

  it("delegates to the installed fetcher", async () => {
    installTranscriptionUrlFetcher(async () => new Blob(["data"]));
    const blob = await fetchAudioFromUrl("https://x.com/a.mp3");
    expect(blob.size).toBe(4);
  });
});

describe("toAudioBlob", () => {
  it("trusts audio content types", () => {
    const blob = toAudioBlob(new Uint8Array([1, 2]), "audio/wav");
    expect(blob.type).toBe("audio/wav");
  });

  it("sniffs when content type is missing", () => {
    const blob = toAudioBlob(new Uint8Array([1, 2]), null);
    expect(blob.type).toBe("audio/mpeg");
  });
});
