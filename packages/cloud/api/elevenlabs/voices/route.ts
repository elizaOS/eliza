/**
 * GET /api/elevenlabs/voices
 * Lists ElevenLabs public/premade voices.
 */

import { requireUser } from "@elizaos/cloud-shared/auth";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import { getElevenLabsService } from "@elizaos/cloud-shared/lib/services/elevenlabs";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const user = await requireUser(c);
    logger.info(`[Voices API] Fetching public voices for user ${user.id}`);

    const elevenlabs = getElevenLabsService();
    const allVoices = await elevenlabs.getVoices();
    const publicVoices = allVoices.filter(
      (voice) =>
        voice.category === "premade" || voice.category === "professional",
    );

    return c.json({ voices: publicVoices });
  } catch (error) {
    logger.error("[Voices API] Error:", error);
    if (
      error instanceof Error &&
      error.message.includes("ELEVENLABS_API_KEY")
    ) {
      return c.json({ error: "Service not configured" }, 500);
    }
    return failureResponse(c, error);
  }
});

export default app;
