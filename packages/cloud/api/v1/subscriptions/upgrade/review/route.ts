/** Saves a provider-observed upgrade review without provider mutation or command admission. */

import {
  moneyRateLimit,
  RateLimitPresets,
} from "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare";
import { createOrganizationUpgradeQuote } from "@elizaos/cloud-shared/lib/services/organization-upgrade-preview";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";
import { createOrganizationPlanReviewHandler } from "../../_plan-change-review";

const app = new Hono<AppEnv>();
app.post(
  "/",
  moneyRateLimit(RateLimitPresets.STANDARD),
  createOrganizationPlanReviewHandler(createOrganizationUpgradeQuote),
);
export default app;
