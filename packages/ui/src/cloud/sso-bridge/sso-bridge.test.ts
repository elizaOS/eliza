/** Pure-logic contract for the SSO bridge client module: hostname role table, returnTo sanitation, state-nonce + PKCE-verifier lifecycle, loop guard, logged-out marker, URL builders, and the mint/exchange/burn fetch wrappers — jsdom storage + hand-rolled fetch stubs, nothing mocked at module level. */
// @vitest-environment jsdom

import { STEWARD_TOKEN_KEY } from "@elizaos/shared/steward-session-client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  peekPendingOnboardingSession,
  storePendingOnboardingSession,
  TELEGRAM_ACCOUNT_CLAIM_PURPOSE,
} from "../join/lib/onboarding-continuation";
import {
  buildBridgeExchangeUrl,
  buildBridgeMintUrl,
  burnSsoBridgeCode,
  clearSsoBridgeAttempt,
  clearSsoLoggedOut,
  consumeSsoBridgeState,
  consumeSsoBridgeVerifier,
  createSsoBridgeHandshake,
  isSsoLoggedOut,
  isWellFormedSsoChallenge,
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
const CHALLENGE = "c".repeat(64);
const VERIFIER = "d".repeat(64);
const CODE = `esso_${"b".repeat(64)}`;

async function sha256Hex(input: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

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
    expect(ssoBridgeRoleForHostname("cloud.eliza.app")).toBe("exchange");
    expect(ssoBridgeRoleForHostname("eliza.app")).toBe("mint");
    expect(ssoBridgeRoleForHostname("www.eliza.app")).toBe("mint");
  });

  it("staging pair maps to itself", () => {
    expect(ssoBridgeRoleForHostname("cloud-staging.eliza.app")).toBe(
      "exchange",
    );
    expect(ssoBridgeRoleForHostname("staging.eliza.app")).toBe("mint");
  });

  it("everything else is inert", () => {
    for (const host of [
      "localhost",
      "127.0.0.1",
      "elizacloud.ai",
      "app.elizacloud.ai",
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
    expect(ssoBridgeRoleForHostname("Cloud.Eliza.App")).toBe("exchange");
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

describe("handshake secrets (state nonce + PKCE verifier)", () => {
  it("creates a well-formed nonce and verifier, stored for single-shot consumption; the challenge is the verifier's sha256", async () => {
    const handshake = await createSsoBridgeHandshake();
    expect(handshake).not.toBeNull();
    expect(isWellFormedSsoState(handshake?.state)).toBe(true);
    expect(isWellFormedSsoChallenge(handshake?.challenge)).toBe(true);

    expect(consumeSsoBridgeState()).toBe(handshake?.state ?? "");
    // Consumption is destructive: a second read yields nothing.
    expect(consumeSsoBridgeState()).toBeNull();

    const verifier = consumeSsoBridgeVerifier();
    expect(isWellFormedSsoChallenge(verifier)).toBe(true);
    // The verifier itself NEVER equals the challenge that rode the URL…
    expect(verifier).not.toBe(handshake?.challenge);
    // …but commits to it.
    expect(await sha256Hex(verifier ?? "")).toBe(handshake?.challenge ?? "");
    expect(consumeSsoBridgeVerifier()).toBeNull();
  });

  it("rejects malformed echoes", () => {
    expect(isWellFormedSsoState("")).toBe(false);
    expect(isWellFormedSsoState(null)).toBe(false);
    expect(isWellFormedSsoState("A".repeat(64))).toBe(false);
    expect(isWellFormedSsoState("a".repeat(63))).toBe(false);
    expect(isWellFormedSsoChallenge("")).toBe(false);
    expect(isWellFormedSsoChallenge("g".repeat(64))).toBe(false);
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
  it("pairs prod app host with prod dashboard; mint carries state + challenge, exchange carries code + state — never the verifier", () => {
    expect(
      buildBridgeMintUrl("cloud.eliza.app", STATE, CHALLENGE, "/chat"),
    ).toBe(
      `https://eliza.app/auth/bridge?state=${STATE}&challenge=${CHALLENGE}&returnTo=%2Fchat`,
    );
    expect(buildBridgeExchangeUrl("eliza.app", CODE, STATE, "/chat")).toBe(
      `https://cloud.eliza.app/auth/bridge?code=${CODE}&state=${STATE}&returnTo=%2Fchat`,
    );
    expect(pairedAppOrigin("www.eliza.app")).toBe("https://cloud.eliza.app");
  });

  it("pairs staging with staging — never across environments", () => {
    expect(
      buildBridgeMintUrl("cloud-staging.eliza.app", STATE, CHALLENGE, "/"),
    ).toContain("https://staging.eliza.app/auth/bridge");
    expect(
      buildBridgeExchangeUrl("staging.eliza.app", CODE, STATE, "/"),
    ).toContain("https://cloud-staging.eliza.app/auth/bridge");
    expect(pairedAppOrigin("staging.eliza.app")).toBe(
      "https://cloud-staging.eliza.app",
    );
  });

  it("wrong-side or unknown hostnames build nothing", () => {
    expect(buildBridgeMintUrl("eliza.app", STATE, CHALLENGE, "/")).toBeNull();
    expect(buildBridgeMintUrl("localhost", STATE, CHALLENGE, "/")).toBeNull();
    expect(
      buildBridgeExchangeUrl("cloud.eliza.app", CODE, STATE, "/"),
    ).toBeNull();
    expect(buildBridgeExchangeUrl("localhost", CODE, STATE, "/")).toBeNull();
    expect(pairedAppOrigin("cloud.eliza.app")).toBeNull();
    expect(pairedAppOrigin("localhost")).toBeNull();
  });

  it("malformed state or challenge builds nothing", () => {
    expect(
      buildBridgeMintUrl("cloud.eliza.app", "junk", CHALLENGE, "/"),
    ).toBeNull();
    expect(
      buildBridgeMintUrl("cloud.eliza.app", STATE, "junk", "/"),
    ).toBeNull();
  });

  it("sanitizes returnTo in both builders", () => {
    expect(
      buildBridgeMintUrl("cloud.eliza.app", STATE, CHALLENGE, "//evil.com"),
    ).toContain("returnTo=%2F");
    expect(
      buildBridgeExchangeUrl("eliza.app", CODE, STATE, "https://evil.com"),
    ).toContain("returnTo=%2F");
  });
});

describe("shouldAutoBridgeToSso", () => {
  it("requires the exchange role", () => {
    expect(shouldAutoBridgeToSso("eliza.app")).toBe(false);
    expect(shouldAutoBridgeToSso("localhost")).toBe(false);
    expect(shouldAutoBridgeToSso("cloud.eliza.app")).toBe(true);
  });

  it("starts the auth-origin handoff without a cross-host cookie hint", () => {
    expect(document.cookie).not.toContain("steward-authed=1");
    expect(shouldAutoBridgeToSso("cloud.eliza.app")).toBe(true);
  });

  it("honors the explicit logged-out marker", () => {
    markSsoLoggedOut();
    expect(shouldAutoBridgeToSso("cloud.eliza.app")).toBe(false);
    clearSsoLoggedOut();
    expect(shouldAutoBridgeToSso("cloud.eliza.app")).toBe(true);
  });

  it("honors the loop guard", () => {
    markSsoBridgeAttempt();
    expect(shouldAutoBridgeToSso("cloud.eliza.app")).toBe(false);
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
    const result = await mintSsoCode("eliza.app", CHALLENGE, fn);
    expect(result).toEqual({ ok: false, error: "No local session" });
    expect(calls).toEqual([]);
  });

  it("POSTs the localStorage token as Bearer with the app origin's challenge", async () => {
    localStorage.setItem(STEWARD_TOKEN_KEY, liveToken());
    const { fn, calls } = fetchStub(() => json(200, { ok: true, code: CODE }));
    const result = await mintSsoCode("eliza.app", CHALLENGE, fn);
    expect(result).toEqual({ ok: true, code: CODE });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://eliza.app/api/auth/sso-bridge/mint");
    const headers = new Headers(calls[0].init?.headers);
    expect(headers.get("authorization")).toBe(
      `Bearer ${localStorage.getItem(STEWARD_TOKEN_KEY)}`,
    );
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      codeChallenge: CHALLENGE,
    });
  });

  it("refuses a malformed challenge without calling out", async () => {
    localStorage.setItem(STEWARD_TOKEN_KEY, liveToken());
    const { fn, calls } = fetchStub(() => json(200, { ok: true, code: CODE }));
    const result = await mintSsoCode("eliza.app", "junk", fn);
    expect(result.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it("maps HTTP failures and malformed bodies to failures", async () => {
    localStorage.setItem(STEWARD_TOKEN_KEY, liveToken());
    const denied = await mintSsoCode(
      "eliza.app",
      CHALLENGE,
      fetchStub(() => json(401, { error: "nope" })).fn,
    );
    expect(denied.ok).toBe(false);
    const junkCode = await mintSsoCode(
      "eliza.app",
      CHALLENGE,
      fetchStub(() => json(200, { ok: true, code: "not-a-code" })).fn,
    );
    expect(junkCode.ok).toBe(false);
  });

  it("is inert off the deployed host map", async () => {
    localStorage.setItem(STEWARD_TOKEN_KEY, liveToken());
    const { fn, calls } = fetchStub(() => json(200, { ok: true, code: CODE }));
    const result = await mintSsoCode("localhost", CHALLENGE, fn);
    expect(result.ok).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe("performSsoExchange", () => {
  it("POSTs code + verifier, hydrates the local session, clears the bridge markers", async () => {
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
      const result = await performSsoExchange(
        CODE,
        VERIFIER,
        "cloud.eliza.app",
        fn,
      );
      expect(result).toEqual({ ok: true });
    } finally {
      window.removeEventListener("steward-token-sync", listener);
    }

    expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBe(token);
    expect(calls[0].url).toBe(
      "https://cloud.eliza.app/api/auth/sso-bridge/exchange",
    );
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      code: CODE,
      codeVerifier: VERIFIER,
    });
    // The session-cookie sync rides the same call the login flow makes.
    expect(calls[1].url).toContain("/api/auth/steward-session");
    expect(events).toEqual(["steward-token-sync"]);
    expect(shouldAttemptSsoBridge()).toBe(true);
    expect(isSsoLoggedOut()).toBe(false);
  });

  it("establishes bridged auth without sending or consuming a Telegram claim", async () => {
    storePendingOnboardingSession(
      "opaque-telegram-claim-token",
      TELEGRAM_ACCOUNT_CLAIM_PURPOSE,
    );
    const token = liveToken();
    const { fn, calls } = fetchStub((url) =>
      url.includes("/sso-bridge/exchange")
        ? json(200, { ok: true, token })
        : json(200, { ok: true }),
    );

    await expect(
      performSsoExchange(CODE, VERIFIER, "cloud.eliza.app", fn),
    ).resolves.toEqual({ ok: true });

    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({
      token,
    });
    expect(peekPendingOnboardingSession(TELEGRAM_ACCOUNT_CLAIM_PURPOSE)).toBe(
      "opaque-telegram-claim-token",
    );
    expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBe(token);
  });

  it("keeps Telegram claim authority when best-effort cookie sync is rejected", async () => {
    storePendingOnboardingSession(
      "opaque-telegram-claim-token",
      TELEGRAM_ACCOUNT_CLAIM_PURPOSE,
    );
    const { fn } = fetchStub((url) =>
      url.includes("/sso-bridge/exchange")
        ? json(200, { ok: true, token: liveToken() })
        : json(409, { code: "telegram_claim_conflict" }),
    );

    const result = await performSsoExchange(
      CODE,
      VERIFIER,
      "cloud.eliza.app",
      fn,
    );

    expect(result).toEqual({ ok: true });
    expect(peekPendingOnboardingSession(TELEGRAM_ACCOUNT_CLAIM_PURPOSE)).toBe(
      "opaque-telegram-claim-token",
    );
    expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBeTruthy();
  });

  it("refuses a malformed verifier without calling out", async () => {
    const { fn, calls } = fetchStub(() =>
      json(200, { ok: true, token: liveToken() }),
    );
    const result = await performSsoExchange(
      CODE,
      "junk",
      "cloud.eliza.app",
      fn,
    );
    expect(result.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it("rejects an expired or identity-less token without hydrating", async () => {
    const expired = jwt({
      userId: "u1",
      exp: Math.floor(Date.now() / 1000) - 10,
    });
    const noId = jwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
    for (const token of [expired, noId]) {
      const { fn } = fetchStub(() => json(200, { ok: true, token }));
      const result = await performSsoExchange(
        CODE,
        VERIFIER,
        "cloud.eliza.app",
        fn,
      );
      expect(result.ok).toBe(false);
      expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBeNull();
    }
  });

  it("maps an exchange denial to a failure without hydrating", async () => {
    const { fn } = fetchStub(() => json(401, { error: "invalid_code" }));
    const result = await performSsoExchange(
      CODE,
      VERIFIER,
      "cloud.eliza.app",
      fn,
    );
    expect(result.ok).toBe(false);
    expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBeNull();
  });
});

describe("burnSsoBridgeCode", () => {
  it("fires a verifier-less exchange POST that destroys the code server-side", () => {
    const { fn, calls } = fetchStub(() => json(401, { error: "invalid_code" }));
    burnSsoBridgeCode(CODE, "cloud.eliza.app", fn);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      "https://cloud.eliza.app/api/auth/sso-bridge/exchange",
    );
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ code: CODE });
  });

  it("is inert for malformed codes and unmapped hosts", () => {
    const { fn, calls } = fetchStub(() => json(401, {}));
    burnSsoBridgeCode("not-a-code", "cloud.eliza.app", fn);
    burnSsoBridgeCode(CODE, "localhost", fn);
    expect(calls).toEqual([]);
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
      await signOutFromSsoBridgedHost("cloud.eliza.app", fn);
      expect(isSsoLoggedOut()).toBe(true);
      expect(calls[0].url).toBe("https://cloud.eliza.app/api/auth/logout");
      expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBeNull();
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
