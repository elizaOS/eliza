/** Synchronizes one accepted app member and their environment-specific seats atomically. */
import type { Hono } from "hono";
import type { AppEnv } from "@/types/cloud-worker-env";
import { billingRoute } from "../../../../_handlers";
import { synchronizeBillingMember } from "../../../../_memberships";

const route: Hono<AppEnv> = billingRoute();
route.post("/", synchronizeBillingMember);
export default route;
