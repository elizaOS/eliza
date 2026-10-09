/** Signed read-only reconciliation uses the original delivery owner and fingerprint. */
import { Hono } from "hono";
import type { AppEnv } from "@/types/cloud-worker-env";
import { handleNetworkDelivery } from "../route";

const app = new Hono<AppEnv>();
app.post("/", (c) => handleNetworkDelivery(c, true));
export default app;
