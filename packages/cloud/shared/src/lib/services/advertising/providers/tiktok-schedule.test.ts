import { afterEach, expect, spyOn, test } from "bun:test";
import type { CreateCreativeInput } from "../types";
import { tiktokAdsProvider } from "./tiktok";

const spies: ReturnType<typeof spyOn>[] = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

function captureTikTokRequests(): Array<{ path: string; body: Record<string, unknown> }> {
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  spies.push(
    spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const path = new URL(String(url)).pathname;
      requests.push({ path, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      const data = path.endsWith("/adgroup/create/") ? { adgroup_id: "ag-1" } : { ad_id: "ad-1" };
      return Response.json({ code: 0, message: "OK", request_id: "r1", data });
    }),
  );
  return requests;
}

const creativeInput: CreateCreativeInput = {
  campaignId: "campaign-1",
  name: "Launch video",
  type: "video",
  destinationUrl: "https://example.com/launch",
  media: [{ type: "video", url: "https://cdn.example.com/launch.mp4", providerAssetId: "v-1" }],
};

test("ad group carries the campaign start and end as a bounded schedule", async () => {
  const requests = captureTikTokRequests();

  const result = await tiktokAdsProvider.createCreative(
    { accessToken: "fixture-token" },
    "adv-1",
    "adv-1/c1",
    {
      ...creativeInput,
      campaignStartDate: new Date("2099-11-01T00:00:00.000Z"),
      campaignEndDate: new Date("2099-11-08T00:00:00.000Z"),
    },
  );

  expect(result).toEqual({ success: true, externalCreativeId: "ad-1" });
  const adGroup = requests.find((request) => request.path.endsWith("/adgroup/create/"))?.body;
  expect(adGroup).toMatchObject({
    campaign_id: "c1",
    schedule_type: "SCHEDULE_START_END",
    schedule_start_time: "2099-11-01 00:00:00",
    schedule_end_time: "2099-11-08 00:00:00",
  });
});

test("ad group of an open-ended campaign is scheduled from now without an end time", async () => {
  const requests = captureTikTokRequests();
  const before = Date.now();

  await tiktokAdsProvider.createCreative({ accessToken: "fixture-token" }, "adv-1", "adv-1/c1", {
    ...creativeInput,
    campaignStartDate: new Date("2020-01-01T00:00:00.000Z"),
  });

  const adGroup = requests.find((request) => request.path.endsWith("/adgroup/create/"))?.body;
  expect(adGroup?.schedule_type).toBe("SCHEDULE_FROM_NOW");
  expect(adGroup).not.toHaveProperty("schedule_end_time");
  const start = Date.parse(`${String(adGroup?.schedule_start_time).replace(" ", "T")}Z`);
  expect(start).toBeGreaterThanOrEqual(Math.floor(before / 1000) * 1000);
});

test("updateCampaign refuses a date change it cannot push to TikTok", async () => {
  const requests = captureTikTokRequests();

  const result = await tiktokAdsProvider.updateCampaign(
    { accessToken: "fixture-token" },
    "adv-1/c1",
    { endDate: new Date("2099-11-08T00:00:00.000Z") },
  );

  expect(result.success).toBe(false);
  expect(result.error).toMatch(/ad group/);
  expect(requests).toEqual([]);
});

test("a creative for a campaign whose end date has passed is refused before any request", async () => {
  const requests = captureTikTokRequests();

  const result = await tiktokAdsProvider.createCreative(
    { accessToken: "fixture-token" },
    "adv-1",
    "adv-1/c1",
    {
      ...creativeInput,
      campaignStartDate: new Date("2020-01-01T00:00:00.000Z"),
      campaignEndDate: new Date("2020-02-01T00:00:00.000Z"),
    },
  );

  expect(result.success).toBe(false);
  expect(result.error).toContain("end date has passed");
  expect(requests).toEqual([]);
});

test("an update that bundles dates with a name and budget changes nothing at TikTok", async () => {
  const requests = captureTikTokRequests();

  const result = await tiktokAdsProvider.updateCampaign(
    { accessToken: "fixture-token" },
    "adv-1/c1",
    {
      name: "Renamed",
      budgetAmount: 75,
      endDate: new Date("2099-12-31T00:00:00.000Z"),
    },
  );

  // The service writes the local row only after provider success, so a whole
  // refusal keeps the stored campaign and TikTok in step.
  expect(result.success).toBe(false);
  expect(requests).toEqual([]);
});
