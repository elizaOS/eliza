import { describe, expect, it } from "bun:test";
import type { AppDeployStatusResponse, AppResponse } from "@elizaos/cloud-sdk";
import {
  classifyDeployStatus,
  type DeployGateConfig,
  type DeployGateDeps,
  runDeployGate,
} from "../src/deploy-gate.ts";
import type { ReachabilityResult } from "../src/reachability.ts";
import { makeApp } from "./helpers";

const FAST_CONFIG: DeployGateConfig = {
  maxAttempts: 5,
  initialDelayMs: 1,
  maxDelayMs: 2,
  probeTimeoutMs: 10,
  requestTimeoutMs: 50,
  healthPath: "/health",
};

function statusRes(
  overrides: Partial<AppDeployStatusResponse>,
): AppDeployStatusResponse {
  return {
    success: true,
    deploymentId: "dep_1",
    status: "BUILDING",
    vercelUrl: null,
    error: null,
    startedAt: null,
    ...overrides,
  };
}

function appRes(productionUrl: string | null): AppResponse {
  return {
    success: true,
    app: makeApp({
      production_url: productionUrl,
      deployment_status: "deployed",
    }),
  };
}

/** Build deps that walk a fixed status sequence, then probe a fixed result. */
function makeDeps(args: {
  statuses: AppDeployStatusResponse[];
  productionUrl?: string | null;
  probe?: ReachabilityResult;
  onProbe?: (url: string) => void;
}): DeployGateDeps & { statusCalls: number; appCalls: number } {
  let statusCalls = 0;
  let appCalls = 0;
  const deps: DeployGateDeps & { statusCalls: number; appCalls: number } = {
    statusCalls: 0,
    appCalls: 0,
    getStatus: () => {
      const idx = Math.min(statusCalls, args.statuses.length - 1);
      statusCalls += 1;
      deps.statusCalls = statusCalls;
      return Promise.resolve(args.statuses[idx]);
    },
    getApp: () => {
      appCalls += 1;
      deps.appCalls = appCalls;
      return Promise.resolve(appRes(args.productionUrl ?? null));
    },
    probe: (url) => {
      args.onProbe?.(url);
      return Promise.resolve(args.probe ?? { ok: true, status: 200 });
    },
    sleep: () => Promise.resolve(),
  };
  return deps;
}

describe("classifyDeployStatus", () => {
  it("maps the public lifecycle to success/error/pending", () => {
    expect(classifyDeployStatus("READY")).toBe("success");
    expect(classifyDeployStatus("deployed")).toBe("success");
    expect(classifyDeployStatus("ERROR")).toBe("error");
    expect(classifyDeployStatus("failed")).toBe("error");
    expect(classifyDeployStatus("BUILDING")).toBe("pending");
    expect(classifyDeployStatus("DEPLOYING")).toBe("pending");
    expect(classifyDeployStatus("DRAFT")).toBe("pending");
    expect(classifyDeployStatus(null)).toBe("pending");
  });
});

