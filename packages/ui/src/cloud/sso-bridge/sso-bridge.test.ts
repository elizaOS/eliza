/** Pure-logic contract for the SSO bridge client module: hostname role table, returnTo sanitation, state-nonce lifecycle, loop guard, logged-out marker, URL builders, and the mint/exchange fetch wrappers — jsdom storage + hand-rolled fetch stubs, nothing mocked at module level. */
// @vitest-environment jsdom

import { STEWARD_TOKEN_KEY } from "@elizaos/shared/steward-session-client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildBridgeExchangeUrl,
  buildBridgeMintUrl,
  clearSsoBridgeAttempt,
  clearSsoLoggedOut,
  consumeSsoBridgeState,
  createSsoBridgeState,
  isSsoLoggedOut,
  isWellFormedSsoCode,
  isWellFormedSsoState,
  markSsoBridgeAttempt,
  markSsoLoggedOut,
  mintSsoCode,
  pairedAppOrigin,
  performSsoExchange,
  sanitizeBridgeReturnTo,
  shouldAttemptSsoBridge,
  shouldAutoBridgeToSso,
  signOutFromSsoBridgedHost,
  ssoBridgeRoleForHostname,
} from "./sso-bridge";

const STATE = "a".repeat(64);
const CODE = `esso_${"b".repeat(64)}`;

function base64url(value: unknown): string {
  return btoa(JSON.stringify(value))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function jwt(payload: Record<string, unknown>): string {
  return [
    base64url({ alg: "none", typ: "JWT" }),
    base64url(payload),
    "sig",
  ].join(".");
}

function liveToken(): string {
  return jwt({ userId: "u1", exp: Math.floor(Date.now() / 1000) + 3600 });
}

function clearCookies(): void {
  for (const part of document.cookie.split(";")) {
    const name = part.split("=")[0]?.trim();
    if (name)
      document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
  }
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  clearCookies();
});

afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  clearCookies();
});

describe("ssoBridgeRoleForHostname", () => {
  it("exact allowlist only — prod pair", () => {
    expect(ssoBridgeRoleForHostname("app.elizacloud.ai")).toBe("exchange");
    expect(ssoBridgeRoleForHostname("elizacloud.ai")).toBe("mint");
    expect(ssoBridgeRoleForHostname("www.elizacloud.ai")).toBe("mint");
  });

  it("staging pair maps to itself", () => {
    expect(ssoBridgeRoleForHostname("app-staging.elizacloud.ai")).toBe(
      "exchange",
    );
    expect(ssoBridgeRoleForHostname("staging.elizacloud.ai")).toBe("mint");
  });

  it("everything else is inert", () => {
    for (const host of [
      "localhost",
      "127.0.0.1",
      "dev.elizacloud.ai",
      "blob.elizacloud.ai",
      "abc12345.apps.elizacloud.ai",
      "some-sandbox-id.elizacloud.ai",
      "elizacloud.ai.evil.com",
      "app.elizacloud.ai.evil.com",
      "",
    ]) {
      expect(ssoBridgeRoleForHostname(host)).toBe("none");
    }
  });

  it("is case-insensitive", () => {
    expect(ssoBridgeRoleForHostname("App.ElizaCloud.AI")).toBe("exchange");
  });
});

describe("sanitizeBridgeReturnTo", () => {
  it("keeps ordinary relative paths", () => {
    expect(sanitizeBridgeReturnTo("/chat?x=1#y")).toBe("/chat?x=1#y");
    expect(sanitizeBridgeReturnTo("/")).toBe("/");
    expect(sanitizeBridgeReturnTo("/auth/bridged")).toBe("/auth/bridged");
  });

  it("rejects open-redirect shapes to /", () => {
    expect(sanitizeBridgeReturnTo("//evil.com")).toBe("/");
    expect(sanitizeBridgeReturnTo("/\\evil.com")).toBe("/");
    expect(sanitizeBridgeReturnTo("/a\\b")).toBe("/");
    expect(sanitizeBridgeReturnTo("https://evil.com")).toBe("/");
    expect(sanitizeBridgeReturnTo("javascript:alert(1)")).toBe("/");
    expect(sanitizeBridgeReturnTo("chat")).toBe("/");
    expect(sanitizeBridgeReturnTo("")).toBe("/");
    expect(sanitizeBridgeReturnTo(null)).toBe("/");
    expect(sanitizeBridgeReturnTo(`/${"a".repeat(2100)}`)).toBe("/");
  });

  it("rejects the bridge path itself (self-loop)", () => {
    expect(sanitizeBridgeReturnTo("/auth/bridge")).toBe("/");
    expect(sanitizeBridgeReturnTo("/auth/bridge?code=x")).toBe("/");
  });
});

describe("state nonce", () => {
  it("creates a well-formed nonce, stored for single-shot consumption", () => {
    const state = createSsoBridgeState();
    expect(state).not.toBeNull();
    expect(isWellFormedSsoState(state)).toBe(true);
    expect(consumeSsoBridgeState()).toBe(state);
    // Consumption is destructive: a second read yields nothing.
    expect(consumeSsoBridgeState()).toBeNull();
  });

  it("rejects malformed echoes", () => {
    expect(isWellFormedSsoState("")).toBe(false);
    expect(isWellFormedSsoState(null)).toBe(false);
    expect(isWellFormedSsoState("A".repeat(64))).toBe(false);
    expect(isWellFormedSsoState("a".repeat(63))).toBe(false);
  });
});

