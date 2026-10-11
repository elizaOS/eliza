/** Saves a provider-observed downgrade review without provider mutation or command admission. */

import {
  moneyRateLimit,
  RateLimitPresets,
} from "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare";
import { createOrganizationDowngradeQuote } from "@elizaos/cloud-shared/lib/services/organization-downgrade-preview";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";
import { createOrganizationPlanReviewHandler } from "../../_plan-change-review";

const app = new Hono<AppEnv>();
app.post(
  "/",
  moneyRateLimit(RateLimitPresets.STANDARD),
  createOrganizationPlanReviewHandler(createOrganizationDowngradeQuote),
);
export default app;
