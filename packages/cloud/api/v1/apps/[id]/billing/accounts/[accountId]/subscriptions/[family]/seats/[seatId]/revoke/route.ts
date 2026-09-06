/** Mounts authorized app subscription revoke records. */
import type { Hono } from "hono";
import type { AppEnv } from "@/types/cloud-worker-env";
import { billingRoute } from "../../../../../../../_handlers";
import { revokeBillingSeat } from "../../../../../../../_records-handlers";

const app: Hono<AppEnv> = billingRoute();
app.post("/", revokeBillingSeat);
export default app;
