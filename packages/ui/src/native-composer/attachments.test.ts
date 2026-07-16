/**
 * Renderer-side attachment-normalization tests: each media-store source resolves
 * to a store-vocabulary URL, and every non-store / oversized / malformed / private
 * input is rejected with a typed reason rather than becoming a fabricated
 * attachment. Asserts the produced attachment carries no file-id (no second store).
 */

import { describe, expect, it } from "vitest";
import { normalizeComposerAttachment } from "./attachments";
import type { ComposerAttachmentSource } from "./contract";

const HASH = "a".repeat(64);

describe("normalizeComposerAttachment — happy paths", () => {
  it("inline bytes → a data: URL (persisted to the store on send)", () => {
    const r = normalizeComposerAttachment("att1", {
      source: "inline",
      mimeType: "image/png",
      bytesBase64: "AAAA",
      name: "pic.png",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.attachment.url).toBe("data:image/png;base64,AAAA");
      expect(r.attachment.kind).toBe("inline");
      expect(r.attachment.status).toBe("ready");
      expect(r.attachment.name).toBe("pic.png");
      // No second store: only media-store fields exist, never a file id.
      expect(Object.keys(r.attachment)).not.toContain("fileId");
    }
  });

  it("data-url source passes through with parsed mime", () => {
    const r = normalizeComposerAttachment("att1", {
      source: "data-url",
      dataUrl: "data:image/jpeg;base64,/9j/AAAA",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.attachment.mimeType).toBe("image/jpeg");
  });

  it("remote http(s) URL is kept for server-side SSRF rehost", () => {
    const r = normalizeComposerAttachment("att1", {
      source: "remote",
      url: "https://cdn.test/photo.png",
      mimeType: "image/png",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.attachment.kind).toBe("remote");
      expect(r.attachment.status).toBe("pending-rehost");
    }
  });

  it("already-stored /api/media/<hash> URL passes through as ready", () => {
    const r = normalizeComposerAttachment("att1", {
      source: "stored",
      url: `/api/media/${HASH}.png`,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.attachment.kind).toBe("stored");
      expect(r.attachment.status).toBe("ready");
    }
  });
});

describe("normalizeComposerAttachment — rejections", () => {
  it("rejects oversized inline bytes with reason oversized", () => {
    // 1 KiB cap, ~3 KiB of base64 → ~2.25 KiB decoded.
    const big = "A".repeat(3000);
    const r = normalizeComposerAttachment(
      "att1",
      { source: "inline", mimeType: "image/png", bytesBase64: big },
      { maxBytes: 1024 },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("oversized");
  });

  it("rejects a malformed mime", () => {
    const r = normalizeComposerAttachment("att1", {
      source: "inline",
      mimeType: "not-a-mime",
      bytesBase64: "AAAA",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("invalid-input");
  });

  it("rejects non-base64 inline bytes", () => {
    const r = normalizeComposerAttachment("att1", {
      source: "inline",
      mimeType: "image/png",
      bytesBase64: "%%%not base64%%%",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("invalid-input");
  });

  it("blocks obviously-private remote hosts (first-line SSRF guard)", () => {
    const hosts = [
      "http://localhost/x.png",
      "http://127.0.0.1/x.png",
      "http://10.0.0.5/x.png",
      "http://192.168.1.9/x.png",
      "http://169.254.169.254/latest/meta-data",
      "http://internal/x.png",
    ];
    for (const url of hosts) {
      const r = normalizeComposerAttachment("att1", {
        source: "remote",
        url,
      } as ComposerAttachmentSource);
      expect(r.ok, url).toBe(false);
      if (!r.ok) expect(r.reason).toBe("permission-denied");
    }
  });

  it("rejects a non-http(s) remote scheme", () => {
    const r = normalizeComposerAttachment("att1", {
      source: "remote",
      url: "file:///etc/passwd",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("unsupported");
  });

  it("rejects a stored URL that is not content-addressed", () => {
    const r = normalizeComposerAttachment("att1", {
      source: "stored",
      url: "/api/media/../secret.png",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("invalid-input");
  });
});
