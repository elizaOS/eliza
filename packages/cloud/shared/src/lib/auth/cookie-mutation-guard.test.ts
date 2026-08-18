/**
 * Unit tests for the cookie-mutation CSRF guard predicate: which requests take
 * the guard lane (ambient session cookie, no programmatic credential) and the
 * verdicts inside it. Pure — no Hono, no DB.
 */

import { describe, expect, test } from "bun:test";
import {
  checkCookieMutationGuard,
  hasAmbientSessionCookie,
  hasNonAmbientCredential,
} from "./cookie-mutation-guard";

function req(headers: Record<string, string>) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { header: (name: string) => lower[name.toLowerCase()] };
}

const FIRST_PARTY = { origin: "https://cloud.eliza.app" };
const COOKIE = { cookie: "steward-token=session-1" };

describe("hasNonAmbientCredential", () => {
  test("API key, service key, and Bearer tokens are non-ambient", () => {
    expect(hasNonAmbientCredential(req({ "x-api-key": "k" }))).toBe(true);
    expect(hasNonAmbientCredential(req({ "X-API-Key": "k" }))).toBe(true);
    expect(hasNonAmbientCredential(req({ "x-service-key": "k" }))).toBe(true);
    expect(hasNonAmbientCredential(req({ authorization: "Bearer eliza_k" }))).toBe(true);
    expect(hasNonAmbientCredential(req({ authorization: "Bearer eyJ.x.y" }))).toBe(true);
  });

  test("absent or empty credentials are not non-ambient", () => {
    expect(hasNonAmbientCredential(req({}))).toBe(false);
    expect(hasNonAmbientCredential(req({ authorization: "Bearer " }))).toBe(false);
    expect(hasNonAmbientCredential(req({ "x-api-key": "  " }))).toBe(false);
  });
});

describe("hasAmbientSessionCookie", () => {
  test("matches the environment-scoped steward cookie only", () => {
    expect(hasAmbientSessionCookie(req(COOKIE), undefined)).toBe(true);
    expect(hasAmbientSessionCookie(req(COOKIE), "production")).toBe(true);
    // A production-named cookie is not the staging environment's credential.
    expect(hasAmbientSessionCookie(req(COOKIE), "staging")).toBe(false);
    expect(hasAmbientSessionCookie(req({ cookie: "steward-token-staging=s" }), "staging")).toBe(
      true,
    );
    expect(hasAmbientSessionCookie(req({ cookie: "steward-refresh-token=s" }), undefined)).toBe(
      false,
    );
    expect(hasAmbientSessionCookie(req({ cookie: "unrelated=1" }), undefined)).toBe(false);
  });

  test("the Playwright test-session cookie counts as ambient", () => {
    expect(hasAmbientSessionCookie(req({ cookie: "eliza-test-session=t" }), undefined)).toBe(true);
  });
});

describe("checkCookieMutationGuard", () => {
  test("passes requests with nothing ambient to protect", () => {
    expect(checkCookieMutationGuard(req({}), undefined, true)).toEqual({ ok: true });
    // Programmatic credentials skip the lane even alongside a cookie.
    expect(checkCookieMutationGuard(req({ ...COOKIE, "x-api-key": "k" }), undefined, true)).toEqual(
      { ok: true },
    );
    expect(
      checkCookieMutationGuard(
        req({ ...COOKIE, authorization: "Bearer eliza_k" }),
        undefined,
        true,
      ),
    ).toEqual({ ok: true });
  });

  test("cookie-authed requests need a first-party origin and a non-simple marker", () => {
    // No Origin/Referer at all.
    expect(checkCookieMutationGuard(req(COOKIE), undefined, true)).toMatchObject({
      ok: false,
      code: "forbidden_origin",
    });
    // Hosted user content origin: same-site with the API but not first-party.
    expect(
      checkCookieMutationGuard(
        req({ ...COOKIE, origin: "https://evil.sites.eliza.app" }),
        undefined,
        true,
      ),
    ).toMatchObject({ ok: false, code: "forbidden_origin" });
    // First-party origin but a preflight-less "simple" request shape.
    expect(
      checkCookieMutationGuard(
        req({ ...COOKIE, ...FIRST_PARTY, "content-type": "text/plain" }),
        undefined,
        true,
      ),
    ).toMatchObject({ ok: false, code: "csrf_marker_required" });
    // First-party origin + JSON content type (non-simple) passes.
    expect(
      checkCookieMutationGuard(
        req({ ...COOKIE, ...FIRST_PARTY, "content-type": "application/json" }),
        undefined,
        true,
      ),
    ).toEqual({ ok: true });
    // First-party origin + explicit CSRF header marker passes.
    expect(
      checkCookieMutationGuard(
        req({ ...COOKIE, ...FIRST_PARTY, "x-eliza-csrf": "1" }),
        undefined,
        true,
      ),
    ).toEqual({ ok: true });
  });
});