describe("runDeployGate", () => {
  it("succeeds: BUILDING → BUILDING → READY + reachable /health → live url", async () => {
    let probedUrl = "";
    const deps = makeDeps({
      statuses: [
        statusRes({ status: "BUILDING" }),
        statusRes({ status: "BUILDING" }),
        statusRes({ status: "READY" }),
      ],
      productionUrl: "https://acme.elizacloud.ai",
      probe: { ok: true, status: 200 },
      onProbe: (u) => {
        probedUrl = u;
      },
    });

    const result = await runDeployGate(deps, FAST_CONFIG);

    expect(result.phase).toBe("ready");
    expect(result.url).toBe("https://acme.elizacloud.ai");
    expect(result.attempts).toBe(3);
    expect(probedUrl).toBe("https://acme.elizacloud.ai/health");
    expect(result.reachability?.ok).toBe(true);
  });

  it("reads the authoritative production_url, not the status vercelUrl", async () => {
    const deps = makeDeps({
      // status reports a stale/placeholder url; the app row is authoritative
      statuses: [
        statusRes({ status: "READY", vercelUrl: "https://stale.example" }),
      ],
      productionUrl: "https://fresh.elizacloud.ai",
      probe: { ok: true, status: 200 },
    });
    const result = await runDeployGate(deps, FAST_CONFIG);
    expect(result.url).toBe("https://fresh.elizacloud.ai");
  });

  it("times out when status never reaches READY", async () => {
    const deps = makeDeps({
      statuses: [statusRes({ status: "BUILDING" })],
      probe: { ok: true, status: 200 },
    });
    const result = await runDeployGate(deps, {
      ...FAST_CONFIG,
      maxAttempts: 3,
    });
    expect(result.phase).toBe("timeout");
    expect(result.attempts).toBe(3);
    expect(deps.statusCalls).toBe(3);
  });

  it("returns ERROR immediately on a failed deploy", async () => {
    const deps = makeDeps({
      statuses: [statusRes({ status: "ERROR", error: "build failed: exit 1" })],
    });
    const result = await runDeployGate(deps, FAST_CONFIG);
    expect(result.phase).toBe("error");
    expect(result.error).toBe("build failed: exit 1");
    expect(deps.statusCalls).toBe(1);
  });

  it("reports unreachable when READY but /health returns a Caddy gateway error (503)", async () => {
    const deps = makeDeps({
      statuses: [statusRes({ status: "READY" })],
      productionUrl: "https://acme.elizacloud.ai",
      probe: { ok: false, status: 503 },
    });
    const result = await runDeployGate(deps, FAST_CONFIG);
    expect(result.phase).toBe("unreachable");
    expect(result.url).toBe("https://acme.elizacloud.ai");
    expect(result.reachability?.status).toBe(503);
  });

  it("REGRESSION: an auth-gated app (READY + /health 401) is LIVE, not 'not live'", async () => {
    // The server marks such an app READY (401 is not a gateway error), so the
    // gate must agree instead of contradicting GET_APP_DEPLOY_STATUS.
    const deps = makeDeps({
      statuses: [statusRes({ status: "READY" })],
      productionUrl: "https://acme.elizacloud.ai",
      probe: { ok: false, status: 401 },
    });
    const result = await runDeployGate(deps, FAST_CONFIG);
    expect(result.phase).toBe("ready");
    expect(result.url).toBe("https://acme.elizacloud.ai");
  });

  it("REGRESSION: an app with no /health route (READY + 404) is LIVE", async () => {
    const deps = makeDeps({
      statuses: [statusRes({ status: "READY" })],
      productionUrl: "https://acme.elizacloud.ai",
      probe: { ok: false, status: 404 },
    });
    const result = await runDeployGate(deps, FAST_CONFIG);
    expect(result.phase).toBe("ready");
  });

  it("reports unreachable when the probe never gets a response (network error, no status)", async () => {
    const deps = makeDeps({
      statuses: [statusRes({ status: "READY" })],
      productionUrl: "https://acme.elizacloud.ai",
      probe: { ok: false, error: "ECONNREFUSED" },
    });
    const result = await runDeployGate(deps, FAST_CONFIG);
    expect(result.phase).toBe("unreachable");
  });

  it("reports unreachable when READY but no production_url exists", async () => {
    const deps = makeDeps({
      statuses: [statusRes({ status: "READY", vercelUrl: null })],
      productionUrl: null,
      probe: { ok: true, status: 200 },
    });
    const result = await runDeployGate(deps, FAST_CONFIG);
    expect(result.phase).toBe("unreachable");
    expect(result.error).toBe("no_production_url");
  });
});

