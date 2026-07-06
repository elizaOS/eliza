// @vitest-environment jsdom
/**
 * Exercises `repairDedicatedAgentCredential` — the popup-free re-pair for a
 * dedicated cloud agent whose container credential rotated (#15132). Only the
 * network boundary (`globalThis.fetch`) is stubbed; the real ElizaClient,
 * steward-session storage, persistence layer, and pairing poll loop run.
 */
import { STEWARD_TOKEN_KEY } from "@elizaos/shared/steward-session-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ElizaClient } from "../api/client-base";
import { getBootConfig, setBootConfig } from "../config/boot-config";
import {
  __resetRepairAgentCredentialStateForTests,
  repairDedicatedAgentCredential,
} from "./repair-agent-credential";

const AGENT_BASE = "https://agent1.elizacloud.ai";
const PAIRING_TOKEN_URL =
  "https://api.elizacloud.ai/api/v1/eliza/agents/agent1/pairing-token";
const PAIR_REDIRECT_URL = `${AGENT_BASE}/pair?token=one-time-t`;
const ACTIVE_SERVER_KEY = "elizaos:active-server";
const PAIR_SESSION_KEY = "eliza:cloud-pair:api-token";

const ORIGINAL_FETCH = globalThis.fetch;

function b64url(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/** Unsigned JWT with a real `exp` so cloudTokenSecsRemaining decodes it. */
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

interface SeenRequest {
  url: string;
  method: string;
  headers: Headers;
}

/**
 * Route-by-URL fetch stub. Each entry is consumed in order per matching URL
 * prefix, so a 202→200 mint sequence can be scripted.
 */
function installFetchRouter(
  routes: Array<{ match: (url: string) => boolean; respond: () => Response }>,
): SeenRequest[] {
  const seen: SeenRequest[] = [];
  globalThis.fetch = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      seen.push({
        url,
        method: (init?.method ?? "GET").toUpperCase(),
        headers: new Headers(init?.headers),
      });
      const index = routes.findIndex((route) => route.match(url));
      if (index === -1) {
        throw new Error(`unexpected fetch in test: ${url}`);
      }
      const [route] = routes.splice(index, 1);
      return route.respond();
    },
  ) as unknown as typeof globalThis.fetch;
  return seen;
}

function mintRoute(response: () => Response) {
  return {
    match: (url: string) => url.startsWith(PAIRING_TOKEN_URL),
    respond: response,
  };
}

function pairRoute(response: () => Response) {
  return {
    match: (url: string) => url.startsWith(`${AGENT_BASE}/pair`),
    respond: response,
  };
}

function seedPersistedCloudServer(accessToken: string): void {
  localStorage.setItem(
    ACTIVE_SERVER_KEY,
    JSON.stringify({
      id: "cloud:agent1",
      kind: "cloud",
      label: "Eliza Cloud",
      apiBase: AGENT_BASE,
      accessToken,
    }),
  );
}

let bootConfigSnapshot: ReturnType<typeof getBootConfig>;

beforeEach(() => {
  bootConfigSnapshot = { ...getBootConfig() };
  localStorage.clear();
  sessionStorage.clear();
  __resetRepairAgentCredentialStateForTests();
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  setBootConfig(bootConfigSnapshot);
  localStorage.clear();
  sessionStorage.clear();
  __resetRepairAgentCredentialStateForTests();
});

