// @vitest-environment jsdom

/**
 * Existing-install boot probe (`first-run-bootstrap`). Two concerns:
 *
 *  - the wait-for-boot retry that stops a committed on-device runtime (mobile
 *    `local`/`cloud-hybrid`) from re-onboarding while its ~30s native boot is
 *    still in flight (#16065), plus the error classification that keeps a
 *    genuine agent fault from being masked as first-run;
 *  - the #16242 gate that skips the probe on a bare Eliza Cloud control-plane
 *    origin (where the same-origin API is auth-gated and would only 401).
 *
 * Drives the real functions with an injected probe client (real `ApiError`
 * shapes, controllable timing) — no network, nothing under test mocked. Fake
 * timers make the 45s/1s boot waits deterministic; `window.location.origin` is
 * stubbed to exercise the origin gate.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type ApiErrorKind } from "../api/client-types-core";
import {
  detectExistingFirstRunConnection,
  type ExistingFirstRunProbeClient,
  isBootingAgentProbeError,
  shouldProbeExistingLocalInstall,
} from "./first-run-bootstrap";

const PROBE_PATH = "/api/first-run/status";

function apiError(kind: ApiErrorKind, status?: number): ApiError {
  return new ApiError({
    kind,
    status,
    path: PROBE_PATH,
    message: status ? `HTTP ${status}` : kind,
  });
}

/**
 * A probe client whose `getFirstRunStatus` plays a scripted sequence of
 * outcomes — each entry is either a thrown error (transport/HTTP failure) or a
 * resolved status — so a cold boot's "unreachable, unreachable, …, ready" can
 * be reproduced exactly. `getConfig` resolves empty unless overridden.
 */
function scriptedClient(
  outcomes: Array<{ throw: unknown } | { status: { complete: boolean } }>,
  config: Record<string, unknown> | null = null,
): ExistingFirstRunProbeClient & { calls: () => number } {
  let call = 0;
  return {
    apiAvailable: true,
    calls: () => call,
    getFirstRunStatus: () => {
      const outcome = outcomes[Math.min(call, outcomes.length - 1)];
      call += 1;
      if ("throw" in outcome) return Promise.reject(outcome.throw);
      return Promise.resolve(outcome.status);
    },
    getConfig: () => Promise.resolve(config),
  };
}

const originalLocation = Object.getOwnPropertyDescriptor(window, "location");

function setOrigin(url: string): void {
  const u = new URL(url);
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      href: u.href,
      origin: u.origin,
      protocol: u.protocol,
      host: u.host,
      hostname: u.hostname,
      port: u.port,
      pathname: u.pathname,
      search: u.search,
      hash: u.hash,
      assign: () => {},
      replace: () => {},
      reload: () => {},
      toString: () => u.href,
    },
  });
}

function makeClient(
  overrides: Partial<ExistingFirstRunProbeClient> = {},
): ExistingFirstRunProbeClient {
  return {
    apiAvailable: true,
    getFirstRunStatus: vi.fn(async () => ({ complete: false })),
    getConfig: vi.fn(async () => ({})),
    ...overrides,
  };
}

afterEach(() => {
  if (originalLocation) {
    Object.defineProperty(window, "location", originalLocation);
  }
});

describe("isBootingAgentProbeError", () => {
  it("classifies transport-level and gateway-unavailable failures as still-booting", () => {
    expect(isBootingAgentProbeError(apiError("network"))).toBe(true);
    expect(isBootingAgentProbeError(apiError("timeout"))).toBe(true);
    // Native iOS/Android transports answer a not-yet-ready kernel with 503;
    // 502/504 are the same gateway-unavailable band.
    expect(isBootingAgentProbeError(apiError("http", 502))).toBe(true);
    expect(isBootingAgentProbeError(apiError("http", 503))).toBe(true);
    expect(isBootingAgentProbeError(apiError("http", 504))).toBe(true);
  });

  it("classifies an agent that ANSWERED with an error as a genuine fault", () => {
    expect(isBootingAgentProbeError(apiError("http", 401))).toBe(false);
    expect(isBootingAgentProbeError(apiError("http", 403))).toBe(false);
    expect(isBootingAgentProbeError(apiError("http", 404))).toBe(false);
    expect(isBootingAgentProbeError(apiError("http", 500))).toBe(false);
    expect(isBootingAgentProbeError(apiError("parse"))).toBe(false);
  });

  it("treats an unrecognized (non-ApiError) throw as genuine, never as booting", () => {
    expect(isBootingAgentProbeError(new Error("boom"))).toBe(false);
    expect(isBootingAgentProbeError("boom")).toBe(false);
    expect(isBootingAgentProbeError(null)).toBe(false);
  });
});

