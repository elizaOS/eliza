// @vitest-environment jsdom

/**
 * Unit coverage for reading the Steward session token, computing its
 * seconds-remaining from the JWT `exp`, the cookie-backed Steward refresh
 * (web/fetch branch — native/Electrobun HTTP has its own dedicated coverage),
 * and the cloud web/API host-normalization helpers. Tokens hand-built, no
 * live cloud.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ElizaClient } from "./client-base";
import {
  cloudTokenSecsRemaining,
  getCloudAuthToken,
  refreshCloudStewardSession,
  resolveDirectCloudAuthApiBase,
  resolveDirectCloudWebBase,
} from "./client-cloud";

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
  });

  afterEach(() => {
    localStorage.removeItem(STEWARD_TOKEN_KEY);
  });

  it("prefers the Steward session token over the client REST token", () => {
    localStorage.setItem(STEWARD_TOKEN_KEY, "steward-jwt");
    const client = new ElizaClient();
    client.setToken("client-token");
    expect(getCloudAuthToken(client)).toBe("steward-jwt");
    client.setToken(null);
  });

  it("resolves the device-code/Remote session token from the steward store", () => {
    // The device-code/pairing flow persists its session token through the same
    // steward-session store, so it resolves via the canonical Steward branch.
    localStorage.setItem(STEWARD_TOKEN_KEY, "device-code-token");
    expect(getCloudAuthToken()).toBe("device-code-token");
  });

  it("falls back to the client REST token last", () => {
    const client = new ElizaClient();
    client.setToken("client-token");
    expect(getCloudAuthToken(client)).toBe("client-token");
    client.setToken(null);
  });

  it("dispatches steward-token-sync when the client REST token changes", () => {
    const listener = vi.fn();
    window.addEventListener("steward-token-sync", listener);
    const client = new ElizaClient();

    client.setToken("client-token");
    client.setToken(null);

    window.removeEventListener("steward-token-sync", listener);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("returns null when no token is available anywhere", () => {
    expect(getCloudAuthToken()).toBeNull();
  });

  it("dispatches steward-token-sync on setToken so mounted gates refresh (#12046 Nit 2)", () => {
    const client = new ElizaClient();
    let syncs = 0;
    const handler = () => {
      syncs++;
    };
    window.addEventListener("steward-token-sync", handler);
    try {
      client.setToken("client-token");
      client.setToken(null);
      // Both the sign-in and the sign-out write must notify listeners — before
      // the fix setToken dispatched nothing and the gate went stale until a
      // remount.
      expect(syncs).toBe(2);
    } finally {
      window.removeEventListener("steward-token-sync", handler);
    }
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

describe("resolveDirectCloudWebBase / resolveDirectCloudAuthApiBase", () => {
  it("maps a known API host to the browser-navigable web host", () => {
    expect(resolveDirectCloudWebBase("https://api.elizacloud.ai")).toBe(
      "https://elizacloud.ai",
    );
  });

  it("maps a staging API host to the staging web host", () => {
    expect(resolveDirectCloudWebBase("https://api-staging.elizacloud.ai")).toBe(
      "https://staging.elizacloud.ai",
    );
  });

  it("passes through an unmapped host unchanged (trailing slash trimmed)", () => {
    expect(resolveDirectCloudWebBase("https://example.com/")).toBe(
      "https://example.com",
    );
  });

  it("falls back to the raw input for an unparseable base", () => {
    expect(resolveDirectCloudWebBase("not a url")).toBe("not a url");
  });

  it("maps a known site host to its API host", () => {
    expect(resolveDirectCloudAuthApiBase("https://www.elizacloud.ai")).toBe(
      "https://api.elizacloud.ai",
    );
  });

  it("passes through an unmapped host unchanged for the auth API base", () => {
    expect(resolveDirectCloudAuthApiBase("https://example.com")).toBe(
      "https://example.com",
    );
  });

  it("falls back to the raw input for an unparseable auth API base", () => {
    expect(resolveDirectCloudAuthApiBase("not a url")).toBe("not a url");
  });
});

describe("refreshCloudStewardSession (web/fetch branch)", () => {
  // Not native and not Electrobun in jsdom — shouldUseNativeStewardRefreshHttp
  // is false, so every case here exercises the plain `fetch` + credentials
  // branch, mirroring cloud-frontend's AuthTokenSync.
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs with credentials included and returns the rotated token payload", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ token: "rotated-jwt", expiresIn: 900 }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await refreshCloudStewardSession({
      endpoint: "https://api.elizacloud.ai/api/v1/auth/steward/refresh",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.elizacloud.ai/api/v1/auth/steward/refresh",
      expect.objectContaining({ method: "POST", credentials: "include" }),
    );
    expect(result).toEqual({ token: "rotated-jwt", expiresIn: 900 });
  });

  it("returns null when the refresh endpoint responds non-OK (no rotated cookie)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, json: async () => ({}) })),
    );
    const result = await refreshCloudStewardSession({
      endpoint: "https://api.elizacloud.ai/api/v1/auth/steward/refresh",
    });
    expect(result).toBeNull();
  });

  it("returns null when the response body is not parseable JSON (J3 fail-closed)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => {
          throw new SyntaxError("Unexpected token");
        },
      })),
    );
    const result = await refreshCloudStewardSession({
      endpoint: "https://api.elizacloud.ai/api/v1/auth/steward/refresh",
    });
    expect(result).toBeNull();
  });
});
