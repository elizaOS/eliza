// Handles cloud API elevenlabs voices verify id route traffic with route-local auth expectations.
//
// Verification reports whether a cloned voice is usable. It distinguishes THREE
// outcomes so callers never conflate "voice legitimately not ready yet" with
// "ElevenLabs is broken" (#12787 / #12182):
//   - voice missing FROM ElevenLabs (upstream 404) => a real "still processing /
//     not found" verdict (J4 degrade), because a just-created professional voice
//     is genuinely absent until fine-tuning materializes it.
//   - ElevenLabs transport / 5xx / auth failure => surfaced as a route failure
//     (J1), NOT a fabricated `success:true, isReady:false` body. The old handler
//     swallowed EVERY upstream error into a 200 "still processing" verdict, so a
//     dead ElevenLabs looked identical to a voice mid-bake — the client would
//     poll forever against a broken service believing the voice just wasn't done.
//   - the TTS smoke call is a best-effort readiness probe: its result feeds
//     `canGenerateTTS`, but a NON-2xx HTTP response or a thrown fetch must read
//     as "cannot generate" (observably), never silently count as success.

import {
  ElevenLabsError,
  ElevenLabsTimeoutError,
} from "@elevenlabs/elevenlabs-js";
import { Hono } from "hono";
import { ApiError } from "@/lib/api/cloud-worker-errors";
import { getErrorStatusCode, nextJsonFromCaughtError } from "@/lib/api/errors";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { getElevenLabsService } from "@/lib/services/elevenlabs";
import { voiceCloningService } from "@/lib/services/voice-cloning";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

/**
 * An ElevenLabs lookup that 404s means the voice row exists in our DB but the
 * upstream voice is not materialized yet (a normal state for a fresh
 * professional/fine-tuned voice). Anything else — network error, 401 bad key,
 * 429, 5xx — is a genuine upstream failure that must not masquerade as
 * "still processing".
 */
function isUpstreamVoiceAbsent(error: unknown): boolean {
  return error instanceof ElevenLabsError && error.statusCode === 404;
}

/**
 * Translate an upstream ElevenLabs failure into a boundary error that carries
 * its REAL HTTP status AND the canonical error code for that status.
 *
 * `getErrorStatusCode` doesn't read `ElevenLabsError.statusCode` and
 * `ElevenLabsTimeoutError` isn't even an `ElevenLabsError`, so without this:
 *   - a 401 bad-key / 429 rate-limit / 422 validation from ElevenLabs would
 *     collapse to a generic 500 at the J1 boundary, and
 *   - a transport timeout would surface as a 500 implying OUR worker faulted.
 *
 * Client-error statuses (4xx) pass through verbatim so the JSON contract keeps
 * the canonical code (`rate_limit_exceeded`, `validation_error`, …) callers
 * branch on for retry. A 5xx / timeout / unknown upstream fault becomes a
 * retryable 503 "provider unavailable" — the provider is down, not us. The
 * single-arg `ApiError(status)` overload derives the canonical code from the
 * status, so we never mislabel a rate limit as an internal error.
 */
function toUpstreamBoundaryError(error: unknown): unknown {
  // A transport timeout means the provider is unreachable, not a worker fault.
  if (error instanceof ElevenLabsTimeoutError) {
    return new ApiError(503);
  }
  if (!(error instanceof ElevenLabsError)) {
    return error;
  }
  const upstream = error.statusCode;
  const isClientError =
    upstream !== undefined && upstream >= 400 && upstream < 500;
  const status = isClientError ? upstream : 503;
  return new ApiError(
    status,
    // Positional overload derives the canonical code from the status
    // (429 -> rate_limit_exceeded, 422 -> validation_error, 401 -> auth, …).
    undefined,
    status >= 500
      ? "Voice provider is temporarily unavailable"
      : error.message || "Voice provider request failed",
  );
}

/**
 * Best-effort TTS readiness probe. Returns whether a one-word synthesis call
 * succeeded. A thrown fetch or a non-2xx HTTP response both read as "cannot
 * generate" — but observably (warn), never a silently-swallowed false that
 * looks the same as a voice that simply isn't fine-tuned yet.
 */
