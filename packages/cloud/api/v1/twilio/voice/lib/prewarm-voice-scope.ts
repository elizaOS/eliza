/**
 * Starts shared-runtime cache hydration during the inbound Twilio webhook so
 * cold database work overlaps call setup, the greeting, and caller speech.
 */

import type { SharedRuntimeAgent } from "@elizaos/cloud-shared/lib/services/shared-runtime/shared-runtime-agent";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { Bindings } from "@elizaos/cloud-shared/types/cloud-worker-env";
import type { InternalElizaConversationFetchClaims } from "../../../voice/session/lib/internal-eliza-conversation-fetch";

interface VoicePrewarmExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

type HydrateVoiceScope = (
  env: Bindings,
  claims: InternalElizaConversationFetchClaims,
  preloadedAgent?: SharedRuntimeAgent,
  options?: { freshConversation?: boolean },
) => Promise<void>;

interface ScheduleVoiceScopePrewarmOptions {
  agent?: SharedRuntimeAgent;
  claims: InternalElizaConversationFetchClaims;
  env: Bindings;
  executionCtx: VoicePrewarmExecutionContext;
  freshConversation?: boolean;
  hydrateScope?: HydrateVoiceScope;
}

/** Registers a safe background prewarm at the earliest authenticated call boundary. */
export function scheduleTwilioVoiceScopePrewarm({
  agent,
  claims,
  env,
  executionCtx,
  freshConversation,
  hydrateScope,
}: ScheduleVoiceScopePrewarmOptions): Promise<void> {
  const prewarm = Promise.resolve()
    .then(async () => {
      const hydrate =
        hydrateScope ??
        (await import("../../../voice/session/lib/voice-agent-scope-hydration"))
          .hydrateVoiceSharedAgentScope;
      await hydrate(env, claims, agent, { freshConversation });
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
