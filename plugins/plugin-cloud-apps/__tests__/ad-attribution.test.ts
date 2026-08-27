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

describe("handler — no key path", () => {
  beforeEach(() => resetSdk());

  it("fails closed and never reaches the SDK without a Cloud API key", async () => {
    const cb = captureCallback();
    const res = await getAdCampaignAttributionAction.handler(
      unkeyedRuntime(),
      makeMessage("get the conversion pixel"),
      undefined,
      { campaignId: "camp_1" },
      cb.fn,
    );

    expect(res.success).toBe(false);
    expect(res.data).toMatchObject({ reason: "no_key" });
    expect(cb.calls[0]?.text).toContain("no Cloud API key is configured");
  });
});

describe("handler — campaign id extraction", () => {
  beforeEach(() => resetSdk());

  function attributionResolving(captured: { value: string | null }) {
    setGetAdCampaignAttribution((campaignId) => {
      captured.value = campaignId;
      return Promise.resolve({
        success: true,
        campaignId,
        webhookEndpoint: "https://cloud.test/webhook/x",
      });
    });
  }

  it("accepts campaign_id aliases and nested parameters", async () => {
    const captured: { value: string | null } = { value: null };
    attributionResolving(captured);
    const cb = captureCallback();
    await getAdCampaignAttributionAction.handler(
      keyedRuntime(),
      makeMessage("get attribution"),
      undefined,
      { parameters: { campaign_id: "camp_456" } },
      cb.fn,
    );
    expect(captured.value).toBe("camp_456");
  });

  it("falls back to campaignId on the message content", async () => {
    const captured: { value: string | null } = { value: null };
    attributionResolving(captured);
    const cb = captureCallback();
    await getAdCampaignAttributionAction.handler(
      keyedRuntime(),
      { content: { campaignId: "camp_789" } } as never,
      undefined,
      {},
      cb.fn,
    );
    expect(captured.value).toBe("camp_789");
  });

  it("trims whitespace around the campaign id", async () => {
    const captured: { value: string | null } = { value: null };
    attributionResolving(captured);
    const cb = captureCallback();
    await getAdCampaignAttributionAction.handler(
      keyedRuntime(),
      makeMessage("get attribution"),
      undefined,
      { campaignId: "  camp_000  " },
      cb.fn,
    );
    expect(captured.value).toBe("camp_000");
  });

  it("fails closed for whitespace-only, non-string, and malformed options", async () => {
    const cases = [
      { campaignId: "   " },
      { campaignId: 12345 },
      "camp_11",
    ] as const;
    for (const options of cases) {
      const captured: { value: string | null } = { value: null };
      attributionResolving(captured);
      const cb = captureCallback();
      const res = await getAdCampaignAttributionAction.handler(
        keyedRuntime(),
        makeMessage("get attribution"),
        undefined,
        options as never,
        cb.fn,
      );
      expect(res.success).toBe(false);
      expect(res.data).toMatchObject({ reason: "no_campaign_id" });
      expect(cb.calls[0]?.text).toContain("Which campaign");
      expect(captured.value).toBeNull();
    }
  });
});

describe("handler — API error path", () => {
  beforeEach(() => resetSdk());

  it("degrades gracefully and warns when the Cloud API fails", async () => {
    setGetAdCampaignAttribution(() =>
      Promise.reject(new Error("upstream 502")),
    );
    const cb = captureCallback();
    const res = await getAdCampaignAttributionAction.handler(
      keyedRuntime(),
      makeMessage("get attribution"),
      undefined,
      { campaignId: "camp_12" },
      cb.fn,
    );

    expect(res.success).toBe(false);
    expect(res.data).toMatchObject({ reason: "error" });
    expect(res.error).toBeInstanceOf(Error);
    expect(cb.calls[0]?.text).toContain("returned an error");
  });
});