describe("detectExistingFirstRunConnection — wait-for-boot retry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries a still-booting agent and restores once it finally answers (no re-onboard)", async () => {
    // Three unreachable probes (the on-device agent binding its socket), then a
    // completed first-run — the returning user is restored, not re-onboarded.
    const client = scriptedClient([
      { throw: apiError("network") },
      { throw: apiError("http", 503) },
      { throw: apiError("timeout") },
      { status: { complete: true } },
    ]);

    const promise = detectExistingFirstRunConnection({
      client,
      timeoutMs: 45_000,
      waitForBootingAgent: true,
    });

    // Each retry waits 1s; drive four attempts.
    await vi.advanceTimersByTimeAsync(4_000);
    const result = await promise;

    expect(result).toEqual({
      activeServer: expect.objectContaining({ kind: "local" }),
      detectedExistingInstall: true,
    });
    expect(client.calls()).toBe(4);
  });

  it("returns null (onboard) when the agent never boots within the timeout", async () => {
    const client = scriptedClient([{ throw: apiError("network") }]);

    const promise = detectExistingFirstRunConnection({
      client,
      timeoutMs: 45_000,
      waitForBootingAgent: true,
    });

    await vi.advanceTimersByTimeAsync(46_000);
    expect(await promise).toBeNull();
  });

  it("stops probing once the outer timeout settles the race (cancellation)", async () => {
    const client = scriptedClient([{ throw: apiError("network") }]);

    const promise = detectExistingFirstRunConnection({
      client,
      timeoutMs: 10_000,
      waitForBootingAgent: true,
    });

    await vi.advanceTimersByTimeAsync(11_000);
    expect(await promise).toBeNull();
    const callsAtTimeout = client.calls();

    // Long after the race settled, the retry loop must not keep firing probes.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(client.calls()).toBe(callsAtTimeout);
  });

  it("SURFACES a genuine agent fault (auth) instead of retrying it into first-run", async () => {
    const client = scriptedClient([{ throw: apiError("http", 401) }]);

    await expect(
      detectExistingFirstRunConnection({
        client,
        timeoutMs: 45_000,
        waitForBootingAgent: true,
      }),
    ).rejects.toMatchObject({ kind: "http", status: 401 });
    // One shot — a genuine fault is not retried across the boot window.
    expect(client.calls()).toBe(1);
  });

  it("SURFACES a malformed-response (parse) fault rather than masking it", async () => {
    const client = scriptedClient([{ throw: apiError("parse") }]);

    await expect(
      detectExistingFirstRunConnection({
        client,
        timeoutMs: 45_000,
        waitForBootingAgent: true,
      }),
    ).rejects.toMatchObject({ kind: "parse" });
  });
});

describe("detectExistingFirstRunConnection — fresh-install single shot", () => {
  it("does not wait: any failure resolves to null immediately (fast onboarding)", async () => {
    // Even an auth error is "no install here" for a fresh install — the single
    // shot never throws and never retries, so onboarding is instant.
    const client = scriptedClient([{ throw: apiError("http", 401) }]);

    const result = await detectExistingFirstRunConnection({
      client,
      timeoutMs: 3_500,
      // waitForBootingAgent omitted → fresh-install path
    });

    expect(result).toBeNull();
    expect(client.calls()).toBe(1);
  });

  it("restores immediately when a fresh probe finds a completed first-run", async () => {
    const client = scriptedClient([{ status: { complete: true } }]);

    const result = await detectExistingFirstRunConnection({
      client,
      timeoutMs: 3_500,
    });

    expect(result).toEqual({
      activeServer: expect.objectContaining({ kind: "local" }),
      detectedExistingInstall: true,
    });
  });

  it("detects an existing install from persisted config when first-run is incomplete", async () => {
    const client = scriptedClient([{ status: { complete: false } }], {
      meta: { firstRunComplete: true },
    });

    const result = await detectExistingFirstRunConnection({
      client,
      timeoutMs: 3_500,
    });

    expect(result).toMatchObject({ detectedExistingInstall: true });
  });

  it("returns null without probing when the API is unavailable", async () => {
    const client = scriptedClient([{ status: { complete: true } }]);
    const result = await detectExistingFirstRunConnection({
      client: { ...client, apiAvailable: false },
      timeoutMs: 3_500,
      waitForBootingAgent: true,
    });
    expect(result).toBeNull();
    expect(client.calls()).toBe(0);
  });
});

