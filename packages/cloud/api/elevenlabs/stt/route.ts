/**
 * /api/elevenlabs/stt — alias for POST /api/v1/voice/stt.
 */

import { forwardSameOriginRequest } from "@elizaos/cloud-shared/lib/http/same-origin-forward";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

const app = new Hono<AppEnv>();

app.post("/", (c) => forwardSameOriginRequest(c, "/api/v1/voice/stt"));

export default app;
