/**
 * /api/v1/connections/[platform] — generic dispatcher to per-platform connect/
 * disconnect handlers. Currently supports `twilio` and `blooio`.
 *
 * The per-platform handlers (`api/v1/{twilio,blooio}/{connect,disconnect}/route.ts`)
 * still ship as Next.js routes and have not been ported to Hono yet, so this
 * dispatcher returns 501 until they are. The Hono codegen will mount this
 * stub; once the siblings are ported, restore the original delegation.
 */

import { Hono } from "hono";

import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

const NOT_IMPLEMENTED = {
  success: false,
  error:
    "Connections dispatcher pending Hono port of underlying twilio/blooio routes. Call the per-platform endpoints directly.",
} as const;

app.all("/", (c) => c.json(NOT_IMPLEMENTED, 501));

export default app;
