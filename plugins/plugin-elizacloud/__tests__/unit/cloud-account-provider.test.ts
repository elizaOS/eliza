/**
 * CLOUD_ACCOUNT provider suite — real SDK over a loopback cloud server (see
 * cloud-account-harness.ts): signed-out empty gate, happy-path render, 60s
 * cache, stale-cache-on-failure, empty-on-cold-failure, and the
 * invalidateCloudAccountCache invariant. Only Date is faked (TTL expiry).
 */

import type { Memory, State } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cloudAccountProvider,
  invalidateCloudAccountCache,
} from "../../src/cloud-providers/cloud-account";
import { type CloudServer, makeRuntime, startCloudServer } from "./cloud-account-harness";

const MESSAGE = {} as Memory;
const STATE = {} as State;

let server: CloudServer;

beforeEach(async () => {
  server = await startCloudServer();
});

afterEach(async () => {
  vi.useRealTimers();
  await server.close();
});

describe("cloudAccountProvider", () => {
  it("renders empty with zero network traffic when signed out", async () => {
    const runtime = makeRuntime({ baseUrl: server.url, authenticated: false });
    const result = await cloudAccountProvider.get(runtime, MESSAGE, STATE);
    expect(result.text).toBe("");
    expect(server.state.requests).toEqual([]);
  });

  it("renders balance and hosted agents when signed in", async () => {
    const runtime = makeRuntime({ baseUrl: server.url });
    const result = await cloudAccountProvider.get(runtime, MESSAGE, STATE);
    expect(result.text).toContain("$12.34");
    expect(result.text).toContain("org org-test");
    expect(result.text).toContain("2 hosted agents");
    expect(result.text).toContain("- alpha (running)");
    expect(result.text).toContain("- beta (stopped)");
    expect(result.values?.cloudAgentCount).toBe(2);
    expect(result.values?.cloudCredits).toBe(12.34);
  });

  it("flags a low balance with the top-up pointer", async () => {
    server.state.balance = 0.25;
    const runtime = makeRuntime({ baseUrl: server.url });
    const result = await cloudAccountProvider.get(runtime, MESSAGE, STATE);
    expect(result.text).toContain("CRITICAL");
    expect(result.values?.cloudCreditsCritical).toBe(true);
  });

  it("serves the 60s cache without re-fetching", async () => {
    const runtime = makeRuntime({ baseUrl: server.url });
    await cloudAccountProvider.get(runtime, MESSAGE, STATE);
    const fetches = server.state.requests.length;
    await cloudAccountProvider.get(runtime, MESSAGE, STATE);
    expect(server.state.requests.length).toBe(fetches);
  });

  it("serves the stale cache when a refresh fails past the TTL", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const runtime = makeRuntime({ baseUrl: server.url });
    const first = await cloudAccountProvider.get(runtime, MESSAGE, STATE);
    expect(first.text).toContain("$12.34");

    vi.setSystemTime(Date.now() + 61_000);
    server.state.failBalance = true;
    const second = await cloudAccountProvider.get(runtime, MESSAGE, STATE);
    // Not fabricated zeros, not empty: the last known-good snapshot.
    expect(second.text).toContain("$12.34");
  });

  it("renders empty (never zeros) when the fetch fails with a cold cache", async () => {
    server.state.failBalance = true;
    const runtime = makeRuntime({ baseUrl: server.url });
    const result = await cloudAccountProvider.get(runtime, MESSAGE, STATE);
    expect(result.text).toBe("");
    expect(result.values?.cloudAccountUnavailable).toBe(true);
  });

  it("re-fetches after invalidateCloudAccountCache inside the TTL", async () => {
    const runtime = makeRuntime({ baseUrl: server.url });
    await cloudAccountProvider.get(runtime, MESSAGE, STATE);
    const fetches = server.state.requests.length;

    server.state.balance = 99.0;
    invalidateCloudAccountCache(runtime);
    const result = await cloudAccountProvider.get(runtime, MESSAGE, STATE);
    expect(server.state.requests.length).toBeGreaterThan(fetches);
    expect(result.text).toContain("$99.00");
  });
});