describe("loop guard", () => {
  it("blocks re-attempts inside the window, allows after it", () => {
    expect(shouldAttemptSsoBridge()).toBe(true);
    markSsoBridgeAttempt(1_000_000);
    expect(shouldAttemptSsoBridge(1_000_000 + 60_000)).toBe(false);
    expect(shouldAttemptSsoBridge(1_000_000 + 6 * 60 * 1000)).toBe(true);
    clearSsoBridgeAttempt();
    expect(shouldAttemptSsoBridge(1_000_000 + 60_000)).toBe(true);
  });
});

describe("logged-out marker", () => {
  it("persists until cleared", () => {
    expect(isSsoLoggedOut()).toBe(false);
    markSsoLoggedOut();
    expect(isSsoLoggedOut()).toBe(true);
    clearSsoLoggedOut();
    expect(isSsoLoggedOut()).toBe(false);
  });
});

describe("handshake URLs", () => {
  it("pairs prod app host with prod dashboard", () => {
    expect(buildBridgeMintUrl("app.elizacloud.ai", STATE, "/chat")).toBe(
      `https://elizacloud.ai/auth/bridge?state=${STATE}&returnTo=%2Fchat`,
    );
    expect(buildBridgeExchangeUrl("elizacloud.ai", CODE, STATE, "/chat")).toBe(
      `https://app.elizacloud.ai/auth/bridge?code=${CODE}&state=${STATE}&returnTo=%2Fchat`,
    );
    expect(pairedAppOrigin("www.elizacloud.ai")).toBe(
      "https://app.elizacloud.ai",
    );
  });

  it("pairs staging with staging — never across environments", () => {
    expect(
      buildBridgeMintUrl("app-staging.elizacloud.ai", STATE, "/"),
    ).toContain("https://staging.elizacloud.ai/auth/bridge");
    expect(
      buildBridgeExchangeUrl("staging.elizacloud.ai", CODE, STATE, "/"),
    ).toContain("https://app-staging.elizacloud.ai/auth/bridge");
    expect(pairedAppOrigin("staging.elizacloud.ai")).toBe(
      "https://app-staging.elizacloud.ai",
    );
  });

  it("wrong-side or unknown hostnames build nothing", () => {
    expect(buildBridgeMintUrl("elizacloud.ai", STATE, "/")).toBeNull();
    expect(buildBridgeMintUrl("localhost", STATE, "/")).toBeNull();
    expect(
      buildBridgeExchangeUrl("app.elizacloud.ai", CODE, STATE, "/"),
    ).toBeNull();
    expect(buildBridgeExchangeUrl("localhost", CODE, STATE, "/")).toBeNull();
    expect(pairedAppOrigin("app.elizacloud.ai")).toBeNull();
    expect(pairedAppOrigin("localhost")).toBeNull();
  });

  it("malformed state builds nothing", () => {
    expect(buildBridgeMintUrl("app.elizacloud.ai", "junk", "/")).toBeNull();
  });

  it("sanitizes returnTo in both builders", () => {
    expect(
      buildBridgeMintUrl("app.elizacloud.ai", STATE, "//evil.com"),
    ).toContain("returnTo=%2F");
    expect(
      buildBridgeExchangeUrl("elizacloud.ai", CODE, STATE, "https://evil.com"),
    ).toContain("returnTo=%2F");
  });
});

describe("shouldAutoBridgeToSso", () => {
  it("requires the exchange role", () => {
    document.cookie = "steward-authed=1";
    expect(shouldAutoBridgeToSso("elizacloud.ai")).toBe(false);
    expect(shouldAutoBridgeToSso("localhost")).toBe(false);
    expect(shouldAutoBridgeToSso("app.elizacloud.ai")).toBe(true);
  });

  it("requires the domain-wide authed marker cookie (post-logout browsers skip the bounce)", () => {
    expect(shouldAutoBridgeToSso("app.elizacloud.ai")).toBe(false);
  });

  it("honors the explicit logged-out marker", () => {
    document.cookie = "steward-authed=1";
    markSsoLoggedOut();
    expect(shouldAutoBridgeToSso("app.elizacloud.ai")).toBe(false);
    clearSsoLoggedOut();
    expect(shouldAutoBridgeToSso("app.elizacloud.ai")).toBe(true);
  });

  it("honors the loop guard", () => {
    document.cookie = "steward-authed=1";
    markSsoBridgeAttempt();
    expect(shouldAutoBridgeToSso("app.elizacloud.ai")).toBe(false);
  });
});

describe("code shape", () => {
  it("accepts only esso_-prefixed 64-hex codes", () => {
    expect(isWellFormedSsoCode(CODE)).toBe(true);
    expect(isWellFormedSsoCode("esso_short")).toBe(false);
    expect(isWellFormedSsoCode(`eac_${"b".repeat(64)}`)).toBe(false);
    expect(isWellFormedSsoCode(null)).toBe(false);
  });
});

