import { afterEach, expect, spyOn, test } from "bun:test";
import type { CreateCampaignInput } from "../types";
import { tiktokAdsProvider } from "./tiktok";

const spies: ReturnType<typeof spyOn>[] = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

function captureTikTokBodies(data: Record<string, unknown>): Array<Record<string, unknown>> {
  const bodies: Array<Record<string, unknown>> = [];
  spies.push(
    spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ code: 0, message: "OK", request_id: "r1", data });
    }),
  );
  return bodies;
}

const campaignInput: CreateCampaignInput = {
  organizationId: "org-1",
  adAccountId: "acct-1",
  name: "Launch",
  objective: "traffic",
  budgetType: "daily",
  budgetAmount: 50,
  budgetCurrency: "USD",
};

test("createCampaign sends the campaign budget in account-currency units", async () => {
  const bodies = captureTikTokBodies({ campaign_id: "c1" });

  const result = await tiktokAdsProvider.createCampaign(
    { accessToken: "fixture-token" },
    "adv-1",
    campaignInput,
  );

  expect(result).toEqual({ success: true, externalCampaignId: "adv-1/c1" });
  expect(bodies).toEqual([
    {
      advertiser_id: "adv-1",
      campaign_name: "Launch",
      objective_type: "TRAFFIC",
      budget_mode: "BUDGET_MODE_DAY",
      budget: 50,
      operation_status: "DISABLE",
    },
  ]);
});

test("createCampaign keeps a two-decimal budget without scaling it", async () => {
  const bodies = captureTikTokBodies({ campaign_id: "c2" });

  await tiktokAdsProvider.createCampaign({ accessToken: "fixture-token" }, "adv-1", {
    ...campaignInput,
    budgetType: "lifetime",
    budgetAmount: 1234.56,
  });

  expect(bodies[0]?.budget_mode).toBe("BUDGET_MODE_TOTAL");
  expect(bodies[0]?.budget).toBe(1234.56);
});

test("updateCampaign sends the new budget in account-currency units", async () => {
  const bodies = captureTikTokBodies({});

  const result = await tiktokAdsProvider.updateCampaign(
    { accessToken: "fixture-token" },
    "adv-1/c1",
    { budgetAmount: 75 },
  );

  expect(result).toEqual({ success: true, externalCampaignId: "adv-1/c1" });
  expect(bodies).toEqual([{ advertiser_id: "adv-1", campaign_id: "c1", budget: 75 }]);
});
