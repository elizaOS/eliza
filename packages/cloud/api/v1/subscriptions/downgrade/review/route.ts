/** Saves a provider-observed downgrade review without provider mutation or command admission. */
import { createOrganizationDowngradeQuote } from "@elizaos/cloud-shared/lib/services/organization-downgrade-preview";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";
import { createOrganizationPlanReviewRoute } from "../../_plan-change-review";
export default new Hono<AppEnv>().route(
  "/",
  createOrganizationPlanReviewRoute(createOrganizationDowngradeQuote),
);
