import { Hono } from "hono";

import type { AppEnv } from "@/types/cloud-worker-env";

const body = JSON.stringify({
  error: "SSE streaming is no longer supported. Use streamable-http transport.",
});

const app = new Hono<AppEnv>();

app.get(
  "/",
  () => new Response(body, { status: 410, headers: { "Content-Type": "application/json" } }),
);

app.post(
  "/",
  () => new Response(body, { status: 410, headers: { "Content-Type": "application/json" } }),
);

export default app;
