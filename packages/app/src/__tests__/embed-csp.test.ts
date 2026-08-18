/**
 * Unit tests for the Cloudflare Pages `functions/_middleware` embed CSP policy.
 * Asserts `embedFrameAncestors` emits per-platform `frame-ancestors`
 * (telegram/discord only), that the `/embed` `onRequest` handler swaps ONLY the
 * `frame-ancestors` value inside the inherited `_headers` CSP (preserving the
 * other edge directives, stripping X-Frame-Options), denies unknown/missing
 * platforms with `'none'`, and leaves non-embed SPA paths and their inherited
 * framing headers untouched. Requests run through the real handler with a
 * stubbed SPA `next()`; no network.
 */
import { describe, expect, it } from "vitest";
import {
  type EmbedPlatform,
  embedFrameAncestors,
  onRequest,
  swapCspFrameAncestors,
} from "../../functions/_middleware";

// Abbreviated stand-in for the global `public/_headers` policy that the
// `/embed` route must amend in place: several pinned directives plus the
// restrictive `frame-ancestors 'self'` that gets swapped per platform.
const EDGE_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; frame-ancestors 'self'; connect-src 'self' https://eliza.app https://*.eliza.app";

// The SPA fall-through response carries the global `public/_headers` framing
// policy that the `/embed` route must override.
const spaNext = (): Promise<Response> =>
  Promise.resolve(
    new Response("<!doctype html><html><body>spa</body></html>", {
      status: 200,
      statusText: "OK",
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": EDGE_CSP,
        "X-Frame-Options": "SAMEORIGIN",
      },
    }),
  );

const runRequest = (path: string): Promise<Response> =>
  onRequest({
    request: new Request(`https://cloud.eliza.app${path}`),
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

describe("swapCspFrameAncestors", () => {
  it("replaces only the frame-ancestors value, preserving other directives", () => {
    const swapped = swapCspFrameAncestors(
      EDGE_CSP,
      "frame-ancestors https://web.telegram.org https://*.telegram.org",
    );
    expect(swapped).toContain(
      "frame-ancestors https://web.telegram.org https://*.telegram.org",
    );
    expect(swapped).not.toContain("frame-ancestors 'self'");
    expect(swapped).toContain("default-src 'self'");
    expect(swapped).toContain("script-src 'self' 'unsafe-inline'");
    expect(swapped).toContain("img-src 'self' data: blob: https:");
    expect(swapped).toContain(
      "connect-src 'self' https://eliza.app https://*.eliza.app",
    );
    // One frame-ancestors directive in, exactly one out.
    expect(swapped.match(/frame-ancestors/g)).toHaveLength(1);
  });

  it("appends the directive when the policy has no frame-ancestors", () => {
    const swapped = swapCspFrameAncestors(
      "default-src 'self'",
      "frame-ancestors 'none'",
    );
    expect(swapped).toBe("default-src 'self'; frame-ancestors 'none'");
  });
});

describe("onRequest /embed CSP policy", () => {
  it("swaps in telegram framing for ?platform=telegram, keeping the edge policy", async () => {
    const response = await runRequest("/embed?platform=telegram");
    const csp = response.headers.get("Content-Security-Policy");
    expect(csp).toContain(
      "frame-ancestors https://web.telegram.org https://*.telegram.org",
    );
    expect(csp).not.toContain("frame-ancestors 'self'");
    expect(csp).not.toContain("discord");
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain(
      "connect-src 'self' https://eliza.app https://*.eliza.app",
    );
    expect(csp?.match(/frame-ancestors/g)).toHaveLength(1);
    expect(response.headers.get("X-Frame-Options")).toBeNull();
    expect(response.status).toBe(200);
  });

  it("swaps in discord framing for ?platform=discord, keeping the edge policy", async () => {
    const response = await runRequest("/embed?platform=discord");
    const csp = response.headers.get("Content-Security-Policy");
    expect(csp).toContain(
      "frame-ancestors https://discord.com https://*.discord.com",
    );
    expect(csp).not.toContain("frame-ancestors 'self'");
    expect(csp).not.toContain("telegram");
    expect(csp).toContain("default-src 'self'");
    expect(response.headers.get("X-Frame-Options")).toBeNull();
  });

  it("denies framing for an unknown platform, keeping the edge policy", async () => {
    const response = await runRequest("/embed?platform=evil.example.com");
    const csp = response.headers.get("Content-Security-Policy");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("default-src 'self'");
    expect(response.headers.get("X-Frame-Options")).toBeNull();
  });

  it("denies framing when no platform is supplied", async () => {
    const response = await runRequest("/embed");
    const csp = response.headers.get("Content-Security-Policy");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("default-src 'self'");
    expect(response.headers.get("X-Frame-Options")).toBeNull();
  });

  it("falls back to the bare directive when the response has no CSP", async () => {
    const response = await onRequest({
      request: new Request("https://cloud.eliza.app/embed?platform=telegram"),
      env: {},
      next: () =>
        Promise.resolve(
          new Response("<!doctype html>", {
            status: 200,
            headers: { "Content-Type": "text/html; charset=utf-8" },
          }),
        ),
    });
    expect(response.headers.get("Content-Security-Policy")).toBe(
      "frame-ancestors https://web.telegram.org https://*.telegram.org",
    );
  });

  it("leaves a normal non-/embed SPA path untouched", async () => {
    const response = await runRequest("/cloud");
    // No CSP amended by the middleware; the global _headers policy stands.
    expect(response.headers.get("Content-Security-Policy")).toBe(EDGE_CSP);
    // X-Frame-Options from the SPA fall-through is preserved.
    expect(response.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("spa");
  });

  it("does not treat a /embedded-* prefix collision as an embed path", async () => {
    const response = await runRequest("/embedded-viewer");
    expect(response.headers.get("Content-Security-Policy")).toBe(EDGE_CSP);
    expect(response.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
  });
});

// Compile-time guard: the platform union stays in lockstep with the helper.
const _platformGuard: Record<EmbedPlatform, true> = {
  telegram: true,
  discord: true,
};
void _platformGuard;
