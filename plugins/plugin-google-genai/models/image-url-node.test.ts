import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  installImageUrlFetcher: vi.fn(),
  fetchRemoteMedia: vi.fn(),
}));

vi.mock("./image-url", () => ({
  installImageUrlFetcher: mocks.installImageUrlFetcher,
  IMAGE_DESCRIPTION_FETCH_TIMEOUT_MS: 15_000,
  IMAGE_DESCRIPTION_MAX_BYTES: 20 * 1024 * 1024,
  IMAGE_DESCRIPTION_MAX_REDIRECTS: 5,
}));
vi.mock(
  "@elizaos/core/node",
  () => ({
    fetchRemoteMedia: mocks.fetchRemoteMedia,
  }),
  { virtual: true },
);

import { installNodeImageUrlFetcher } from "./image-url.node.ts";

describe("installNodeImageUrlFetcher", () => {
  it("routes image urls through the ssrf-guarded fetcher", async () => {
    mocks.fetchRemoteMedia.mockResolvedValue({
      buffer: { toString: () => "aGVsbG8=" },
      contentType: "image/png",
    });
    installNodeImageUrlFetcher();
    expect(mocks.installImageUrlFetcher).toHaveBeenCalled();

    const fetcher = mocks.installImageUrlFetcher.mock.calls[0][0];
    const result = await fetcher("https://example.com/img.png");
    expect(result.base64).toBe("aGVsbG8=");
    expect(result.contentType).toBe("image/png");
  });
});
