/**
 * GET /api/v1/dashboard
 *
 * Aggregated payload for the SPA's dashboard home page
 * (`apps/frontend/src/dashboard/Page.tsx`).
 *
 * Stats are assembled by the dashboard repository so route handlers do not
 * depend on Drizzle table shapes.
 */
import { Hono } from "hono";
import { type DashboardAgent, dashboardRepository } from "@/db/repositories/dashboard";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import type { AppEnv } from "@/types/cloud-worker-env";

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
