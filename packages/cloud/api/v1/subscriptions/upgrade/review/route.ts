/** Saves a provider-observed upgrade review without provider mutation or command admission. */
import { createOrganizationUpgradeQuote } from "@elizaos/cloud-shared/lib/services/organization-upgrade-preview";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";
import { createOrganizationPlanReviewRoute } from "../../_plan-change-review";
export default new Hono<AppEnv>().route(
  "/",
  createOrganizationPlanReviewRoute(createOrganizationUpgradeQuote),
);