describe("repairDedicatedAgentCredential", () => {
  it("declines without touching the network when the base is not a dedicated cloud agent", async () => {
    const seen = installFetchRouter([]);
    const client = new ElizaClient("http://127.0.0.1:31337");
    localStorage.setItem(STEWARD_TOKEN_KEY, makeStewardJwt(3600));

    await expect(repairDedicatedAgentCredential(client)).resolves.toBe(false);
    expect(seen).toHaveLength(0);
  });

  it("declines without touching the network when no cloud (Steward) session exists — the password wall stays reachable", async () => {
    const seen = installFetchRouter([]);
    const client = new ElizaClient(AGENT_BASE);

    await expect(repairDedicatedAgentCredential(client)).resolves.toBe(false);
    expect(seen).toHaveLength(0);
  });

  it("mints, exchanges, and persists a fresh credential everywhere the stale one lives", async () => {
    const client = new ElizaClient(AGENT_BASE);
    client.setToken("stale_container_token");
    localStorage.setItem(STEWARD_TOKEN_KEY, makeStewardJwt(3600));
    seedPersistedCloudServer("stale_container_token");
    sessionStorage.setItem(PAIR_SESSION_KEY, "stale_container_token");

    const seen = installFetchRouter([
      mintRoute(() =>
        jsonResponse(200, {
          success: true,
          data: { token: "one-time-t", redirectUrl: PAIR_REDIRECT_URL },
        }),
      ),
      pairRoute(() => jsonResponse(200, { apiKey: "agent_fresh_key" })),
    ]);

    await expect(repairDedicatedAgentCredential(client)).resolves.toBe(true);

    // Mint carried the Steward Bearer to the control plane.
    expect(seen[0].url).toBe(PAIRING_TOKEN_URL);
    expect(seen[0].method).toBe("POST");
    expect(seen[0].headers.get("Authorization")).toBe(
      `Bearer ${localStorage.getItem(STEWARD_TOKEN_KEY)}`,
    );
    // Exchange asked the relay for JSON (header + query belt-and-braces).
    expect(seen[1].headers.get("Accept")).toBe("application/json");
    expect(new URL(seen[1].url).searchParams.get("format")).toBe("json");
    expect(new URL(seen[1].url).searchParams.get("token")).toBe("one-time-t");

    // Every store that held the stale credential now holds the fresh one.
    expect(client.getRestAuthToken()).toBe("agent_fresh_key");
    expect(sessionStorage.getItem(PAIR_SESSION_KEY)).toBe("agent_fresh_key");
    const persisted = JSON.parse(localStorage.getItem(ACTIVE_SERVER_KEY) ?? "");
    expect(persisted.accessToken).toBe("agent_fresh_key");
    expect(persisted.apiBase).toBe(AGENT_BASE);
  });

  it("rides the 202+Retry-After resume loop before exchanging", async () => {
    const client = new ElizaClient(AGENT_BASE);
    localStorage.setItem(STEWARD_TOKEN_KEY, makeStewardJwt(3600));

    const seen = installFetchRouter([
      mintRoute(() =>
        jsonResponse(202, {
          success: true,
          data: { status: "starting", retryAfterMs: 1 },
        }),
      ),
      mintRoute(() =>
        jsonResponse(200, {
          success: true,
          data: { token: "one-time-t", redirectUrl: PAIR_REDIRECT_URL },
        }),
      ),
      pairRoute(() => jsonResponse(200, { apiKey: "agent_fresh_key" })),
    ]);

    await expect(repairDedicatedAgentCredential(client)).resolves.toBe(true);
    expect(seen.filter((r) => r.url === PAIRING_TOKEN_URL)).toHaveLength(2);
    expect(client.getRestAuthToken()).toBe("agent_fresh_key");
  });

  it("reports failure and skips the exchange when the mint is rejected", async () => {
    const client = new ElizaClient(AGENT_BASE);
    client.setToken("stale_container_token");
    localStorage.setItem(STEWARD_TOKEN_KEY, makeStewardJwt(3600));

    const seen = installFetchRouter([
      mintRoute(() => jsonResponse(401, { error: "Unauthorized" })),
    ]);

    await expect(repairDedicatedAgentCredential(client)).resolves.toBe(false);
    expect(seen).toHaveLength(1);
    expect(client.getRestAuthToken()).toBe("stale_container_token");
  });

  it("reports failure when the redirectUrl carries no pairing token (agent without token pairing)", async () => {
    const client = new ElizaClient(AGENT_BASE);
    client.setToken("stale_container_token");
    localStorage.setItem(STEWARD_TOKEN_KEY, makeStewardJwt(3600));

    const seen = installFetchRouter([
      mintRoute(() =>
        jsonResponse(200, {
          success: true,
          data: { token: "one-time-t", redirectUrl: AGENT_BASE },
        }),
      ),
    ]);

    await expect(repairDedicatedAgentCredential(client)).resolves.toBe(false);
    expect(seen).toHaveLength(1);
    expect(client.getRestAuthToken()).toBe("stale_container_token");
  });

  it("reports failure and keeps the old token when the exchange returns no apiKey", async () => {
    const client = new ElizaClient(AGENT_BASE);
    client.setToken("stale_container_token");
    localStorage.setItem(STEWARD_TOKEN_KEY, makeStewardJwt(3600));

    installFetchRouter([
      mintRoute(() =>
        jsonResponse(200, {
          success: true,
          data: { token: "one-time-t", redirectUrl: PAIR_REDIRECT_URL },
        }),
      ),
      pairRoute(() =>
        jsonResponse(502, { error: "no key", code: "exchange_failed" }),
      ),
    ]);

    await expect(repairDedicatedAgentCredential(client)).resolves.toBe(false);
    expect(client.getRestAuthToken()).toBe("stale_container_token");
  });

  it("single-flights concurrent callers into one network repair", async () => {
    const client = new ElizaClient(AGENT_BASE);
    localStorage.setItem(STEWARD_TOKEN_KEY, makeStewardJwt(3600));

    const seen = installFetchRouter([
      mintRoute(() =>
        jsonResponse(200, {
          success: true,
          data: { token: "one-time-t", redirectUrl: PAIR_REDIRECT_URL },
        }),
      ),
      pairRoute(() => jsonResponse(200, { apiKey: "agent_fresh_key" })),
    ]);

    const [first, second, third] = await Promise.all([
      repairDedicatedAgentCredential(client),
      repairDedicatedAgentCredential(client),
      repairDedicatedAgentCredential(client),
    ]);
    expect(first).toBe(true);
    expect(second).toBe(true);
    expect(third).toBe(true);
    // One mint + one exchange total — not three.
    expect(seen).toHaveLength(2);
  });

  it("caches a completed outcome so a 401 storm cannot re-run the repair back-to-back", async () => {
    const client = new ElizaClient(AGENT_BASE);
    localStorage.setItem(STEWARD_TOKEN_KEY, makeStewardJwt(3600));

    const seen = installFetchRouter([
      mintRoute(() => jsonResponse(401, { error: "Unauthorized" })),
    ]);

    await expect(repairDedicatedAgentCredential(client)).resolves.toBe(false);
    await expect(repairDedicatedAgentCredential(client)).resolves.toBe(false);
    expect(seen).toHaveLength(1);
  });
});
