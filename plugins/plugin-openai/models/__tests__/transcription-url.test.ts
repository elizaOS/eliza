import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  installTranscriptionUrlFetcher: vi.fn(),
  fetchRemoteMedia: vi.fn(),
}));

vi.mock("./transcription-url", () => ({
  installTranscriptionUrlFetcher: mocks.installTranscriptionUrlFetcher,
  TRANSCRIPTION_AUDIO_FETCH_TIMEOUT_MS: 15_000,
  TRANSCRIPTION_AUDIO_MAX_BYTES: 10 * 1024 * 1024,
  TRANSCRIPTION_AUDIO_MAX_REDIRECTS: 5,
  toAudioBlob: (buffer: unknown, contentType?: string | null) => ({
    buffer,
    contentType: contentType ?? null,
  }),
}));

import { installNodeTranscriptionUrlFetcher } from "./transcription-url.node.ts";

describe("installNodeTranscriptionUrlFetcher", () => {
  it("routes audio urls through the ssrf-guarded fetcher", async () => {
    mocks.fetchRemoteMedia.mockResolvedValue({
      buffer: new Uint8Array([1, 2, 3]),
      contentType: "audio/mpeg",
    });
    // 懒加载 @elizaos/core/node
    mocks.fetchRemoteMedia.mockImplementation(() =>
      Promise.resolve({
        buffer: new Uint8Array([1, 2, 3]),
        contentType: "audio/mpeg",
      })
    );
    vi.mock(
      "@elizaos/core/node",
      () => ({
        fetchRemoteMedia: mocks.fetchRemoteMedia,
      }),
      { virtual: true }
    );

    installNodeTranscriptionUrlFetcher();
    expect(mocks.installTranscriptionUrlFetcher).toHaveBeenCalled();

    const fetcher = mocks.installTranscriptionUrlFetcher.mock.calls[0][0];
    const blob = await fetcher("https://example.com/audio.mp3");
    expect(blob.contentType).toBe("audio/mpeg");
  });
});