describe("shouldProbeExistingLocalInstall (#16242)", () => {
  it("is false only on a bare Cloud control-plane origin", () => {
    expect(shouldProbeExistingLocalInstall("https://app.elizacloud.ai")).toBe(
      false,
    );
    expect(shouldProbeExistingLocalInstall("https://elizacloud.ai")).toBe(
      false,
    );
    expect(shouldProbeExistingLocalInstall("http://localhost:2138")).toBe(true);
    expect(shouldProbeExistingLocalInstall("https://agent.example.com")).toBe(
      true,
    );
    expect(shouldProbeExistingLocalInstall(null)).toBe(true);
    expect(shouldProbeExistingLocalInstall(undefined)).toBe(true);
  });
});

describe("detectExistingFirstRunConnection — Cloud-origin gate (#16242)", () => {
  beforeEach(() => {
    setOrigin("http://localhost:2138/");
  });

  it("returns null and never probes when the API is unavailable", async () => {
    const client = makeClient({ apiAvailable: false });
    const result = await detectExistingFirstRunConnection({
      client,
      timeoutMs: 1000,
    });
    expect(result).toBeNull();
    expect(client.getFirstRunStatus).not.toHaveBeenCalled();
  });

  it("skips the probe on a Cloud control-plane origin (#16242)", async () => {
    setOrigin("https://app.elizacloud.ai/");
    const client = makeClient();
    const result = await detectExistingFirstRunConnection({
      client,
      timeoutMs: 1000,
    });
    expect(result).toBeNull();
    // The gate returns before any protected probe is issued.
    expect(client.getFirstRunStatus).not.toHaveBeenCalled();
    expect(client.getConfig).not.toHaveBeenCalled();
  });

  it("detects a completed backend install from first-run status", async () => {
    const client = makeClient({
      getFirstRunStatus: vi.fn(async () => ({ complete: true })),
    });
    const result = await detectExistingFirstRunConnection({
      client,
      timeoutMs: 1000,
    });
    expect(result).toMatchObject({ detectedExistingInstall: true });
    expect(result?.activeServer.kind).toBe("local");
    expect(client.getConfig).not.toHaveBeenCalled();
  });

  it("detects an existing install from persisted config when first-run is incomplete", async () => {
    const client = makeClient({
      getFirstRunStatus: vi.fn(async () => ({ complete: false })),
      getConfig: vi.fn(async () => ({ meta: { firstRunComplete: true } })),
    });
    const result = await detectExistingFirstRunConnection({
      client,
      timeoutMs: 1000,
    });
    expect(result).toMatchObject({ detectedExistingInstall: true });
    expect(client.getConfig).toHaveBeenCalledTimes(1);
  });

  it("returns null when no install is detected (incomplete + empty config)", async () => {
    const client = makeClient({
      getFirstRunStatus: vi.fn(async () => ({ complete: false })),
      getConfig: vi.fn(async () => ({})),
    });
    const result = await detectExistingFirstRunConnection({
      client,
      timeoutMs: 1000,
    });
    expect(result).toBeNull();
  });

  it("returns null when the status probe throws (agent unreachable)", async () => {
    const client = makeClient({
      getFirstRunStatus: vi.fn(async () => {
        throw new Error("unreachable");
      }),
    });
    const result = await detectExistingFirstRunConnection({
      client,
      timeoutMs: 1000,
    });
    expect(result).toBeNull();
  });
});
