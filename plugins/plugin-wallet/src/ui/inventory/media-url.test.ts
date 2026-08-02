/**
 * Unit coverage for `normalizeInventoryImageUrl`: gateway rewriting for
 * ipfs/ipns/arweave URIs, rejection of `javascript:`/executable `data:` URIs,
 * and pass-through of safe raster `data:image` URLs. Pure function, no
 * network or DOM.
 */
import { describe, expect, it } from "vitest";
import { normalizeInventoryImageUrl } from "./media-url.ts";

describe("normalizeInventoryImageUrl", () => {
  it("normalizes decentralized asset URLs and rejects executable or document schemes", () => {
    expect(normalizeInventoryImageUrl("ipfs://bafy/token.png")).toBe(
      "https://ipfs.io/ipfs/bafy/token.png",
    );
    expect(normalizeInventoryImageUrl("ipns://example.eth/image.png")).toBe(
      "https://ipfs.io/ipns/example.eth/image.png",
    );
    expect(normalizeInventoryImageUrl("ar://abc123")).toBe(
      "https://arweave.net/abc123",
    );

    expect(normalizeInventoryImageUrl("javascript:alert(1)")).toBeNull();
    expect(
      normalizeInventoryImageUrl(
        "data:image/svg+xml,<svg onload=alert(1)></svg>",
      ),
    ).toBeNull();
    expect(
      normalizeInventoryImageUrl("data:text/html,<script>alert(1)</script>"),
    ).toBeNull();
  });

  it("keeps raster image data URLs for inline wallet assets", () => {
    expect(normalizeInventoryImageUrl("data:image/png;base64,aGVsbG8=")).toBe(
      "data:image/png;base64,aGVsbG8=",
    );
  });
});