async function probeTtsReadiness(
  elevenlabsVoiceId: string,
  apiKey: string,
): Promise<boolean> {
  try {
    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${elevenlabsVoiceId}`,
      {
        method: "POST",
        headers: {
          "xi-api-key": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text: "Test",
          model_id: "eleven_multilingual_v2",
        }),
      },
    );
    if (!res.ok) {
      // A non-2xx here is meaningful signal the voice can't synthesize yet
      // (or the key is bad). Previously this counted as canGenerateTTS=true
      // because only THROWS were caught, so a 401/429/5xx faked a ready voice.
      logger.warn("[Voice Verify API] TTS readiness probe returned non-2xx", {
        elevenlabsVoiceId,
        status: res.status,
      });
      return false;
    }
    return true;
  } catch (error) {
    // error-policy:J4 readiness-probe transport failure degrades to
    // canGenerateTTS=false — observable, feeds a user-facing "not ready" verdict,
    // never a fabricated success.
    logger.warn("[Voice Verify API] TTS readiness probe failed", {
      elevenlabsVoiceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * GET /api/elevenlabs/voices/verify/[id]
 * Verifies if a voice is ready to use in ElevenLabs by checking its status and testing TTS generation.
 * Useful for professional voices that may still be processing or fine-tuning.
 *
 * @param request - The Next.js request object.
 * @param context - Route context containing the voice ID parameter.
 * @returns Voice verification status including readiness, TTS capability, and fine-tuning information.
 */
async function __hono_GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);
    const params = await context.params;
    const voiceId = params.id;

    logger.info(`[Voice Verify API] Verifying voice ${voiceId}`);

    // Get voice from database
    const voice = await voiceCloningService.getVoiceById(
      voiceId,
      user.organization_id!,
    );

    if (!voice) {
      return Response.json({ error: "Voice not found" }, { status: 404 });
    }

    // Check status in ElevenLabs
    const elevenlabs = getElevenLabsService();
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) {
      // Fail closed: without a key we cannot verify anything. Do not fabricate
      // a "still processing" verdict from a service-config gap.
      throw new Error("ELEVENLABS_API_KEY environment variable is required");
    }

    let elevenLabsVoice: Awaited<ReturnType<typeof elevenlabs.getVoiceById>>;
    try {
      elevenLabsVoice = await elevenlabs.getVoiceById(voice.elevenlabsVoiceId);
    } catch (error) {
      if (isUpstreamVoiceAbsent(error)) {
        // error-policy:J4 upstream 404 is an EXPECTED not-ready state for a
        // freshly-created professional voice — degrade to a distinct
        // "still processing" verdict (not a synthesis failure, not a 500).
        logger.info("[Voice Verify API] Voice not yet present in ElevenLabs", {
          voiceId: voice.id,
          elevenlabsVoiceId: voice.elevenlabsVoiceId,
        });
        return Response.json({
          success: true,
          voice: {
            id: voice.id,
            name: voice.name,
            elevenlabsVoiceId: voice.elevenlabsVoiceId,
            cloneType: voice.cloneType,
          },
          status: {
            isReady: false,
            canGenerateTTS: false,
            message: "Voice is still being processed. Please wait.",
          },
        });
      }
      // A real upstream failure (transport / 401 / 429 / 5xx) is NOT a
      // "still processing" state. Rethrow to the J1 boundary (carrying the
      // real upstream status) so the caller gets a structured failure and
      // stops polling a broken service.
      throw toUpstreamBoundaryError(error);
    }

    // For professional voices, check fine-tuning status
    const isProfessional = voice.cloneType === "professional";
    const isReady = isProfessional
      ? Boolean(
          elevenLabsVoice.fineTuning?.state &&
            Object.keys(elevenLabsVoice.fineTuning.state).length > 0,
        )
      : true; // Instant voices are ready immediately

    // Probe a one-word synthesis to confirm the voice actually generates. A
    // non-2xx or thrown fetch reads observably as canGenerateTTS=false.
    const canGenerateTTS = await probeTtsReadiness(
      voice.elevenlabsVoiceId,
      apiKey,
    );

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
    // error-policy:J1 outermost route boundary — structured failure, never a
    // fabricated success. Surfaces auth (401/403), rate limit, and upstream
    // transport/5xx as their real statuses; only genuine 5xx are logged as
    // errors (a 401 is a caller problem, not a server fault).
    if (getErrorStatusCode(error) >= 500) {
      logger.error("[Voice Verify API] Error:", error);
    }
    return nextJsonFromCaughtError(error);
  }
}

const __hono_app = new Hono<AppEnv>();
__hono_app.get("/", async (c) =>
  __hono_GET(c.req.raw, {
    params: Promise.resolve({ id: c.req.param("id")! }),
  }),
);
export default __hono_app;
