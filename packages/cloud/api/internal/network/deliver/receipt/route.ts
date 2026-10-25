/** Signed read-only reconciliation uses the original delivery owner and fingerprint. */

import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";
import { handleNetworkDelivery } from "../route";

const app = new Hono<AppEnv>();
app.post("/", (c) => handleNetworkDelivery(c, true));
export default app;
