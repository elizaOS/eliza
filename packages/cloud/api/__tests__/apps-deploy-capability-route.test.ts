/**
 * Exercises authenticated container-capability discovery against the real Hono
 * route while replacing only the identity boundary.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import * as workersHonoAuthActual from "@/lib/auth/workers-hono-auth";

const requireUserOrApiKeyWithOrg = mock();
mock.module("@/lib/auth/workers-hono-auth", () => ({
  ...workersHonoAuthActual,
  requireUserOrApiKeyWithOrg,
}));

mock.module("@/lib/utils/logger", () => ({
  logger: { error: mock(), info: mock(), warn: mock(), debug: mock() },
}));

const { default: route } = await import("../v1/apps/deploy-capability/route");

const app = new Hono();
app.route("/api/v1/apps/deploy-capability", route);

beforeEach(() => {
  requireUserOrApiKeyWithOrg.mockReset();
  requireUserOrApiKeyWithOrg.mockResolvedValue({
    organization_id: "org-allowed",
  });
});

describe("GET /api/v1/apps/deploy-capability", () => {
  test("combines the global and organization gates", async () => {
    const response = await app.request(
      "/api/v1/apps/deploy-capability",
      undefined,
      {
        APPS_DEPLOY_ENABLED: "1",
        ENVIRONMENT: "production",
        APPS_DEPLOY_ALLOWED_ORG_IDS: "org-allowed",
      },
    );

    const body = (await response.json()) as {
      enabled: boolean;
      reason?: string;
    };
    expect(response.status).toBe(200);
    expect(body).toEqual({ enabled: true });
  });

  test("reports an allowlist denial without exposing the allowlist", async () => {
    requireUserOrApiKeyWithOrg.mockResolvedValue({
      organization_id: "org-denied",
    });
    const response = await app.request(
      "/api/v1/apps/deploy-capability",
      undefined,
      {
        APPS_DEPLOY_ENABLED: "1",
        ENVIRONMENT: "production",
        APPS_DEPLOY_ALLOWED_ORG_IDS: "org-allowed",
      },
    );

    const body = (await response.json()) as {
      enabled: boolean;
      reason?: string;
    };
    expect(response.status).toBe(200);
    expect(body).toEqual({
      enabled: false,
      reason: "organization_not_allowlisted",
    });
  });
});
