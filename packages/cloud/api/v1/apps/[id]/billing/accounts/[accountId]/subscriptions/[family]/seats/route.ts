/** Mounts authorized app subscription seats records. */

import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import type { Hono } from "hono";
import { billingRoute } from "../../../../../_handlers";
import {
  assignBillingSeat,
  listBillingSeats,
} from "../../../../../_records-handlers";

const app: Hono<AppEnv> = billingRoute();
app.get("/", listBillingSeats);
app.post("/", assignBillingSeat);
export default app;
