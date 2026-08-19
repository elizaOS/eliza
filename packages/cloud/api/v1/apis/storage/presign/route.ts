/**
 * Default-denies storage presigning until native capability authority, durable
 * paid-request receipts, and signed-URL telemetry policy are implemented.
 */

import { Hono } from "hono";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  await requireUserOrApiKeyWithOrg(c);
  return c.json(
    {
      error:
        "Storage presigning is unavailable until native signed-read billing authority is enabled",
    },
    503,
  );
});

export default app;
