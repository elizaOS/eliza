/** Mounts authorized app subscription invoices records. */

import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import type { Hono } from "hono";
import { billingRoute } from "../../../../../_handlers";
import { listBillingInvoices } from "../../../../../_records-handlers";

const app: Hono<AppEnv> = billingRoute();
app.get("/", listBillingInvoices);
export default app;
