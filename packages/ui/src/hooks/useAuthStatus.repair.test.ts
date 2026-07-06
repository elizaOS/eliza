// @vitest-environment jsdom
/**
 * Exercises the useAuthStatus 401 → credential-repair → retry path (#15132).
 * Only the network boundary (`globalThis.fetch`) is stubbed: the real authMe,
 * fetchWithCsrf, repairDedicatedAgentCredential, pairing poll loop, and the
 * singleton ElizaClient run. A dedicated cloud agent answering 401 with a
 * still-valid Steward session must re-pair and land authenticated; the same
 * 401 with no cloud session must fall through to `unauthenticated`
 * (LoginView) exactly as before.
 */
import { STEWARD_TOKEN_KEY } from "@elizaos/shared/steward-session-client";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { client } from "../api/client";
import { __resetRepairAgentCredentialStateForTests } from "../cloud/repair-agent-credential";
import { getBootConfig, setBootConfig } from "../config/boot-config";
import { __setAuthStatusForTests, useAuthStatus } from "./useAuthStatus";

const AGENT_BASE = "https://agent1.elizacloud.ai";
const PAIRING_TOKEN_URL =
  "https://api.elizacloud.ai/api/v1/eliza/agents/agent1/pairing-token";
const PAIR_REDIRECT_URL = `${AGENT_BASE}/pair?token=one-time-t`;

const ORIGINAL_FETCH = globalThis.fetch;

function b64url(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function makeStewardJwt(expSecsFromNow: number): string {
  return `${b64url({ alg: "none" })}.${b64url({
    exp: Math.floor(Date.now() / 1000) + expSecsFromNow,
  })}.sig`;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const AUTH_ME_OK_BODY = {
  identity: { id: "owner-1", displayName: "Owner", kind: "owner" },
  session: { id: "sess-1", kind: "browser", expiresAt: null },
  access: { mode: "session", passwordConfigured: true, ownerConfigured: true },
};

let bootConfigSnapshot: ReturnType<typeof getBootConfig>;
let restoreAuthSnapshot: () => void;

beforeEach(() => {
  bootConfigSnapshot = { ...getBootConfig() };
  localStorage.clear();
  sessionStorage.clear();
  __resetRepairAgentCredentialStateForTests();
  restoreAuthSnapshot = __setAuthStatusForTests({ phase: "loading" });
  setBootConfig({ ...getBootConfig(), apiBase: AGENT_BASE });
  client.setBaseUrl(AGENT_BASE, { persist: false });
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  restoreAuthSnapshot();
  client.setBaseUrl(null, { persist: false });
  client.setToken(null);
  setBootConfig(bootConfigSnapshot);
  localStorage.clear();
  sessionStorage.clear();
  __resetRepairAgentCredentialStateForTests();
});

describe("useAuthStatus dedicated-agent credential repair", () => {
  it("repairs a rotated container credential on 401 and lands authenticated", async () => {
    client.setToken("stale_container_token");
    localStorage.setItem(STEWARD_TOKEN_KEY, makeStewardJwt(3600));

    let authMeCalls = 0;
    let mintCalls = 0;
    globalThis.fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/api/auth/me")) {
          authMeCalls += 1;
          if (authMeCalls === 1) {
            // The stale ELIZA_API_TOKEN 401s at the container after upgrade.
            return jsonResponse(401, { reason: "remote_auth_required" });
          }
          // The retry must carry the repaired credential.
          const bearer = new Headers(init?.headers).get("Authorization");
          expect(bearer).toBe("Bearer agent_fresh_key");
          return jsonResponse(200, AUTH_ME_OK_BODY);
        }
        if (url.startsWith(PAIRING_TOKEN_URL)) {
          mintCalls += 1;
          return jsonResponse(200, {
            success: true,
            data: { token: "one-time-t", redirectUrl: PAIR_REDIRECT_URL },
          });
        }
        if (url.startsWith(`${AGENT_BASE}/pair`)) {
          return jsonResponse(200, { apiKey: "agent_fresh_key" });
        }
        throw new Error(`unexpected fetch in test: ${url}`);
      },
    ) as unknown as typeof globalThis.fetch;

    const { result, unmount } = renderHook(() =>
      useAuthStatus({ pollIntervalMs: 0 }),
    );

    await waitFor(
      () => expect(result.current.state.phase).toBe("authenticated"),
      { timeout: 10_000 },
    );
    expect(mintCalls).toBe(1);
    expect(authMeCalls).toBe(2);
    expect(client.getRestAuthToken()).toBe("agent_fresh_key");
    unmount();
  });

  it("falls through to unauthenticated (LoginView) when no cloud session exists", async () => {
    client.setToken("stale_container_token");
    // No Steward token in localStorage — self-hosted-style direct access.

    let mintAttempted = false;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/auth/me")) {
        return jsonResponse(401, { reason: "remote_auth_required" });
      }
      if (url.includes("/pairing-token")) {
        mintAttempted = true;
      }
      throw new Error(`unexpected fetch in test: ${url}`);
    }) as unknown as typeof globalThis.fetch;

    const { result, unmount } = renderHook(() =>
      useAuthStatus({ pollIntervalMs: 0 }),
    );

    await waitFor(
      () => expect(result.current.state.phase).toBe("unauthenticated"),
      { timeout: 10_000 },
    );
    expect(
      result.current.state.phase === "unauthenticated" &&
        result.current.state.reason,
    ).toBe("remote_auth_required");
    expect(mintAttempted).toBe(false);
    unmount();
  });
});
