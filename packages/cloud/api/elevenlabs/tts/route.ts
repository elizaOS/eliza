/**
 * /api/elevenlabs/tts — alias for POST /api/v1/voice/tts.
 */

import { forwardSameOriginRequest } from "@elizaos/cloud-shared/lib/http/same-origin-forward";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

const app = new Hono<AppEnv>();

app.post("/", (c) => forwardSameOriginRequest(c, "/api/v1/voice/tts"));

export default app;
