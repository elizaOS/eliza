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
    const requestIdentity = {};
    audit.observeRequest("GET", url, undefined, requestIdentity);
    const response = await fetch(url);
    audit.observeResponse(
      "GET",
      url,
      response.status,
      {
        contentType: response.headers.get("content-type"),
        read: async () => new Uint8Array(await response.arrayBuffer()),
      },
      requestIdentity,
    );
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
    audit.observeRequest("GET", url, undefined, {});
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
    const requestIdentity = {};
    audit.observeRequest(
      "GET",
      `https://staging.invalid${path}`,
      undefined,
      requestIdentity,
    );
    audit.observeResponse(
      "GET",
      `https://staging.invalid${path}`,
      200,
      {
        contentType: "application/json",
        read: async () =>
          new TextEncoder().encode(
            JSON.stringify({ success: true, data: altered }),
          ),
      },
      requestIdentity,
    );
    expect((await audit.snapshot()).dedicatedQuoteTerms).toBeNull();
  }
});

for (const delayed of ["headers", "body"] as const) {
  test(`an older quote with delayed ${delayed} cannot replace the current request receipt`, async () => {
    let requests = 0;
    let olderResponse: import("node:http").ServerResponse | undefined;
    let firstRequestSeen!: () => void;
    const firstRequest = new Promise<void>((resolve) => {
      firstRequestSeen = resolve;
    });
    const quote = (balanceUsd: number) => ({
      success: true,
      data: { ...data, quoteId: `private-quote-${balanceUsd}`, balanceUsd },
    });
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      if (++requests === 1) {
        olderResponse = response;
        if (delayed === "body") response.flushHeaders();
        firstRequestSeen();
      } else response.end(JSON.stringify(quote(9)));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("HTTP fixture did not bind");
    const url = new URL(path, `http://127.0.0.1:${address.port}`).href;
    const audit = createCloudLiveNetworkAudit();
    const olderRequest = {};
    const currentRequest = {};
    const observe = (response: Response, identity: object) => {
      audit.observeResponse(
        "GET",
        url,
        response.status,
        {
          contentType: response.headers.get("content-type"),
          read: async () => new Uint8Array(await response.arrayBuffer()),
        },
        identity,
      );
    };
    try {
      audit.observeRequest("GET", url, undefined, olderRequest);
      const older = fetch(url);
      await firstRequest;
      if (delayed === "body") observe(await older, olderRequest);
      audit.observeRequest("GET", url, undefined, currentRequest);
      const current = await fetch(url);
      let currentBodySeen!: () => void;
      const currentBody = new Promise<void>((resolve) => {
        currentBodySeen = resolve;
      });
      audit.observeResponse(
        "GET",
        url,
        current.status,
        {
          contentType: current.headers.get("content-type"),
          read: async () => {
            const bytes = new Uint8Array(await current.arrayBuffer());
            currentBodySeen();
            return bytes;
          },
        },
        currentRequest,
      );
      await currentBody;
      // Finish the current inspection before releasing the older HTTP response.
      await new Promise<void>((resolve) => setImmediate(resolve));
      olderResponse?.end(JSON.stringify(quote(7)));
      if (delayed === "headers") observe(await older, olderRequest);
      const snapshot = await audit.snapshot();
      expect(snapshot.dedicatedQuoteTerms?.balanceUsd).toBe(9);
      expect(snapshot.decodedDedicatedQuoteResponseCount).toBe(2);
      expect(snapshot.dedicatedActivationPostRequestCount).toBe(0);
      expect(requests).toBe(2);
      expect(
        (await audit.latestDedicatedActivationApprovalBinding())?.quoteId,
      ).toBe("private-quote-9");
      expect(JSON.stringify(snapshot)).not.toContain("private-");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
}
