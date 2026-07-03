/**
 * Route-level coverage for first-party advertising conversion attribution (#11598).
 *
 * Drives the real Hono route handlers while mocking only auth/rate-limit and
 * the shared service boundary. This pins the public pixel/webhook contract and
 * the authenticated install payload shape consumed by SDK/agent actions.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import * as workersHonoAuthActual from "@/lib/auth/workers-hono-auth";

const CAMPAIGN_ID = "00000000-0000-4000-8000-00000000ad01";
const ORG_ID = "00000000-0000-4000-8000-0000000000aa";
const APP_ID = "00000000-0000-4000-8000-0000000000bb";

const requireUserOrApiKeyWithOrg = mock();
mock.module("@/lib/auth/workers-hono-auth", () => ({
  ...workersHonoAuthActual,
  requireUserOrApiKeyWithOrg,
}));

mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  getIpKey: () => "ip:test",
  RateLimitPresets: { STRICT: {} },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

const getAttributionToken = mock();
const createAttributionLink = mock();
const recordConversion = mock();
mock.module("@/lib/services/advertising", () => ({
  advertisingService: {
    getAttributionToken,
    createAttributionLink,
    recordConversion,
  },
}));

mock.module("@/lib/utils/logger", () => ({
  logger: { error: mock(), info: mock(), warn: mock(), debug: mock() },
}));

const { default: attributionRoute } = await import(
  "../v1/advertising/campaigns/[id]/attribution/route"
);
const { default: trackRoute } = await import(
  "../v1/advertising/conversions/track/route"
);

const app = new Hono();
app.route("/api/v1/advertising/campaigns/:id/attribution", attributionRoute);
app.route("/api/v1/advertising/conversions/track", trackRoute);

interface AttributionInstallResponse {
  success: boolean;
  campaignId: string;
  appId: string;
  token: string;
  pixelEndpoint: string;
  webhookEndpoint: string;
  install: {
    pixelHtml: string;
    webhook: {
      body: Record<string, unknown>;
    };
  };
}

beforeEach(() => {
  requireUserOrApiKeyWithOrg.mockReset();
  getAttributionToken.mockReset();
  createAttributionLink.mockReset();
  recordConversion.mockReset();
});

describe("advertising attribution install route", () => {
  test("returns signed pixel and webhook instructions for the caller org", async () => {
    requireUserOrApiKeyWithOrg.mockResolvedValue({ organization_id: ORG_ID });
    getAttributionToken.mockResolvedValue({
      campaignId: CAMPAIGN_ID,
      appId: APP_ID,
      token: "payloadpart.signaturepart123456789",
    });

    const res = await app.request(
      `https://cloud.test/api/v1/advertising/campaigns/${CAMPAIGN_ID}/attribution`,
    );
    const body = (await res.json()) as AttributionInstallResponse;

    expect(res.status).toBe(200);
    expect(getAttributionToken).toHaveBeenCalledWith(CAMPAIGN_ID, ORG_ID);
    expect(body).toMatchObject({
      success: true,
      campaignId: CAMPAIGN_ID,
      appId: APP_ID,
      token: "payloadpart.signaturepart123456789",
      webhookEndpoint:
        "https://cloud.test/api/v1/advertising/conversions/track",
    });
    expect(body.pixelEndpoint).toContain(
      "token=payloadpart.signaturepart123456789",
    );
    expect(body.install.pixelHtml).toContain("dedupeKey=ORDER_OR_EVENT_ID");
    expect(body.install.webhook.body).toMatchObject({
      token: "payloadpart.signaturepart123456789",
      eventType: "purchase",
      dedupeKey: "ORDER_OR_EVENT_ID",
    });
  });

  test("creates deterministic UTM links for the caller org", async () => {
    requireUserOrApiKeyWithOrg.mockResolvedValue({ organization_id: ORG_ID });
    createAttributionLink.mockResolvedValue({
      id: "link_1",
      campaignId: CAMPAIGN_ID,
      destinationUrl: "https://app.test/install",
      utmUrl:
        "https://app.test/install?utm_source=meta&utm_medium=paid&utm_campaign=launch",
      utm: {
        source: "meta",
        medium: "paid",
        campaign: "launch",
      },
    });

    const res = await app.request(
      `https://cloud.test/api/v1/advertising/campaigns/${CAMPAIGN_ID}/attribution`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          destinationUrl: "https://app.test/install",
          source: "meta",
        }),
      },
    );
    const body = (await res.json()) as {
      link: { id: string; utmUrl: string };
    };

    expect(res.status).toBe(201);
    expect(body.link.utmUrl).toContain("utm_source=meta");
    expect(createAttributionLink).toHaveBeenCalledWith({
      campaignId: CAMPAIGN_ID,
      organizationId: ORG_ID,
      destinationUrl: "https://app.test/install",
      creativeId: undefined,
      source: "meta",
      medium: undefined,
      content: undefined,
      term: undefined,
    });
  });
});

describe("advertising conversion tracking route", () => {
  test("records a public pixel GET and returns no content", async () => {
    recordConversion.mockResolvedValue({
      inserted: true,
      eventId: "event_1",
      campaignId: CAMPAIGN_ID,
    });

    const res = await app.request(
      "https://cloud.test/api/v1/advertising/conversions/track?token=payloadpart.signaturepart123456789&eventType=purchase&dedupeKey=order-1&value=12.34&utm_source=meta",
      {
        headers: {
          "user-agent": "test-agent",
          referer: "https://app.test/thanks",
        },
      },
    );

    expect(res.status).toBe(204);
    expect(recordConversion).toHaveBeenCalledWith(
      expect.objectContaining({
        token: "payloadpart.signaturepart123456789",
        eventType: "purchase",
        dedupeKey: "order-1",
        value: 12.34,
        currency: "USD",
        referrer: "https://app.test/thanks",
        userAgent: "test-agent",
        metadata: { utmSource: "meta" },
      }),
    );
  });

  test("records a public webhook POST and surfaces dedupe", async () => {
    recordConversion.mockResolvedValue({
      inserted: false,
      eventId: "event_1",
      campaignId: CAMPAIGN_ID,
    });

    const res = await app.request(
      "https://cloud.test/api/v1/advertising/conversions/track",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token: "payloadpart.signaturepart123456789",
          eventType: "purchase",
          dedupeKey: "order-1",
          value: 12.34,
          currency: "USD",
        }),
      },
    );
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      inserted: false,
      eventId: "event_1",
      campaignId: CAMPAIGN_ID,
    });
  });

  test("rejects invalid signed tokens before returning success", async () => {
    recordConversion.mockRejectedValue(new Error("Invalid attribution token"));

    const res = await app.request(
      "https://cloud.test/api/v1/advertising/conversions/track",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token: "badpayload.signaturepart123456789",
          eventType: "purchase",
          dedupeKey: "order-2",
        }),
      },
    );

    expect(res.status).toBe(403);
  });
});