describe("runDeployGate — poll robustness (transient errors + per-request timeout)", () => {
  it("REGRESSION: one throwing status poll does NOT abort the gate — it keeps polling and still resolves READY", async () => {
    // Poll 1 throws (network blip), poll 2 is BUILDING, poll 3 is READY.
    let calls = 0;
    const pollErrors: Array<{ error: unknown; attempt: number }> = [];
    const responses = [
      statusRes({ status: "BUILDING" }),
      statusRes({ status: "READY" }),
    ];
    const deps: DeployGateDeps = {
      getStatus: () => {
        calls += 1;
        if (calls === 1) {
          return Promise.reject(new Error("ECONNRESET: transient blip"));
        }
        return Promise.resolve(
          responses[Math.min(calls - 2, responses.length - 1)],
        );
      },
      getApp: () => Promise.resolve(appRes("https://acme.elizacloud.ai")),
      probe: () => Promise.resolve({ ok: true, status: 200 }),
      sleep: () => Promise.resolve(),
      onPollError: (error, attempt) => pollErrors.push({ error, attempt }),
    };

    const result = await runDeployGate(deps, FAST_CONFIG);

    expect(result.phase).toBe("ready");
    expect(result.url).toBe("https://acme.elizacloud.ai");
    expect(result.attempts).toBe(3);
    expect(pollErrors).toHaveLength(1);
    expect(pollErrors[0]?.attempt).toBe(1);
    expect((pollErrors[0]?.error as Error).message).toContain("ECONNRESET");
  });

  it("a stalled status poll is cut off by the per-request timeout (signal aborts) and the gate continues", async () => {
    // Poll 1 stalls forever unless the abort signal fires; poll 2 is READY.
    let calls = 0;
    let sawAbort = false;
    const pollErrors: unknown[] = [];
    const deps: DeployGateDeps = {
      getStatus: (signal) => {
        calls += 1;
        if (calls === 1) {
          // Simulate a signal-honoring fetch: resolve never, reject on abort.
          return new Promise((_, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                sawAbort = true;
                reject(signal.reason);
              },
              { once: true },
            );
          });
        }
        return Promise.resolve(statusRes({ status: "READY" }));
      },
      getApp: () => Promise.resolve(appRes("https://acme.elizacloud.ai")),
      probe: () => Promise.resolve({ ok: true, status: 200 }),
      sleep: () => Promise.resolve(),
      onPollError: (error) => pollErrors.push(error),
    };

    const result = await runDeployGate(deps, {
      ...FAST_CONFIG,
      requestTimeoutMs: 5,
    });

    expect(result.phase).toBe("ready");
    expect(result.attempts).toBe(2);
    expect(sawAbort).toBe(true);
    expect(pollErrors).toHaveLength(1);
    expect((pollErrors[0] as Error).message).toContain("timed out after 5ms");
  });

  it("even a signal-IGNORING stalled poll cannot hang the gate (raced against the deadline)", async () => {
    let calls = 0;
    const deps: DeployGateDeps = {
      getStatus: () => {
        calls += 1;
        if (calls === 1) {
          return new Promise(() => {}); // never settles, ignores the signal
        }
        return Promise.resolve(statusRes({ status: "READY" }));
      },
      getApp: () => Promise.resolve(appRes("https://acme.elizacloud.ai")),
      probe: () => Promise.resolve({ ok: true, status: 200 }),
      sleep: () => Promise.resolve(),
    };

    const result = await runDeployGate(deps, {
      ...FAST_CONFIG,
      requestTimeoutMs: 5,
    });

    expect(result.phase).toBe("ready");
    expect(result.attempts).toBe(2);
  });

  it("every poll failing still returns the HONEST timeout result (never claims done)", async () => {
    const pollAttempts: number[] = [];
    const deps: DeployGateDeps = {
      getStatus: () => Promise.reject(new Error("boom")),
      getApp: () => Promise.resolve(appRes("https://acme.elizacloud.ai")),
      probe: () => Promise.resolve({ ok: true, status: 200 }),
      sleep: () => Promise.resolve(),
      onPollError: (_error, attempt) => pollAttempts.push(attempt),
    };

    const result = await runDeployGate(deps, {
      ...FAST_CONFIG,
      maxAttempts: 3,
    });

    expect(result.phase).toBe("timeout");
    expect(result.attempts).toBe(3);
    expect(pollAttempts).toEqual([1, 2, 3]);
  });

  it("a stalled app re-read after READY falls back to the status vercelUrl instead of hanging", async () => {
    const deps: DeployGateDeps = {
      getStatus: () =>
        Promise.resolve(
          statusRes({ status: "READY", vercelUrl: "https://fallback.example" }),
        ),
      getApp: () => new Promise(() => {}), // stalls forever
      probe: () => Promise.resolve({ ok: true, status: 200 }),
      sleep: () => Promise.resolve(),
    };

    const result = await runDeployGate(deps, {
      ...FAST_CONFIG,
      requestTimeoutMs: 5,
    });

    expect(result.phase).toBe("ready");
    expect(result.url).toBe("https://fallback.example");
  });
});
