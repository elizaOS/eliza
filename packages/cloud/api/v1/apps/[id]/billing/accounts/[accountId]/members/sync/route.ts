/** Synchronizes one accepted app member and their environment-specific seats atomically. */

import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import type { Hono } from "hono";
import { billingRoute } from "../../../../_handlers";
import { synchronizeBillingMember } from "../../../../_memberships";

const route: Hono<AppEnv> = billingRoute();
route.post("/", synchronizeBillingMember);
export default route;
