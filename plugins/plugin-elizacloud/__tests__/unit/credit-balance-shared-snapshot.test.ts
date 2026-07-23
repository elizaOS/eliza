/**
 * elizacloud_credits provider — the shared-snapshot dedupe (#16873).
 *
 * CLOUD_ACCOUNT and elizacloud_credits share the same contextGate and both
 * previously fetched /credits/balance in the same compose. This suite drives
 * both providers against the real loopback cloud server and asserts the
 * credit provider reuses CLOUD_ACCOUNT's snapshot instead of hitting the
 * billing endpoint a second time in the same cache window.
 */

import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cloudAccountProvider } from "../../src/cloud-providers/cloud-account";
import { creditBalanceProvider } from "../../src/cloud-providers/credit-balance";
import { type CloudServer, makeRuntime, startCloudServer } from "./cloud-account-harness";

/**
 * Runtime whose CLOUD_AUTH exposes getClient() (the credit provider's own
 * fetch path) without any shared CLOUD_ACCOUNT snapshot. Each call gets a
 * FRESH runtime object so the WeakMap caches never leak across tests.
 */
function makeCreditRuntime(options: { balance?: number; fail?: boolean }): IAgentRuntime {
  const client = {
    get: vi.fn(async () => {
      if (options.fail) throw new Error("billing down");
      return { data: { balance: options.balance ?? 7.5 } };
    }),
  };
  const auth = {
    isAuthenticated: () => true,
    getOrganizationId: () => "org-test",
    getUserId: () => "user-test",
    getClient: () => client,
  };
  return {
    getSetting: () => undefined,
    getService: (type: string) => (type === "CLOUD_AUTH" ? auth : null),
  } as unknown as IAgentRuntime;
}

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

function balanceFetchCount(server: CloudServer): number {
  return server.state.requests.filter((r) => r.endsWith("/credits/balance")).length;
}

describe("creditBalanceProvider shared snapshot", () => {
  it("renders empty when signed out (no network)", async () => {
    const runtime = makeRuntime({ baseUrl: server.url, authenticated: false });
    const result = await creditBalanceProvider.get(runtime, MESSAGE, STATE);
    expect(result.text).toBe("");
    expect(server.state.requests).toEqual([]);
  });

  it("reuses CLOUD_ACCOUNT's snapshot instead of re-hitting /credits/balance", async () => {
    const runtime = makeRuntime({ baseUrl: server.url });

    // CLOUD_ACCOUNT warms the shared snapshot with one balance fetch.
    await cloudAccountProvider.get(runtime, MESSAGE, STATE);
    const afterAccount = balanceFetchCount(server);
    expect(afterAccount).toBe(1);

    // The credit provider must render from the shared snapshot with no
    // additional billing round-trip.
    const credits = await creditBalanceProvider.get(runtime, MESSAGE, STATE);
    expect(credits.text).toContain("$12.34");
    expect(credits.values?.cloudCredits).toBe(12.34);
    expect(balanceFetchCount(server)).toBe(afterAccount);
  });

  it("falls back to its own fetch (and 60s cache) when no shared snapshot exists", async () => {
    const runtime = makeCreditRuntime({ balance: 7.5 });
    const first = await creditBalanceProvider.get(runtime, MESSAGE, STATE);
    expect(first.text).toContain("$7.50");
    expect(first.values?.cloudCredits).toBe(7.5);

    // Inside the TTL the provider serves its own cache without re-fetching.
    const second = await creditBalanceProvider.get(runtime, MESSAGE, STATE);
    expect(second.text).toContain("$7.50");
  });

  it("flags low and critical balances with the top-up pointer", async () => {
    const low = await creditBalanceProvider.get(
      makeCreditRuntime({ balance: 1.5 }),
      MESSAGE,
      STATE
    );
    expect(low.text).toContain("LOW");
    expect(low.values?.cloudCreditsLow).toBe(true);

    const critical = await creditBalanceProvider.get(
      makeCreditRuntime({ balance: 0.25 }),
      MESSAGE,
      STATE
    );
    expect(critical.text).toContain("CRITICAL");
    expect(critical.values?.cloudCreditsCritical).toBe(true);
  });

  it("renders unavailable (never fabricated zeros) when the cold fetch fails", async () => {
    const result = await creditBalanceProvider.get(
      makeCreditRuntime({ fail: true }),
      MESSAGE,
      STATE
    );
    expect(result.text).toBe("");
    expect(result.values?.cloudCreditsUnavailable).toBe(true);
  });
});
