// Exercises rate limit default key behavior with deterministic cloud-shared lib fixtures.

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { AppContext } from "../../types/cloud-worker-env";
import { getDefaultKey } from "./rate-limit-hono-cloudflare";

/**
 * #11087 (design flag): the default rate-limit key generator must NOT collapse
 * all unauthenticated traffic into one global bucket. Before the fix,
 * `getDefaultKey` returned the literal "public" for any request without an
 * api-key/user/anon-session — so a single flooder (600/min) 429-locked EVERY
 * anonymous client worldwide on every route using the default key generator.
 * The fix buckets anonymous traffic PER-IP; "public" survives only when the IP
 * is unresolvable.
 */

function ctx(headers: Record<string, string>, user?: { id: string }): AppContext {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    req: { header: (name: string) => lower[name.toLowerCase()] },
    get: (key: string) => (key === "user" ? user : undefined),
  } as unknown as AppContext;
}

describe("getDefaultKey — #11087 per-IP anonymous bucketing", () => {
  test("api key (x-api-key) → apikey: bucket", () => {
    const hash = createHash("sha256").update("abc").digest("hex");
    expect(getDefaultKey(ctx({ "x-api-key": "abc" }))).toBe(`apikey:${hash}`);
  });

  test("Bearer eliza_ token → apikey: bucket", () => {
    const hash = createHash("sha256").update("eliza_xyz").digest("hex");
    expect(getDefaultKey(ctx({ authorization: "Bearer eliza_xyz" }))).toBe(`apikey:${hash}`);
  });

  test("authenticated user → user: bucket", () => {
    expect(getDefaultKey(ctx({}, { id: "u1" }))).toBe("user:u1");
  });

  test("anon session header → anon: bucket", () => {
    const hash = createHash("sha256").update("s1").digest("hex");
    expect(getDefaultKey(ctx({ "x-anonymous-session": "s1" }))).toBe(`anon:${hash}`);
  });

  test("UNAUTHENTICATED with an IP → per-IP bucket, NOT global 'public' (the fix)", () => {
    expect(getDefaultKey(ctx({ "cf-connecting-ip": "203.0.113.7" }))).toBe("ip:203.0.113.7");
    expect(getDefaultKey(ctx({ "x-forwarded-for": "198.51.100.9, 10.0.0.1" }))).toBe(
      "ip:198.51.100.9",
    );
  });

  test("two different anonymous IPs get DISTINCT buckets — one flooder can't lock out the other", () => {
    const a = getDefaultKey(ctx({ "cf-connecting-ip": "203.0.113.1" }));
    const b = getDefaultKey(ctx({ "cf-connecting-ip": "203.0.113.2" }));
    expect(a).not.toBe(b);
    expect(a).not.toBe("public");
    expect(b).not.toBe("public");
  });

  test("only when the IP is unresolvable does it fall back to 'public' (bounded last resort)", () => {
    expect(getDefaultKey(ctx({}))).toBe("public");
  });
});
