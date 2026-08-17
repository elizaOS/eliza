/**
 * GET /api/v1/advertising/accounts `platform` is ad-account catalog
 * identity, not leftover tax on advertising campaign list filters
 * (campaigns.platform/status) or promote-assets platform (Twitter card
 * sizes). Stock develop cast unknown tokens as AdPlatform and passed
 * them to listAccounts, so `platform=META` silently returned an empty
 * account catalog.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
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
const listAccounts = mock(async () => []);

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg,
}));
mock.module("@/lib/services/advertising", () => ({
  advertisingService: {
    listAccounts,
  },
}));

const { default: accountsRoute } = await import("./route");

function buildApp() {
  const app = new Hono<AppEnv>();
  app.route("/api/v1/advertising/accounts", accountsRoute);
  return app;
}

function request(query = "") {
  return buildApp().request(`/api/v1/advertising/accounts${query}`);
}

describe("GET /api/v1/advertising/accounts platform identity", () => {
  beforeEach(() => {
    requireUserOrApiKeyWithOrg.mockClear();
    listAccounts.mockClear();
  });

  test.each(["", "?platform="])(
    "accepts %s as an unfiltered ad-account catalog",
    async (query) => {
      const response = await request(query);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { count: number };
      expect(body.count).toBe(0);
      expect(listAccounts).toHaveBeenCalledTimes(1);
      expect(listAccounts).toHaveBeenCalledWith("org-1", undefined);
    },
  );

  test("accepts platform=meta as the Meta ad-account catalog", async () => {
    const response = await request("?platform=meta");
    expect(response.status).toBe(200);
    expect(listAccounts).toHaveBeenCalledTimes(1);
    expect(listAccounts).toHaveBeenCalledWith("org-1", { platform: "meta" });
  });

  test.each(["META", "facebook", "foo", "1e2"])(
    "rejects platform=%s before listAccounts",
    async (token) => {
      const response = await request(`?platform=${token}`);
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("invalid_platform");
      expect(listAccounts).not.toHaveBeenCalled();
    },
  );
});
