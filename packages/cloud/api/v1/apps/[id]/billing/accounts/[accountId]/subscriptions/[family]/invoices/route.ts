/** Mounts authorized app subscription invoices records. */
import type { Hono } from "hono";
import type { AppEnv } from "@/types/cloud-worker-env";
import { billingRoute } from "../../../../../_handlers";
import { listBillingInvoices } from "../../../../../_records-handlers";

const app: Hono<AppEnv> = billingRoute();
app.get("/", listBillingInvoices);
export default app;
