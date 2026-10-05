/** Saves a provider-observed downgrade review without provider mutation or command admission. */
import { createOrganizationDowngradeQuote } from "@elizaos/cloud-shared/lib/services/organization-downgrade-preview";
import { Hono } from "hono";
import { createOrganizationPlanReviewRoute } from "../../_plan-change-review";
export default new Hono().route(
  "/",
  createOrganizationPlanReviewRoute(createOrganizationDowngradeQuote),
);
