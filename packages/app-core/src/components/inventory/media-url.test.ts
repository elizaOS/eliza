import { describe, expect, it } from "vitest";
import { normalizeInventoryImageUrl } from "./media-url";

describe("normalizeInventoryImageUrl", () => {
  it("passes through http(s) urls", () => {
    expect(normalizeInventoryImageUrl("https://example.com/a.png")).toBe(
      "https://example.com/a.png",
    );
  });

  it("passes through data:image urls", () => {
    expect(normalizeInventoryImageUrl("data:image/png;base64,abc")).toBe(
      "data:image/png;base64,abc",
    );
  });

  it("rewrites ipfs:// urls to gateway", () => {
    expect(normalizeInventoryImageUrl("ipfs://bafy123/image.png")).toBe(
      "https://ipfs.io/ipfs/bafy123/image.png",
    );
  });

  it("rewrites ipns:// urls to gateway", () => {
    expect(normalizeInventoryImageUrl("ipns://k51abc/avatar.png")).toBe(
      "https://ipfs.io/ipns/k51abc/avatar.png",
    );
  });

  it("rewrites ar:// urls to arweave gateway", () => {
    expect(normalizeInventoryImageUrl("ar://tx123")).toBe(
      "https://arweave.net/tx123",
    );
  });

  it("returns null for unsupported schemes", () => {
    expect(normalizeInventoryImageUrl("ftp://example.com/a.png")).toBeNull();
  });
});
