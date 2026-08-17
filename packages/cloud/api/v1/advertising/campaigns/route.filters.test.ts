/**
 * GET /api/v1/advertising/campaigns `platform` / `status` are ad-campaign
 * catalog identity, not leftover tax on promote-assets platform (Twitter
 * card sizes) or admin redemption status. Stock develop cast unknown
 * tokens as AdPlatform / status and passed them to listCampaigns, so
 * `platform=META` / `status=ACTIVE` silently returned an empty catalog.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import {
  AdPlatformSchema,
  CampaignStatusSchema,
} from "@/lib/services/advertising/schemas";
import type { AppEnv } from "@/types/cloud-worker-env";

mock.module("@/lib/api/cloud-worker-errors", () => ({
  failureResponse: (_c: unknown, err: unknown) => {
    throw err;
  },
}));
mock.module("@/lib/utils/logger", () => ({
  logger: { info: mock(() => undefined), error: mock(() => undefined) },
}));

const requireUserOrApiKeyWithOrg = mock(async () => ({
  id: "user-1",
  organization_id: "org-1",
}));
const listCampaigns = mock(async () => []);

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg,
}));
mock.module("@/lib/services/advertising", () => ({
  advertisingService: {
    listCampaigns,
  },
}));

const { default: campaignsRoute } = await import("./route");

function buildApp() {
  const app = new Hono<AppEnv>();
  app.route("/api/v1/advertising/campaigns", campaignsRoute);
  return app;
}

function request(query = "") {
  return buildApp().request(`/api/v1/advertising/campaigns${query}`);
}

describe("GET /api/v1/advertising/campaigns list-filter identity", () => {
  beforeEach(() => {
    requireUserOrApiKeyWithOrg.mockClear();
    listCampaigns.mockClear();
  });

  test.each(["", "?platform=", "?status=", "?platform=&status="])(
    "accepts %s as an unfiltered campaign catalog",
    async (query) => {
      const response = await request(query);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { count: number };
      expect(body.count).toBe(0);
      expect(listCampaigns).toHaveBeenCalledTimes(1);
      expect(listCampaigns).toHaveBeenCalledWith("org-1", {
        adAccountId: undefined,
        platform: undefined,
        status: undefined,
        appId: undefined,
      });
    },
  );

  test.each([...AdPlatformSchema.options])(
    "accepts platform=%s as a campaign catalog",
    async (platform) => {
      const response = await request(`?platform=${platform}`);
      expect(response.status).toBe(200);
      expect(listCampaigns).toHaveBeenCalledTimes(1);
      expect(listCampaigns).toHaveBeenCalledWith(
        "org-1",
        expect.objectContaining({ platform }),
      );
    },
  );

  test.each([...CampaignStatusSchema.options])(
    "accepts status=%s as a campaign catalog",
    async (status) => {
      const response = await request(`?status=${status}`);
      expect(response.status).toBe(200);
      expect(listCampaigns).toHaveBeenCalledTimes(1);
      expect(listCampaigns).toHaveBeenCalledWith(
        "org-1",
        expect.objectContaining({ status }),
      );
    },
  );

  test.each(["META", "facebook", "foo", "1e2"])(
    "rejects platform=%s before listCampaigns",
    async (token) => {
      const response = await request(`?platform=${token}`);
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("invalid_platform");
      expect(listCampaigns).not.toHaveBeenCalled();
    },
  );

  test.each(["ACTIVE", "running", "foo", "1e2"])(
    "rejects status=%s before listCampaigns",
    async (token) => {
      const response = await request(`?status=${token}`);
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("invalid_status");
      expect(listCampaigns).not.toHaveBeenCalled();
    },
  );
});
