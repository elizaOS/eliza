/** Mounts authorized app subscription usage records. */
import type { Hono } from "hono";
import type { AppEnv } from "@/types/cloud-worker-env";
import { billingRoute } from "../../../../../_handlers";
import { listBillingUsage } from "../../../../../_records-handlers";

const app: Hono<AppEnv> = billingRoute();
app.get("/", listBillingUsage);
export default app;
