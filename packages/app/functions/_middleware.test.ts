import { describe, expect, it, vi } from "vitest";
import {
  applyEmbedSecurityHeaders,
  buildEmbedSecurityHeaders,
  isEmbedPath,
  onRequest,
} from "./_middleware";

describe("isEmbedPath", () => {
  it("matches the embed surface and its subpaths", () => {
    expect(isEmbedPath("/embed")).toBe(true);
    expect(isEmbedPath("/embed/telegram")).toBe(true);
    expect(isEmbedPath("/embed/discord/launch")).toBe(true);
  });

  it("does not match unrelated paths", () => {
    expect(isEmbedPath("/")).toBe(false);
    expect(isEmbedPath("/embedded")).toBe(false);
    expect(isEmbedPath("/api/embed")).toBe(false);
    expect(isEmbedPath("/dashboard")).toBe(false);
  });
});

describe("buildEmbedSecurityHeaders", () => {
  it("emits a frame-ancestors CSP allowing Telegram and Discord clients", () => {
    const csp = buildEmbedSecurityHeaders()["Content-Security-Policy"];
    expect(csp).toContain("frame-ancestors");
    expect(csp).toContain("https://telegram.org");
    expect(csp).toContain("https://*.telegram.org");
    expect(csp).toContain("https://discord.com");
    expect(csp).toContain("https://*.discord.com");
  });
});

describe("applyEmbedSecurityHeaders", () => {
  it("adds the CSP and drops a global X-Frame-Options", () => {
    const original = new Response("body", {
      status: 200,
      headers: { "X-Frame-Options": "DENY", "Content-Type": "text/html" },
    });
    const result = applyEmbedSecurityHeaders(original);
    expect(result.headers.get("Content-Security-Policy")).toContain(
      "frame-ancestors",
    );
    expect(result.headers.get("X-Frame-Options")).toBeNull();
    expect(result.headers.get("Content-Type")).toBe("text/html");
  });
});

describe("onRequest", () => {
  it("applies the framing policy to /embed via the SPA (never proxies)", async () => {
    const next = vi.fn(
      async () =>
        new Response("<html>embed</html>", {
          headers: { "X-Frame-Options": "DENY" },
        }),
    );
    const result = await onRequest({
      request: new Request("https://app.elizacloud.ai/embed/telegram"),
      env: {},
      next,
    });
    expect(next).toHaveBeenCalledOnce();
    expect(result.headers.get("Content-Security-Policy")).toContain(
      "frame-ancestors",
    );
    expect(result.headers.get("X-Frame-Options")).toBeNull();
  });

  it("leaves non-embed SPA paths untouched", async () => {
    const passthrough = new Response("spa");
    const next = vi.fn(async () => passthrough);
    const result = await onRequest({
      request: new Request("https://app.elizacloud.ai/dashboard"),
      env: {},
      next,
    });
    expect(result).toBe(passthrough);
    expect(result.headers.get("Content-Security-Policy")).toBeNull();
  });
});
