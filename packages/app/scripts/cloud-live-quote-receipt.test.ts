import { createServer } from "node:http";
import { expect, test } from "vitest";
import { createCloudLiveNetworkAudit } from "../test/cloud-live-continuity-contract";

const path = "/api/v1/eliza/agents/private-source/upgrade-tier";
const data = {
  quoteId: "private-quote-identifier",
  sourceAgentId: "private-source-identifier",
  activation: {
    state: "available",
    dedicatedAgentId: "private-target-identifier",
  },
  hourlyRateUsd: 0.01,
  minimumActivationChargeUsd: 0.1,
  dailyRateUsd: 0.24,
  minimumBalanceUsd: 0.72,
  minimumRunwayDays: 3,
  balanceUsd: 7,
  deficitUsd: 0,
  secret: "private-credential-must-never-be-retained",
};

test("observes the existing HTTP quote and retains only actual economic terms without activation", async () => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ success: true, data }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("HTTP fixture did not bind");
  try {
    const url = new URL(path, `http://127.0.0.1:${address.port}`).href;
    const audit = createCloudLiveNetworkAudit();
    audit.observeRequest("GET", url);
    const response = await fetch(url);
    audit.observeResponse("GET", url, response.status, {
      contentType: response.headers.get("content-type"),
      read: async () => new Uint8Array(await response.arrayBuffer()),
    });
    const snapshot = await audit.snapshot();
    expect(snapshot.dedicatedQuoteTerms).toEqual({
      hourlyRateUsd: 0.01,
      minimumActivationChargeUsd: 0.1,
      dailyRateUsd: 0.24,
      minimumBalanceUsd: 0.72,
      minimumRunwayDays: 3,
      balanceUsd: 7,
      deficitUsd: 0,
    });
    expect(snapshot.decodedDedicatedQuoteResponseCount).toBe(1);
    expect(snapshot.dedicatedActivationPostRequestCount).toBe(0);
    expect(requests).toBe(1);
    const receipt = JSON.stringify(snapshot);
    expect(receipt).not.toContain("private-");
    audit.observeRequest("GET", url);
    expect((await audit.snapshot()).dedicatedQuoteTerms).toBeNull();
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("missing or malformed financial fields do not produce an invented quote", async () => {
  for (const altered of [
    { ...data, dailyRateUsd: undefined },
    { ...data, minimumRunwayDays: 2.5 },
    { ...data, quoteId: "" },
  ]) {
    const audit = createCloudLiveNetworkAudit();
    audit.observeRequest("GET", `https://staging.invalid${path}`);
    audit.observeResponse("GET", `https://staging.invalid${path}`, 200, {
      contentType: "application/json",
      read: async () =>
        new TextEncoder().encode(
          JSON.stringify({ success: true, data: altered }),
        ),
    });
    expect((await audit.snapshot()).dedicatedQuoteTerms).toBeNull();
  }
});
