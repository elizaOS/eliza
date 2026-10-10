/**
 * elizacloud_credits provider — the shared-snapshot dedupe (#16873).
 *
 * CLOUD_ACCOUNT and elizacloud_credits share the same contextGate and both
 * previously fetched /credits/balance in the same compose. This suite drives
 * both providers against the real loopback cloud server and asserts the
 * credit provider reuses CLOUD_ACCOUNT's snapshot instead of hitting the
 * billing endpoint a second time in the same cache window.
 */

import type { Memory, State } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cloudAccountProvider } from "../../src/cloud-providers/cloud-account";
import { creditBalanceProvider } from "../../src/cloud-providers/credit-balance";
import { type CloudServer, makeRuntime, startCloudServer } from "./cloud-account-harness";

const MESSAGE = {} as Memory;
const STATE = {} as State;

let server: CloudServer;

beforeEach(async () => {
  server = await startCloudServer();
});

afterEach(async () => {
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

  it("fetches the balance itself (and caches it 60s) when no shared snapshot exists", async () => {
    server.state.balance = 7.5;
    const runtime = makeRuntime({ baseUrl: server.url });
    const first = await creditBalanceProvider.get(runtime, MESSAGE, STATE);
    expect(first.text).toContain("$7.50");
    expect(first.values?.cloudCredits).toBe(7.5);
    expect(balanceFetchCount(server)).toBe(1);

    // Inside the TTL the provider serves its own cache without re-fetching.
    const second = await creditBalanceProvider.get(runtime, MESSAGE, STATE);
    expect(second.text).toContain("$7.50");
    expect(balanceFetchCount(server)).toBe(1);
  });

  it("flags low and critical balances with the top-up pointer", async () => {
    server.state.balance = 1.5;
    const low = await creditBalanceProvider.get(
      makeRuntime({ baseUrl: server.url }),
      MESSAGE,
      STATE
    );
    expect(low.text).toContain("LOW");
    expect(low.values?.cloudCreditsLow).toBe(true);

    server.state.balance = 0.25;
    const critical = await creditBalanceProvider.get(
      makeRuntime({ baseUrl: server.url }),
      MESSAGE,
      STATE
    );
    expect(critical.text).toContain("CRITICAL");
    expect(critical.values?.cloudCreditsCritical).toBe(true);
  });

  it("renders unavailable (never fabricated zeros) when the cold fetch fails", async () => {
    server.state.failBalance = true;
    const result = await creditBalanceProvider.get(
      makeRuntime({ baseUrl: server.url }),
      MESSAGE,
      STATE
    );
    expect(result.text).toBe("");
    expect(result.values?.cloudCreditsUnavailable).toBe(true);
  });
});
