/**
 * The browser binding a parked authorization request is resumed against.
 * Pure functions with real WebCrypto — no database, no request. The route-level
 * proof (a leaked `rid` replayed from another browser is refused) lives in the
 * PGlite-backed provider suite in cloud-api.
 */

import { describe, expect, test } from "bun:test";

import {
  computeOidcRequestBindingHash,
  createOidcRequestBindingSecret,
  matchesOidcRequestBinding,
  oidcRequestBindingCookieName,
} from "./request-binding";

const REQUEST_ID = `eoq_${"a1b2c3d4".repeat(8)}`;
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Firefox/141.0";

describe("cookie naming", () => {
  test("each request id gets its own cookie, so parallel sign-ins do not evict each other", () => {
    const other = `eoq_${"f".repeat(48)}${"0123456789abcdef"}`;
    expect(oidcRequestBindingCookieName(REQUEST_ID)).not.toBe(oidcRequestBindingCookieName(other));
  });

  test("the name is stable and a valid cookie token", () => {
    const name = oidcRequestBindingCookieName(REQUEST_ID);
    expect(name).toBe(oidcRequestBindingCookieName(REQUEST_ID));
    expect(name).toMatch(/^[a-z-]+_[0-9a-f]{16}$/);
  });

  test("an id that is not the opaque hex form is refused rather than named", () => {
    for (const raw of ["", "eoq_", "not-an-id", "eoq_ZZZZ"]) {
      expect(() => oidcRequestBindingCookieName(raw)).toThrow(/opaque hex id/);
    }
  });
});

describe("binding match", () => {
  test("the originating browser matches", async () => {
    const secret = createOidcRequestBindingSecret();
    const hash = await computeOidcRequestBindingHash({ secret, userAgent: USER_AGENT });
    expect(await matchesOidcRequestBinding(hash, { secret, userAgent: USER_AGENT })).toBe(true);
  });

  test("a different browser holding the leaked id does not", async () => {
    const secret = createOidcRequestBindingSecret();
    const hash = await computeOidcRequestBindingHash({ secret, userAgent: USER_AGENT });

    // No cookie at all: the id was replayed from somewhere it leaked.
    expect(await matchesOidcRequestBinding(hash, null)).toBe(false);
    expect(await matchesOidcRequestBinding(hash, { secret: "", userAgent: USER_AGENT })).toBe(
      false,
    );
    // A guessed cookie value.
    expect(
      await matchesOidcRequestBinding(hash, {
        secret: createOidcRequestBindingSecret(),
        userAgent: USER_AGENT,
      }),
    ).toBe(false);
    // The right cookie from a different client.
    expect(await matchesOidcRequestBinding(hash, { secret, userAgent: "curl/8.7.1" })).toBe(false);
    expect(await matchesOidcRequestBinding(hash, { secret, userAgent: null })).toBe(false);
  });

  test("a browser that sent no User-Agent is bound by its secret alone", async () => {
    const secret = createOidcRequestBindingSecret();
    const hash = await computeOidcRequestBindingHash({ secret, userAgent: null });
    expect(await matchesOidcRequestBinding(hash, { secret, userAgent: null })).toBe(true);
    expect(await matchesOidcRequestBinding(hash, { secret: "x", userAgent: null })).toBe(false);
  });

  test("the secret and the user agent cannot be re-cut into another pair's digest", async () => {
    // Without a separator the hex secret could absorb a user-agent prefix.
    const a = await computeOidcRequestBindingHash({ secret: "abcd", userAgent: "ef" });
    const b = await computeOidcRequestBindingHash({ secret: "abcdef", userAgent: "" });
    expect(a).not.toBe(b);
  });

  test("the digest is stored, not the secret", async () => {
    const secret = createOidcRequestBindingSecret();
    const hash = await computeOidcRequestBindingHash({ secret, userAgent: USER_AGENT });
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(secret);
  });
});
