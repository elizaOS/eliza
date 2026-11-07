import { afterEach, expect, spyOn, test } from "bun:test";
import { googleAdsProvider } from "./google";

const spies: ReturnType<typeof spyOn>[] = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

test("reads metrics from searchStream batches and retains the persisted integer contract", async () => {
  spies.push(
    spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      if (String(init?.body).includes("customer.time_zone")) {
        return Response.json([
          { results: [{ customer: { resourceName: "customers/123", timeZone: "UTC" } }] },
        ]);
      }
      return Response.json([
        { results: [] },
        {
          results: [
            {
              campaign: { id: "456" },
              metrics: {
                impressions: "100",
                clicks: "10",
                costMicros: "2500000",
                conversions: "2.75",
              },
            },
          ],
        },
      ]);
    }),
  );
  const result = await googleAdsProvider.getCampaignMetrics(
    { accessToken: "fixture-token" },
    "123/456",
  );
  expect(result).toEqual({
    success: true,
    metrics: {
      impressions: 100,
      clicks: 10,
      spend: 2.5,
      conversions: 2,
    },
  });
});

test("propagates a rejected provider request instead of reporting empty metrics", async () => {
  spies.push(
    spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ error: { message: "Access denied" } }, { status: 403 }),
    ),
  );
  await expect(
    googleAdsProvider.getCampaignMetrics({ accessToken: "fixture-token" }, "123/456"),
  ).rejects.toThrow("Access denied");
});
