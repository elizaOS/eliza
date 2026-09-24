/** Lists app-scoped members for the authenticated backend in its registered billing environment. */
import type { Hono } from "hono";
import type { AppEnv } from "@/types/cloud-worker-env";
import { billingRoute } from "../../../_handlers";
import { getBillingMembers } from "../../../_memberships";

const route: Hono<AppEnv> = billingRoute();
route.get("/", getBillingMembers);
export default route;
