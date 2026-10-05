/** Saves a provider-observed upgrade review without provider mutation or command admission. */
import { createOrganizationUpgradeQuote } from "@elizaos/cloud-shared/lib/services/organization-upgrade-preview";
import { Hono } from "hono";
import { createOrganizationPlanReviewRoute } from "../../_plan-change-review";
export default new Hono().route(
  "/",
  createOrganizationPlanReviewRoute(createOrganizationUpgradeQuote),
);
