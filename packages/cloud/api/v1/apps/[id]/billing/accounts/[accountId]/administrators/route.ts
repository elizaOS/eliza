/** Lists and changes billing administrators for an authenticated purchaser and one billing environment. */

import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import type { Hono } from "hono";
import {
  changeBillingAdministrator,
  getBillingAdministrators,
} from "../../../_administrators";
import { billingRoute } from "../../../_handlers";

const route: Hono<AppEnv> = billingRoute();
route.get("/", getBillingAdministrators);
route.post("/", changeBillingAdministrator);
export default route;
