import { Hono } from "hono";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { getElevenLabsService } from "@/lib/services/elevenlabs";
import { voiceCloningService } from "@/lib/services/voice-cloning";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

/**
 * GET /api/elevenlabs/voices/verify/[id]
 * Verifies if a voice is ready to use in ElevenLabs by checking its status and testing TTS generation.
 * Useful for professional voices that may still be processing or fine-tuning.
 *
 * @param request - The Next.js request object.
 * @param context - Route context containing the voice ID parameter.
 * @returns Voice verification status including readiness, TTS capability, and fine-tuning information.
 */
async function __hono_GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);
    const params = await context.params;
    const voiceId = params.id;

    logger.info(`[Voice Verify API] Verifying voice ${voiceId}`);

    // Get voice from database
    const voice = await voiceCloningService.getVoiceById(voiceId, user.organization_id!);

    if (!voice) {
      return Response.json({ error: "Voice not found" }, { status: 404 });
    }

    // Check status in ElevenLabs
    const elevenlabs = getElevenLabsService();

    try {
      const elevenLabsVoice = await elevenlabs.getVoiceById(voice.elevenlabsVoiceId);

      // For professional voices, check fine-tuning status
      const isProfessional = voice.cloneType === "professional";
      const isReady = isProfessional
        ? elevenLabsVoice.fineTuning?.state &&
          Object.keys(elevenLabsVoice.fineTuning.state).length > 0
        : true; // Instant voices are ready immediately

      // Try a test TTS call to verify it actually works
      let canGenerateTTS = false;
      try {
        await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice.elevenlabsVoiceId}`, {
          method: "POST",
          headers: {
            "xi-api-key": process.env.ELEVENLABS_API_KEY!,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            text: "Test",
            model_id: "eleven_multilingual_v2",
          }),
        });
        canGenerateTTS = true;
      } catch {
        canGenerateTTS = false;
      }

      return Response.json({
        success: true,
        voice: {
          id: voice.id,
          name: voice.name,
          elevenlabsVoiceId: voice.elevenlabsVoiceId,
          cloneType: voice.cloneType,
        },
        status: {
          isReady: isReady && canGenerateTTS,
          canGenerateTTS,
          category: elevenLabsVoice.category,
          sampleCount: elevenLabsVoice.samples?.length || 0,
          fineTuningStatus: isProfessional ? elevenLabsVoice.fineTuning : null,
          message: !canGenerateTTS
            ? "Voice is still being processed. Please wait."
            : isReady
              ? "Voice is ready to use"
              : "Voice is not yet fine-tuned",
        },
      });
    } catch (error) {
      logger.error(`[Voice Verify API] ElevenLabs error:`, error);

      return Response.json({
        success: true,
        voice: {
          id: voice.id,
          name: voice.name,
        },
        status: {
          isReady: false,
          canGenerateTTS: false,
          message: "Voice not found in ElevenLabs or still processing",
        },
      });
    }
  } catch (error) {
    logger.error("[Voice Verify API] Error:", error);

    return Response.json({ error: "Failed to verify voice status" }, { status: 500 });
  }
}

const __hono_app = new Hono<AppEnv>();
__hono_app.get("/", async (c) =>
  __hono_GET(c.req.raw, { params: Promise.resolve({ id: c.req.param("id")! }) }),
);
export default __hono_app;
