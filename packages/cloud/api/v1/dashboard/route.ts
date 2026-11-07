/**
 * GET /api/v1/dashboard
 *
 * Aggregated payload for the SPA's dashboard home page
 * (`packages/ui/src/cloud/home/DashboardHomePage.tsx`).
 *
 * Stats are assembled by the dashboard repository so route handlers do not
 * depend on Drizzle table shapes.
 */

import { requireUserOrApiKeyWithOrg } from "@elizaos/cloud-shared/auth";
import {
  type DashboardAgent,
  dashboardRepository,
} from "@elizaos/cloud-shared/db/repositories/dashboard";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import {
  RateLimitPresets,
  rateLimit,
} from "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

interface DashboardResponse {
  success: true;
  user: { name: string };
  agents: DashboardAgent[];
}

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.get("/", async (c) => {
  try {
    const authed = await requireUserOrApiKeyWithOrg(c);
    const dashboard = await dashboardRepository.getSummaryForUser(authed.id);

    const body: DashboardResponse = {
      success: true,
      user: dashboard.user,
      agents: dashboard.agents,
    };

    return c.json(body);
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
