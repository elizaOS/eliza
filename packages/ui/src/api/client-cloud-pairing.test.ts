/**
 * Unit tests for the dedicated-agent pairing flow (`pairDedicatedCloudAgent`).
 * The native CapacitorHttp transport is mocked and routed by URL so we exercise
 * the real client chain: mint pairing-token (auto-resume 202 loop) -> exchange
 * at /api/auth/pair (origin-bound) -> bind target. Mirrors the harness in
 * `client-cloud-direct-auth.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const capacitorMocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  request: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => true },
  CapacitorHttp: {
    get: capacitorMocks.get,
    post: capacitorMocks.post,
    request: capacitorMocks.request,
  },
}));

import { setBootConfig } from "../config/boot-config";
import { ElizaClient } from "./client-base";
import "./client-cloud";

interface NativeReq {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  data?: unknown;
}

const VALID_TOKEN = "A".repeat(43);
const AGENT_ORIGIN = "https://abc123.elizacloud.ai";

function makeClient(): ElizaClient {
  const client = new ElizaClient();
  // Bind to a direct-cloud base so resolveDirectCloudClientApiBase resolves.
  client.setBaseUrl("https://api.elizacloud.ai");
  return client;
}

describe("pairDedicatedCloudAgent", () => {
  beforeEach(() => {
    setBootConfig({ branding: {}, cloudApiBase: "https://www.elizacloud.ai" });
    (globalThis as Record<string, unknown>).__ELIZA_CLOUD_AUTH_TOKEN__ =
      "cloud-tok";
    capacitorMocks.request.mockReset();
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__ELIZA_CLOUD_AUTH_TOKEN__;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("pairs a running agent and returns the bind target with the agent key", async () => {
    const seen: NativeReq[] = [];
    capacitorMocks.request.mockImplementation(async (req: NativeReq) => {
      seen.push(req);
      if (req.url.endsWith("/pairing-token")) {
        return {
          status: 200,
          data: {
            success: true,
            data: {
              token: VALID_TOKEN,
              redirectUrl: `${AGENT_ORIGIN}/pair?token=${VALID_TOKEN}`,
              expiresIn: 60,
            },
          },
        };
      }
      if (req.url.endsWith("/api/auth/pair")) {
        return {
          status: 200,
          data: { apiKey: "agent-secret-key", agentName: "Nyx" },
        };
      }
      throw new Error(`unexpected url ${req.url}`);
    });

    const client = makeClient();
    const result = await client.pairDedicatedCloudAgent("agent-1");

    expect(result).toEqual({
      status: "paired",
      apiBase: AGENT_ORIGIN,
      agentToken: "agent-secret-key",
      agentName: "Nyx",
    });

    // The exchange MUST be origin-bound to the agent web UI origin.
    const exchange = seen.find((r) => r.url.endsWith("/api/auth/pair"));
    expect(exchange?.headers?.Origin).toBe(AGENT_ORIGIN);
    expect(exchange?.data).toEqual({ token: VALID_TOKEN });
  });

  it("waits through a 202 'starting' (cold boot) before pairing", async () => {
    vi.useFakeTimers();
    let pairingCalls = 0;
    const progress: string[] = [];
    capacitorMocks.request.mockImplementation(async (req: NativeReq) => {
      if (req.url.endsWith("/pairing-token")) {
        pairingCalls++;
        if (pairingCalls === 1) {
          return {
            status: 202,
            data: {
              success: true,
              data: {
                status: "starting",
                jobId: "job-1",
                retryAfterMs: 5000,
                message: "Resuming…",
              },
            },
          };
        }
        return {
          status: 200,
          data: {
            success: true,
            data: {
              token: VALID_TOKEN,
              redirectUrl: `${AGENT_ORIGIN}/pair?token=${VALID_TOKEN}`,
              expiresIn: 60,
            },
          },
        };
      }
      return { status: 200, data: { apiKey: "k", agentName: "A" } };
    });

    const client = makeClient();
    const promise = client.pairDedicatedCloudAgent("agent-1", {
      onProgress: (s) => progress.push(s),
    });
    // Let the first poll resolve, then advance past the retry wait.
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(0);
    const result = await promise;

    expect(pairingCalls).toBe(2);
    expect(progress).toContain("starting");
    expect(result.status).toBe("paired");
  });

  it("returns manual_auth when the agent only offers its own password screen", async () => {
    capacitorMocks.request.mockImplementation(async (req: NativeReq) => {
      if (req.url.endsWith("/pairing-token")) {
        return {
          status: 200,
          data: {
            success: true,
            // No /pair?token= — bare web UI URL signals password-only auth.
            data: {
              token: VALID_TOKEN,
              redirectUrl: AGENT_ORIGIN,
              expiresIn: 60,
            },
          },
        };
      }
      throw new Error("exchange should not be attempted for manual_auth");
    });

    const client = makeClient();
    const result = await client.pairDedicatedCloudAgent("agent-1");
    expect(result).toEqual({ status: "manual_auth", webUiUrl: AGENT_ORIGIN });
  });

  it("throws when the agent never finishes starting before the deadline", async () => {
    capacitorMocks.request.mockImplementation(async (req: NativeReq) => {
      if (req.url.endsWith("/pairing-token")) {
        return {
          status: 202,
          data: {
            success: true,
            data: { status: "starting", retryAfterMs: 5000 },
          },
        };
      }
      throw new Error("exchange should not run");
    });

    const client = makeClient();
    await expect(
      // timeoutMs:0 -> deadline already passed, throws after the first 202.
      client.pairDedicatedCloudAgent("agent-1", { timeoutMs: 0 }),
    ).rejects.toThrow(/Timed out waiting/);
  });
});
