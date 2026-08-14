/**
 * Starts shared-runtime cache hydration during the inbound Twilio webhook so
 * cold database work overlaps call setup, the greeting, and caller speech.
 */

import { logger } from "@/lib/utils/logger";
import type { Bindings } from "@/types/cloud-worker-env";
import type { InternalElizaConversationFetchClaims } from "../../../voice/session/lib/internal-eliza-conversation-fetch";

interface VoicePrewarmExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

type HydrateVoiceScope = (
  env: Bindings,
  claims: InternalElizaConversationFetchClaims,
) => Promise<void>;

interface ScheduleVoiceScopePrewarmOptions {
  claims: InternalElizaConversationFetchClaims;
  env: Bindings;
  executionCtx: VoicePrewarmExecutionContext;
  hydrateScope?: HydrateVoiceScope;
}

/** Registers a safe background prewarm at the earliest authenticated call boundary. */
export function scheduleTwilioVoiceScopePrewarm({
  claims,
  env,
  executionCtx,
  hydrateScope,
}: ScheduleVoiceScopePrewarmOptions): Promise<void> {
  const prewarm = Promise.resolve()
    .then(async () => {
      const hydrate =
        hydrateScope ??
        (await import("../../../voice/session/lib/voice-agent-scope-hydration"))
          .hydrateVoiceSharedAgentScope;
      await hydrate(env, claims);
    })
    .catch((error) => {
      // error-policy:J7 this is a latency hint; the media session retains its
      // authoritative hydration and retry path if the early prewarm fails.
      logger.warn("[twilio-voice-inbound] early scope prewarm failed", {
        agentId: claims.agentId,
        organizationId: claims.organizationId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  executionCtx.waitUntil(prewarm);
  return prewarm;
}
