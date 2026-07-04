/**
 * GET_AD_CAMPAIGN_ATTRIBUTION action tests: campaign attribution reporting. The @elizaos/cloud-sdk client is faked (helpers.ts, SDK boundary only); the action runs for real.
 */
import { beforeEach, describe, expect, it, mock } from "bun:test";
import {
  captureCallback,
  FakeElizaCloudClient,
  keyedRuntime,
  makeMessage,
  resetSdk,
  setGetAdCampaignAttribution,
  unkeyedRuntime,
} from "./helpers";

mock.module("@elizaos/cloud-sdk", () => ({
  ElizaCloudClient: FakeElizaCloudClient,
}));

const { getAdCampaignAttributionAction } = await import(
  "../src/actions/ad-attribution.ts"
);

describe("GET_AD_CAMPAIGN_ATTRIBUTION", () => {
  beforeEach(() => resetSdk());

  it("validate: true with key, false without", async () => {
    expect(
      await getAdCampaignAttributionAction.validate(
        keyedRuntime(),
        makeMessage("x"),
      ),
    ).toBe(true);
    expect(
      await getAdCampaignAttributionAction.validate(
        unkeyedRuntime(),
        makeMessage("x"),
      ),
    ).toBe(false);
  });

  it("requires a campaign id", async () => {
    const cb = captureCallback();
    const res = await getAdCampaignAttributionAction.handler(
      keyedRuntime(),
      makeMessage("get the conversion pixel"),
      undefined,
      {},
      cb.fn,
    );

    expect(res.success).toBe(false);
    expect(res.data).toMatchObject({ reason: "no_campaign_id" });
    expect(cb.calls[0]?.text).toContain("Which campaign");
  });

  it("returns pixel and webhook install instructions", async () => {
    let capturedCampaignId: string | null = null;
    setGetAdCampaignAttribution((campaignId) => {
      capturedCampaignId = campaignId;
      return Promise.resolve({
        success: true,
        campaignId,
        appId: "app_1",
        token: "payloadpart.signaturepart123456789",
        pixelEndpoint:
          "https://cloud.test/api/v1/advertising/conversions/track?token=payloadpart.signaturepart123456789",
        webhookEndpoint:
          "https://cloud.test/api/v1/advertising/conversions/track",
        install: {
          pixelHtml:
            '<img src="https://cloud.test/api/v1/advertising/conversions/track?token=payloadpart.signaturepart123456789&eventType=conversion&dedupeKey=ORDER_OR_EVENT_ID" />',
          webhook: {
            url: "https://cloud.test/api/v1/advertising/conversions/track",
            method: "POST",
            body: {
              token: "payloadpart.signaturepart123456789",
              eventType: "purchase",
              dedupeKey: "ORDER_OR_EVENT_ID",
            },
          },
        },
      });
    });
    const cb = captureCallback();
    const res = await getAdCampaignAttributionAction.handler(
      keyedRuntime(),
      makeMessage("get attribution"),
      undefined,
      { campaignId: "camp_123" },
      cb.fn,
    );

    expect(res.success).toBe(true);
    expect(capturedCampaignId).toBe("camp_123");
    expect(res.userFacingText).toContain("kept out of connector chat");
    expect(res.userFacingText).toContain("Webhook: POST");
    expect(res.userFacingText).not.toContain("payloadpart");
    expect(res.userFacingText).not.toContain("<img");
    expect(cb.calls[0]?.text).not.toContain("payloadpart");
    expect(res.data).toMatchObject({
      attribution: {
        campaignId: "camp_123",
        token: "payloadpart.signaturepart123456789",
      },
    });
  });
});
