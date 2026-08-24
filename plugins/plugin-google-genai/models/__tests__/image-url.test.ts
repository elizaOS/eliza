import { describe, expect, it } from "vitest";
import {
  fetchImageFromUrl,
  IMAGE_DESCRIPTION_MAX_BYTES,
  installImageUrlFetcher,
} from "./image-url.ts";

describe("fetchImageFromUrl", () => {
  it("fails closed without an installed fetcher", async () => {
    await expect(fetchImageFromUrl("https://x.com/a.png")).rejects.toThrow(
      /platform build entrypoint/,
    );
  });

  it("delegates to the installed fetcher", async () => {
    installImageUrlFetcher(async (url) => ({
      base64: "aGVsbG8=",
      contentType: "image/png",
    }));
    const result = await fetchImageFromUrl("https://x.com/a.png");
    expect(result.base64).toBe("aGVsbG8=");
    expect(result.contentType).toBe("image/png");
  });

  it("exposes the memory cap constant", () => {
    expect(IMAGE_DESCRIPTION_MAX_BYTES).toBe(20 * 1024 * 1024);
  });
});
