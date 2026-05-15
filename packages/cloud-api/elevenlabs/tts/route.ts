/**
 * /api/elevenlabs/tts — alias for POST /api/v1/voice/tts.
 */

import { Hono } from "hono";

import { forwardSameOriginRequest } from "@/lib/worker/same-origin-forward";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.post("/", (c) => forwardSameOriginRequest(c, "/api/v1/voice/tts"));

export default app;