type FetchCall = { url: string; init: RequestInit | undefined };

function fetchStub(responder: (url: string) => Response): {
  fn: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fn = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return Promise.resolve(responder(url));
  }) as typeof fetch;
  return { fn, calls };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("mintSsoCode", () => {
  it("refuses without a local session", async () => {
    const { fn, calls } = fetchStub(() => json(200, { ok: true, code: CODE }));
    const result = await mintSsoCode("elizacloud.ai", fn);
    expect(result).toEqual({ ok: false, error: "No local session" });
    expect(calls).toEqual([]);
  });

  it("POSTs the localStorage token as Bearer to the paired API worker", async () => {
    localStorage.setItem(STEWARD_TOKEN_KEY, liveToken());
    const { fn, calls } = fetchStub(() => json(200, { ok: true, code: CODE }));
    const result = await mintSsoCode("elizacloud.ai", fn);
    expect(result).toEqual({ ok: true, code: CODE });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      "https://api.elizacloud.ai/api/auth/sso-bridge/mint",
    );
    const headers = new Headers(calls[0].init?.headers);
    expect(headers.get("authorization")).toBe(
      `Bearer ${localStorage.getItem(STEWARD_TOKEN_KEY)}`,
    );
  });

  it("maps HTTP failures and malformed bodies to failures", async () => {
    localStorage.setItem(STEWARD_TOKEN_KEY, liveToken());
    const denied = await mintSsoCode(
      "elizacloud.ai",
      fetchStub(() => json(401, { error: "nope" })).fn,
    );
    expect(denied.ok).toBe(false);
    const junkCode = await mintSsoCode(
      "elizacloud.ai",
      fetchStub(() => json(200, { ok: true, code: "not-a-code" })).fn,
    );
    expect(junkCode.ok).toBe(false);
  });

  it("is inert off the deployed host map", async () => {
    localStorage.setItem(STEWARD_TOKEN_KEY, liveToken());
    const { fn, calls } = fetchStub(() => json(200, { ok: true, code: CODE }));
    const result = await mintSsoCode("localhost", fn);
    expect(result.ok).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe("performSsoExchange", () => {
  it("hydrates the local session and clears the bridge markers", async () => {
    markSsoBridgeAttempt();
    markSsoLoggedOut();
    const token = liveToken();
    const { fn, calls } = fetchStub((url) =>
      url.includes("/sso-bridge/exchange")
        ? json(200, { ok: true, token })
        : json(200, { ok: true }),
    );
    const events: string[] = [];
    const listener = () => events.push("steward-token-sync");
    window.addEventListener("steward-token-sync", listener);
    try {
      const result = await performSsoExchange(CODE, "app.elizacloud.ai", fn);
      expect(result).toEqual({ ok: true });
    } finally {
      window.removeEventListener("steward-token-sync", listener);
    }

    expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBe(token);
    expect(calls[0].url).toBe(
      "https://api.elizacloud.ai/api/auth/sso-bridge/exchange",
    );
    // The session-cookie sync rides the same call the login flow makes.
    expect(calls[1].url).toContain("/api/auth/steward-session");
    expect(events).toEqual(["steward-token-sync"]);
    expect(shouldAttemptSsoBridge()).toBe(true);
    expect(isSsoLoggedOut()).toBe(false);
  });

  it("rejects an expired or identity-less token without hydrating", async () => {
    const expired = jwt({
      userId: "u1",
      exp: Math.floor(Date.now() / 1000) - 10,
    });
    const noId = jwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
    for (const token of [expired, noId]) {
      const { fn } = fetchStub(() => json(200, { ok: true, token }));
      const result = await performSsoExchange(CODE, "app.elizacloud.ai", fn);
      expect(result.ok).toBe(false);
      expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBeNull();
    }
  });

  it("maps an exchange denial to a failure without hydrating", async () => {
    const { fn } = fetchStub(() => json(401, { error: "invalid_code" }));
    const result = await performSsoExchange(CODE, "app.elizacloud.ai", fn);
    expect(result.ok).toBe(false);
    expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBeNull();
  });
});

describe("signOutFromSsoBridgedHost", () => {
  it("marks logged-out synchronously, ends the server session, scrubs locally", async () => {
    localStorage.setItem(STEWARD_TOKEN_KEY, liveToken());
    // clearStaleStewardSession fires best-effort cookie DELETEs via the
    // global fetch; capture them so jsdom does not attempt real requests.
    const globalCalls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      globalCalls.push(`${init?.method ?? "GET"} ${String(input)}`);
      return Promise.resolve(json(200, { ok: true }));
    }) as typeof fetch;
    try {
      const { fn, calls } = fetchStub(() => json(200, { success: true }));
      await signOutFromSsoBridgedHost("app.elizacloud.ai", fn);
      expect(isSsoLoggedOut()).toBe(true);
      expect(calls[0].url).toBe("https://api.elizacloud.ai/api/auth/logout");
      expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBeNull();
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
