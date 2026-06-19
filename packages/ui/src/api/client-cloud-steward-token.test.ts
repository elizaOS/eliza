// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ElizaClient } from "./client-base";
import { cloudTokenSecsRemaining, getCloudAuthToken } from "./client-cloud";

const STEWARD_TOKEN_KEY = "steward_session_token";

function makeJwt(exp: number | null): string {
  const header = btoa(JSON.stringify({ alg: "none", typ: "JWT" }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const payload = btoa(JSON.stringify(exp === null ? {} : { exp }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `${header}.${payload}.sig`;
}

describe("getCloudAuthToken (Cloud = Steward everywhere)", () => {
  beforeEach(() => {
    localStorage.removeItem(STEWARD_TOKEN_KEY);
    delete (globalThis as Record<string, unknown>).__ELIZA_CLOUD_AUTH_TOKEN__;
  });

  afterEach(() => {
    localStorage.removeItem(STEWARD_TOKEN_KEY);
    delete (globalThis as Record<string, unknown>).__ELIZA_CLOUD_AUTH_TOKEN__;
  });

  it("prefers the Steward session token over the legacy global", () => {
    localStorage.setItem(STEWARD_TOKEN_KEY, "steward-jwt");
    (globalThis as Record<string, unknown>).__ELIZA_CLOUD_AUTH_TOKEN__ =
      "device-code-token";
    expect(getCloudAuthToken()).toBe("steward-jwt");
  });

  it("falls back to the legacy global when no Steward token (device-code/Remote)", () => {
    (globalThis as Record<string, unknown>).__ELIZA_CLOUD_AUTH_TOKEN__ =
      "device-code-token";
    expect(getCloudAuthToken()).toBe("device-code-token");
  });

  it("falls back to the client REST token last", () => {
    const client = new ElizaClient();
    client.setToken("client-token");
    expect(getCloudAuthToken(client)).toBe("client-token");
    client.setToken(null);
  });

  it("returns null when no token is available anywhere", () => {
    expect(getCloudAuthToken()).toBeNull();
  });
});

describe("cloudTokenSecsRemaining", () => {
  it("returns seconds remaining for a JWT with exp", () => {
    const exp = Math.floor(Date.now() / 1000) + 600;
    const secs = cloudTokenSecsRemaining(makeJwt(exp));
    expect(secs).not.toBeNull();
    expect(secs as number).toBeGreaterThan(500);
    expect(secs as number).toBeLessThanOrEqual(600);
  });

  it("returns null for a JWT without exp", () => {
    expect(cloudTokenSecsRemaining(makeJwt(null))).toBeNull();
  });

  it("returns null for a non-JWT opaque token", () => {
    expect(cloudTokenSecsRemaining("opaque-device-code-token")).toBeNull();
  });
});
