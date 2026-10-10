/**
 * CLOUD_ACCOUNT snapshot freshness against a sign-in to another organization
 * on the same runtime. The SDK talks to a real loopback cloud server.
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

describe("CLOUD_ACCOUNT freshness", () => {
  it("never renders another organization's snapshot after an account switch", async () => {
    let organizationId = "org-first";
    const runtime = makeRuntime({ baseUrl: server.url, organizationId: () => organizationId });
    expect((await cloudAccountProvider.get(runtime, MESSAGE, STATE)).text).toContain("$12.34");

    organizationId = "org-second";
    server.state.balance = 3.5;
    server.state.agents = [];

    const credits = await creditBalanceProvider.get(runtime, MESSAGE, STATE);
    // The harness auth has no direct client, so the credits provider's own
    // fetch reports unavailable; what matters is the old org's $12.34 is gone.
    expect(credits.text).not.toContain("12.34");
    const account = await cloudAccountProvider.get(runtime, MESSAGE, STATE);
    expect(account.text).toContain("(org org-second): $3.50");
    expect(account.text).toContain("Hosted agents: none yet.");
  });
});
