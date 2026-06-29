import { describe, expect, it } from "vitest";
import { embedFrameAncestors, isEmbedPath, onRequest } from "./_middleware.ts";

describe("app Pages middleware embed headers", () => {
  it("matches only /embed route paths", () => {
    expect(isEmbedPath("/embed")).toBe(true);
    expect(isEmbedPath("/embed/telegram")).toBe(true);
    expect(isEmbedPath("/embedded")).toBe(false);
    expect(isEmbedPath("/api/embed")).toBe(false);
  });

  it("maps approved platform frame ancestors and fails closed", () => {
    expect(embedFrameAncestors("telegram")).toBe(
      "frame-ancestors https://web.telegram.org https://*.telegram.org",
    );
    expect(embedFrameAncestors("discord")).toBe(
      "frame-ancestors https://discord.com https://*.discord.com",
    );
    expect(embedFrameAncestors(null)).toBe("frame-ancestors 'none'");
    expect(embedFrameAncestors("unknown")).toBe("frame-ancestors 'none'");
  });

  it("applies embed headers after the SPA fallback response", async () => {
    const response = await onRequest({
      request: new Request("https://app.elizacloud.ai/embed?platform=telegram"),
      env: {},
      next: async () =>
        new Response("<html></html>", {
          headers: { "X-Frame-Options": "SAMEORIGIN" },
        }),
    });

    expect(response.headers.get("Content-Security-Policy")).toBe(
      "frame-ancestors https://web.telegram.org https://*.telegram.org",
    );
    expect(response.headers.has("X-Frame-Options")).toBe(false);
  });
});
