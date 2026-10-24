import { afterEach, expect, spyOn, test } from "bun:test";
import { metaAdsProvider } from "./meta";

const spies: ReturnType<typeof spyOn>[] = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

function nonJsonGatewayResponse() {
  return new Response("<html>502 Bad Gateway</html>", {
    status: 502,
    headers: { "Content-Type": "text/html" },
  });
}

test("a non-JSON response to a campaign create is not replayed", async () => {
  let calls = 0;
  spies.push(
    spyOn(globalThis, "fetch").mockImplementation(async () => {
      calls += 1;
      return nonJsonGatewayResponse();
    }),
  );
  const result = await metaAdsProvider.createCampaign({ accessToken: "fixture-token" }, "123", {
    organizationId: "org-1",
    adAccountId: "123",
    name: "Fixture Campaign",
    objective: "traffic",
    budgetType: "daily",
    budgetAmount: 10,
  });
  expect(result.success).toBe(false);
  // The create may have committed before its response was lost, so the
  // provider must surface the failure instead of sending the create again.
  expect(calls).toBe(1);
});

test("a non-JSON response to a read is retried and can recover", async () => {
  let calls = 0;
  spies.push(
    spyOn(globalThis, "fetch").mockImplementation(async () => {
      calls += 1;
      if (calls === 1) return nonJsonGatewayResponse();
      return Response.json({ id: "123", name: "Fixture Account" });
    }),
  );
  const result = await metaAdsProvider.validateCredentials({ accessToken: "fixture-token" });
  expect(result.valid).toBe(true);
  expect(calls).toBe(2);
});
