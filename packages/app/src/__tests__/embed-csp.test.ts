/**
 * Unit tests for the Cloudflare Pages `functions/_middleware` embed CSP policy.
 * Asserts `embedFrameAncestors` and the `/embed` `onRequest` handler emit
 * per-platform `frame-ancestors` (telegram/discord only, stripping
 * X-Frame-Options), deny unknown/missing platforms with `'none'`, and leave
 * non-embed SPA paths and their inherited framing headers untouched. Requests
 * run through the real handler with a stubbed SPA `next()`; no network.
 */
import { describe, expect, it } from "vitest";
import {
  type EmbedPlatform,
  embedFrameAncestors,
  onRequest,
} from "../../functions/_middleware";

// The SPA fall-through response carries the global `public/_headers` framing
// policy that the `/embed` route must override.
const spaNext = (): Promise<Response> =>
  Promise.resolve(
    new Response("<!doctype html><html><body>spa</body></html>", {
      status: 200,
      statusText: "OK",
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "X-Frame-Options": "SAMEORIGIN",
      },
    }),
  );

const runRequest = (path: string): Promise<Response> =>
  onRequest({
    request: new Request(`https://app.elizacloud.ai${path}`),
    env: {},
    next: spaNext,
  });

describe("embedFrameAncestors", () => {
  it("emits only telegram origins for the telegram platform", () => {
    const csp = embedFrameAncestors("telegram");
    expect(csp).toContain("frame-ancestors");
    expect(csp).toContain("https://web.telegram.org");
    expect(csp).toContain("https://*.telegram.org");
    expect(csp).not.toContain("discord");
    expect(csp).not.toContain("frame-ancestors *");
    expect(csp).not.toContain("'none'");
  });

  it("emits only discord origins for the discord platform", () => {
    const csp = embedFrameAncestors("discord");
    expect(csp).toContain("frame-ancestors");
    expect(csp).toContain("https://discord.com");
    expect(csp).toContain("https://*.discord.com");
    expect(csp).not.toContain("telegram");
    expect(csp).not.toContain("frame-ancestors *");
    expect(csp).not.toContain("'none'");
  });

  it("denies framing for unknown or missing platforms", () => {
    expect(embedFrameAncestors("slack")).toBe("frame-ancestors 'none'");
    expect(embedFrameAncestors("")).toBe("frame-ancestors 'none'");
    expect(embedFrameAncestors(null)).toBe("frame-ancestors 'none'");
  });
});

describe("onRequest /embed CSP policy", () => {
  it("allows only telegram framing for ?platform=telegram", async () => {
    const response = await runRequest("/embed?platform=telegram");
    const csp = response.headers.get("Content-Security-Policy");
    expect(csp).toBe(
      "frame-ancestors https://web.telegram.org https://*.telegram.org",
    );
    expect(csp).not.toContain("discord");
    expect(response.headers.get("X-Frame-Options")).toBeNull();
    expect(response.status).toBe(200);
  });

  it("allows only discord framing for ?platform=discord", async () => {
    const response = await runRequest("/embed?platform=discord");
    const csp = response.headers.get("Content-Security-Policy");
    expect(csp).toBe(
      "frame-ancestors https://discord.com https://*.discord.com",
    );
    expect(csp).not.toContain("telegram");
    expect(response.headers.get("X-Frame-Options")).toBeNull();
  });

  it("denies framing for an unknown platform", async () => {
    const response = await runRequest("/embed?platform=evil.example.com");
    expect(response.headers.get("Content-Security-Policy")).toBe(
      "frame-ancestors 'none'",
    );
    expect(response.headers.get("X-Frame-Options")).toBeNull();
  });

  it("denies framing when no platform is supplied", async () => {
    const response = await runRequest("/embed");
    expect(response.headers.get("Content-Security-Policy")).toBe(
      "frame-ancestors 'none'",
    );
    expect(response.headers.get("X-Frame-Options")).toBeNull();
  });

  it("leaves a normal non-/embed SPA path untouched", async () => {
    const response = await runRequest("/dashboard");
    // No CSP injected by the middleware; the global _headers policy stands.
    expect(response.headers.get("Content-Security-Policy")).toBeNull();
    // X-Frame-Options from the SPA fall-through is preserved.
    expect(response.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("spa");
  });

  it("does not treat a /embedded-* prefix collision as an embed path", async () => {
    const response = await runRequest("/embedded-viewer");
    expect(response.headers.get("Content-Security-Policy")).toBeNull();
    expect(response.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
  });
});

// Compile-time guard: the platform union stays in lockstep with the helper.
const _platformGuard: Record<EmbedPlatform, true> = {
  telegram: true,
  discord: true,
};
void _platformGuard;
