/** Lists app-scoped members for the authenticated backend in its registered billing environment. */

import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import type { Hono } from "hono";
import { billingRoute } from "../../../_handlers";
import { getBillingMembers } from "../../../_memberships";

const route: Hono<AppEnv> = billingRoute();
route.get("/", getBillingMembers);
export default route;
