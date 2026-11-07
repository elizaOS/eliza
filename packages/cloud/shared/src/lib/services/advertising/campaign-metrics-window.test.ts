import { afterEach, expect, mock, spyOn, test } from "bun:test";

/**
 * The service's spend accounting reads a campaign's lifetime metrics; a
 * windowed analytics read must neither widen nor overwrite that figure.
 * Repositories are replaced by in-memory stubs; the service and the provider
 * contract are real.
 */
const campaign = {
  id: "campaign-1",
  organization_id: "org-1",
  ad_account_id: "account-1",
  external_campaign_id: "acct/ext-1",
  start_date: new Date("2026-06-01T00:00:00.000Z"),
  created_at: new Date("2026-05-28T12:00:00.000Z"),
  total_spend: "0.00",
  total_impressions: 0,
  total_clicks: 0,
  total_conversions: 0,
};
const updates: unknown[] = [];
const account = { id: "account-1", platform: "meta", status: "active" };
mock.module("../../../db/repositories", () => ({
  adAccountsRepository: {
    findById: async () => account,
  },
  adCampaignsRepository: {
    findById: async () => campaign,
    updateMetrics: async (...args: unknown[]) => {
      updates.push(args);
    },
  },
  adConversionsRepository: {
    getCampaignRollup: async () => ({ conversions: 0, value: 0 }),
  },
  adAudienceSegmentsRepository: {},
  adCreativesRepository: {},
  adReportSharesRepository: {},
  adTransactionsRepository: {},
}));

const { advertisingService } = await import("./index");

const spies: ReturnType<typeof spyOn>[] = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  updates.length = 0;
  account.platform = "meta";
  campaign.start_date = new Date("2026-06-01T00:00:00.000Z");
  campaign.created_at = new Date("2026-05-28T12:00:00.000Z");
  campaign.external_campaign_id = "acct/ext-1";
});

function stubProvider() {
  const ranges: Array<{ start: Date; end: Date } | undefined> = [];
  spies.push(
    spyOn(
      advertisingService as unknown as { getCredentials: () => Promise<unknown> },
      "getCredentials",
    ).mockResolvedValue({ accessToken: "fixture-token" }),
  );
  spies.push(
    spyOn(advertisingService, "getProvider").mockReturnValue({
      async getCampaignMetrics(
        _credentials: unknown,
        _id: string,
        dateRange?: { start: Date; end: Date },
      ) {
        ranges.push(dateRange);
        return {
          success: true,
          metrics: { spend: 42.5, impressions: 1000, clicks: 50, conversions: 3 },
        };
      },
    } as never),
  );
  return ranges;
}

test("a lifetime read asks the platform for the whole campaign and stores the totals", async () => {
  const ranges = stubProvider();
  const before = Date.now();

  const metrics = await advertisingService.getCampaignMetrics("campaign-1", "org-1");

  expect(metrics.spend).toBe(42.5);
  expect(ranges).toHaveLength(1);
  expect(ranges[0]?.start).toEqual(campaign.created_at);
  expect(ranges[0]?.end.getTime()).toBeGreaterThanOrEqual(before);
  expect(updates).toEqual([
    [
      "campaign-1",
      { totalSpend: "42.5", totalImpressions: 1000, totalClicks: 50, totalConversions: 3 },
    ],
  ]);
});

test("a scheduled start moved after earlier spend does not shorten the lifetime", async () => {
  const ranges = stubProvider();
  // The campaign spent in June; the user later moved its scheduled start to October.
  campaign.start_date = new Date("2026-10-01T00:00:00.000Z");

  await advertisingService.getCampaignMetrics("campaign-1", "org-1");

  expect(ranges[0]?.start).toEqual(new Date("2026-05-28T12:00:00.000Z"));
  expect(updates).toHaveLength(1);
});

test("a windowed read passes the window through and leaves the stored totals alone", async () => {
  const ranges = stubProvider();
  const window = {
    start: new Date("2026-10-01T00:00:00.000Z"),
    end: new Date("2026-10-02T00:00:00.000Z"),
  };

  const metrics = await advertisingService.getCampaignMetrics("campaign-1", "org-1", window);

  expect(metrics.spend).toBe(42.5);
  expect(ranges).toEqual([window]);
  expect(updates).toEqual([]);
});

test("an X campaign older than seven days refreshes its lifetime totals through the real adapter", async () => {
  process.env.X_ADS_CONSUMER_KEY = "consumer-key";
  process.env.X_ADS_CONSUMER_SECRET = "consumer-secret";
  account.platform = "x-twitter";
  // X ids are account/campaign/line-item.
  campaign.external_campaign_id = "acct-1/c-1/li-1";
  const DAY_MS = 24 * 60 * 60 * 1000;
  campaign.created_at = new Date(Date.now() - 134 * DAY_MS);
  campaign.start_date = campaign.created_at;
  spies.push(
    spyOn(
      advertisingService as unknown as { getCredentials: () => Promise<unknown> },
      "getCredentials",
    ).mockResolvedValue({ accessToken: "access-token", refreshToken: "token-secret" }),
  );
  const statsUrls: URL[] = [];
  spies.push(
    spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      statsUrls.push(new URL(String(input)));
      return Response.json({
        data: [
          {
            id: "li-1",
            id_data: [
              {
                metrics: {
                  impressions: [100],
                  clicks: [4],
                  billed_charge_local_micro: [2_500_000],
                },
              },
            ],
          },
        ],
      });
    }),
  );

  const metrics = await advertisingService.getCampaignMetrics("campaign-1", "org-1");

  // 134 days of lifetime -> 20 stats requests of at most seven days each.
  expect(statsUrls).toHaveLength(20);
  for (const url of statsUrls) {
    const from = new Date(url.searchParams.get("start_time") ?? "");
    const to = new Date(url.searchParams.get("end_time") ?? "");
    expect(to.getTime() - from.getTime()).toBeLessThanOrEqual(7 * DAY_MS);
    expect(
      from.getUTCMinutes() + from.getUTCSeconds() + to.getUTCMinutes() + to.getUTCSeconds(),
    ).toBe(0);
  }
  expect(metrics.spend).toBe(50);
  expect(updates).toEqual([
    [
      "campaign-1",
      { totalSpend: "50", totalImpressions: 2000, totalClicks: 80, totalConversions: 0 },
    ],
  ]);
});
