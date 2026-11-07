import { afterEach, expect, spyOn, test } from "bun:test";
import type { CreateCampaignInput } from "../types";
import { googleAdsProvider } from "./google";

const spies: ReturnType<typeof spyOn>[] = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

interface CapturedRequest {
  path: string;
  body: Record<string, unknown>;
}

/**
 * Answers the customer time-zone query, budget and campaign mutates, and the
 * metrics search. Each case uses its own customer id: the adapter caches a
 * customer's immutable time zone for the life of the process.
 */
function stubGoogleAds(timeZone: string | undefined): CapturedRequest[] {
  const requests: CapturedRequest[] = [];
  spies.push(
    spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const path = new URL(String(url)).pathname;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ path, body });
      if (path.endsWith("/googleAds:searchStream")) {
        const query = String(body.query);
        if (query.includes("customer.time_zone")) {
          return Response.json([
            { results: timeZone ? [{ customer: { resourceName: "customers/1", timeZone } }] : [] },
          ]);
        }
        return Response.json([
          {
            results: [
              {
                campaign: { id: "456" },
                metrics: { impressions: "1", clicks: "1", costMicros: "1000000", conversions: "0" },
              },
            ],
          },
        ]);
      }
      if (path.endsWith("/campaignBudgets:mutate")) {
        return Response.json({ results: [{ resourceName: "customers/123/campaignBudgets/9" }] });
      }
      return Response.json({ results: [{ resourceName: "customers/123/campaigns/456" }] });
    }),
  );
  return requests;
}

const campaignInput: CreateCampaignInput = {
  organizationId: "org-1",
  adAccountId: "acct-1",
  name: "Launch",
  objective: "traffic",
  budgetType: "daily",
  budgetAmount: 50,
  // 00:30 on Oct 14 in Tokyo, still Oct 13 in UTC.
  startDate: new Date("2026-10-13T15:30:00.000Z"),
  // 23:59 on Oct 31 in Los Angeles, already Nov 1 in UTC.
  endDate: new Date("2026-11-01T06:59:00.000Z"),
};

function campaignMutate(requests: CapturedRequest[]): Record<string, unknown> {
  const request = requests.find((entry) => entry.path.endsWith("/campaigns:mutate"));
  const operations = request?.body.operations as Array<Record<string, unknown>>;
  return operations[0];
}

test("createCampaign sends the campaign window as account-local date-times", async () => {
  const requests = stubGoogleAds("Asia/Tokyo");

  const result = await googleAdsProvider.createCampaign(
    { accessToken: "fixture-token" },
    "111",
    campaignInput,
  );

  expect(result).toEqual({ success: true, externalCampaignId: "111/456" });
  const create = campaignMutate(requests).create as Record<string, unknown>;
  expect(create.startDateTime).toBe("2026-10-14 00:00:00");
  expect(create.endDateTime).toBe("2026-11-01 23:59:59");
  expect(create).not.toHaveProperty("startDate");
  expect(create).not.toHaveProperty("endDate");
});

test("updateCampaign sends the new end as the account-local last day", async () => {
  const requests = stubGoogleAds("America/Los_Angeles");

  const result = await googleAdsProvider.updateCampaign(
    { accessToken: "fixture-token" },
    "321/456",
    { endDate: new Date("2026-11-01T06:59:00.000Z") },
  );

  expect(result).toEqual({ success: true, externalCampaignId: "321/456" });
  const operation = campaignMutate(requests);
  expect(operation.updateMask).toBe("endDateTime");
  expect(operation.update).toMatchObject({
    resourceName: "customers/321/campaigns/456",
    endDateTime: "2026-10-31 23:59:59",
  });
});

test("getCampaignMetrics bounds segments.date by account-local days", async () => {
  const requests = stubGoogleAds("Asia/Tokyo");

  const result = await googleAdsProvider.getCampaignMetrics(
    { accessToken: "fixture-token" },
    "222/456",
    {
      start: new Date("2026-10-13T15:30:00.000Z"),
      end: new Date("2026-11-01T06:59:00.000Z"),
    },
  );

  expect(result.success).toBe(true);
  const metricsQuery = requests
    .map((entry) => String(entry.body.query ?? ""))
    .find((query) => query.includes("segments.date"));
  expect(metricsQuery).toContain("segments.date BETWEEN '2026-10-14' AND '2026-11-01'");
});

test("a dated campaign is refused when the account reports no time zone", async () => {
  const requests = stubGoogleAds(undefined);

  await expect(
    googleAdsProvider.createCampaign({ accessToken: "fixture-token" }, "999", campaignInput),
  ).rejects.toThrow(/time zone/);
  expect(requests.some((entry) => entry.path.endsWith("/campaigns:mutate"))).toBe(false);
});
