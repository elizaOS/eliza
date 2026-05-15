/**
 * GET /api/v1/pricing/summary
 * Stable public pricing summary for API Explorer and SDK clients.
 */

import { Hono } from "hono";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import {
  IMAGE_GENERATION_COST,
  STT_COST_PER_MINUTE,
  TTS_COST_PER_1K_CHARS,
  VIDEO_GENERATION_COST,
  VIDEO_GENERATION_FALLBACK_COST,
  VOICE_CLONE_INSTANT_COST,
  VOICE_CLONE_PROFESSIONAL_COST,
} from "@/lib/pricing-constants";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.get("/", (c) => {
  c.header("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=7200");
  return c.json({
    asOf: new Date().toISOString(),
    pricing: {
      "generate-image": {
        unit: "image",
        cost: IMAGE_GENERATION_COST,
        description: "Default image generation price per generated image",
      },
      "generate-video": {
        unit: "video",
        isVariable: true,
        estimatedRange: {
          min: VIDEO_GENERATION_FALLBACK_COST,
          max: VIDEO_GENERATION_COST,
        },
        description: "Default video generation price per request",
      },
      "chat-completions": {
        unit: "1k tokens",
        isVariable: true,
        description: "Model-specific token pricing is resolved by the AI pricing catalog",
      },
      "voice-tts": {
        unit: "1k chars",
        cost: TTS_COST_PER_1K_CHARS,
        description: "Default text-to-speech price per 1,000 characters",
      },
      "voice-stt": {
        unit: "minute",
        cost: STT_COST_PER_MINUTE,
        description: "Default speech-to-text price per minute",
      },
      "voice-clone": {
        unit: "clone",
        isVariable: true,
        estimatedRange: {
          min: VOICE_CLONE_INSTANT_COST,
          max: VOICE_CLONE_PROFESSIONAL_COST,
        },
        description: "Default voice cloning pricing by clone tier",
      },
    },
  });
});

export default app;
