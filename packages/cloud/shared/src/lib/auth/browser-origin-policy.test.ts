/**
 * Deterministic coverage for the exact-host Steward mutation policy, including
 * canonical, transition, same-origin, development, and hostile suffix cases.
 */

import { describe, expect, it } from "bun:test";
import {
  browserOriginHost,
  checkElizaMutatingRequestOrigin,
  hasElizaNonSimpleRequestMarker,
  isPermittedElizaBrowserOrigin,
} from "./browser-origin-policy";

function headers(values: Record<string, string | undefined>) {
  return {
    header(name: string): string | undefined {
      return values[name];
    },
  };
}

describe("Steward browser origin policy", () => {
  it("accepts exact canonical and redirect-era first-party UI hosts", () => {
    for (const host of [
      "eliza.app",
      "www.eliza.app",
      "cloud.eliza.app",
      "staging.eliza.app",
      "cloud-staging.eliza.app",
      "elizacloud.ai",
      "app.elizacloud.ai",
    ]) {
      expect(isPermittedElizaBrowserOrigin(host, "api.eliza.app", true)).toBe(true);
    }
  });

  it("rejects unlisted subdomains and suffix-confusion hosts", () => {
    for (const host of [
      "evil.eliza.app",
      "agent.cloud.eliza.app",
      "blob.elizacloud.ai",
      "apps.elizacloud.ai",
      "eliza.app.evil.test",
    ]) {
      expect(isPermittedElizaBrowserOrigin(host, "api.eliza.app", true)).toBe(false);
    }
  });

  it("accepts an exact same-origin host without opening sibling hosts", () => {
    expect(
      isPermittedElizaBrowserOrigin("agent.cloud.eliza.app", "agent.cloud.eliza.app", true),
    ).toBe(true);
    expect(
      isPermittedElizaBrowserOrigin("evil.cloud.eliza.app", "agent.cloud.eliza.app", true),
    ).toBe(false);
  });

  it("allows localhost only outside production", () => {
    expect(isPermittedElizaBrowserOrigin("localhost", null, false)).toBe(true);
    expect(isPermittedElizaBrowserOrigin("localhost", null, true)).toBe(false);
  });

  it("requires a valid Origin or Referer and reports invalid input", () => {
    expect(browserOriginHost("not a url")).toBeNull();
    expect(checkElizaMutatingRequestOrigin(headers({}), true)).toEqual({
      ok: false,
      reason: "missing_origin_and_referer",
    });
    expect(
      checkElizaMutatingRequestOrigin(
        headers({
          host: "api.eliza.app",
          referer: "https://cloud.eliza.app/settings",
        }),
        true,
      ),
    ).toEqual({ ok: true });
  });

  it("accepts the custom CSRF header or a JSON content type as the non-simple marker", () => {
    expect(hasElizaNonSimpleRequestMarker(headers({ "x-eliza-csrf": "1" }))).toBe(true);
    expect(
      hasElizaNonSimpleRequestMarker(
        headers({ "content-type": "application/json; charset=utf-8" }),
      ),
    ).toBe(true);
    expect(hasElizaNonSimpleRequestMarker(headers({ "content-type": "Application/JSON" }))).toBe(
      true,
    );
  });

  it("rejects simple-request shapes that a cross-origin form/fetch can produce", () => {
    // No headers at all (curl-style or header-less simple request).
    expect(hasElizaNonSimpleRequestMarker(headers({}))).toBe(false);
    // CORS-safelisted content types never force a preflight.
    expect(hasElizaNonSimpleRequestMarker(headers({ "content-type": "text/plain" }))).toBe(false);
    expect(
      hasElizaNonSimpleRequestMarker(
        headers({ "content-type": "application/x-www-form-urlencoded" }),
      ),
    ).toBe(false);
    expect(
      hasElizaNonSimpleRequestMarker(
        headers({ "content-type": "multipart/form-data; boundary=x" }),
      ),
    ).toBe(false);
    // An empty marker value is not a marker.
    expect(hasElizaNonSimpleRequestMarker(headers({ "x-eliza-csrf": "  " }))).toBe(false);
  });
});
