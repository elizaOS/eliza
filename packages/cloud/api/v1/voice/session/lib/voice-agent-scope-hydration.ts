/**
 * Hydrates realtime voice agent scope after a cache-only request reports a
 * retryable warming state. This module is dynamically loaded only from a
 * waitUntil task, keeping repository construction and Postgres I/O outside the
 * response-facing voice turn module and its warm dependency graph.
 */

import { runWithDbCacheAsync } from "@/db/client";
import { agentSandboxesRepository } from "@/db/repositories/agent-sandboxes";
import { userCharactersRepository } from "@/db/repositories/characters";
import { cache } from "@/lib/cache/client";
import { CacheKeys, CacheTTL } from "@/lib/cache/keys";
import { runWithCloudBindingsAsync } from "@/lib/runtime/cloud-bindings";
import { warmInferenceAdmissionSnapshot } from "@/lib/services/inference-admission-snapshot";
import { coordinateSharedConversationPrewarm } from "@/lib/services/shared-runtime/conversation-coordinator";
import type { SharedRuntimeAgent } from "@/lib/services/shared-runtime/shared-runtime-agent";
import { logger } from "@/lib/utils/logger";
import type { Bindings } from "@/types/cloud-worker-env";
import type { InternalElizaConversationFetchClaims } from "./internal-eliza-conversation-fetch";

export async function hydrateVoiceSharedAgentScope(
  env: Bindings,
  claims: InternalElizaConversationFetchClaims,
  preloadedAgent?: SharedRuntimeAgent,
): Promise<void> {
  await runWithCloudBindingsAsync(
    env as unknown as Record<string, unknown>,
    () =>
      runWithDbCacheAsync(async () => {
        const agent =
          preloadedAgent ??
          (await agentSandboxesRepository.findByIdAndOrg(
            claims.agentId,
            claims.organizationId,
          ));
        if (
          !agent ||
          agent.id !== claims.agentId ||
          agent.organization_id !== claims.organizationId ||
          agent.user_id !== claims.userId ||
          agent.execution_tier !== "shared"
        ) {
          return;
        }

        // The turn needs its scope, linked character, and combined admission
        // projection warm. Hydrating only the scope entry left
        // the linked-character entry cold, so the very next turn passed the
        // scope gate and then threw SharedRuntimeCacheWarmingError from
        // `characterFor` (cacheOnly) — a SECOND burned turn, and on a session
        // whose turns are spaced by human think-time the two 503s could
        // alternate indefinitely. Warm the character entry in the SAME
        // background task, under the same db/bindings context, so one
        // hydration makes the next turn fully serviceable.
        const characterId = agent.character_id;
        const hydrateCharacter = async (): Promise<void> => {
          if (!characterId) return;
          const cacheKey = `character:data:${characterId}`;
          if (await cache.get(cacheKey)) return;
          const character =
            await userCharactersRepository.findByIdInOrganization(
              characterId,
              claims.organizationId,
            );
          if (!character) return;
          await cache.set(cacheKey, character, CacheTTL.agent.characterData);
        };

        // Publish the authorization gate as soon as the authoritative agent
        // lookup succeeds. Character and admission prefills are latency hints;
        // keeping this write behind either one turns a slow optional dependency
        // into the full 503/backoff staircase on the caller's first response.
        await cache.set(
          CacheKeys.sharedAgentScope.voice(
            claims.organizationId,
            claims.userId,
            claims.agentId,
          ),
          agent,
          CacheTTL.sharedAgentScope.resolve,
        );

        // error-policy:J7 a failed character prefill leaves the next turn on
        // its existing retryable warming path rather than failing hydration.
        const optionalWarmups: Promise<unknown>[] = [
          hydrateCharacter().catch((error) => {
            logger.warn("[voice-scope-hydration] character prefill failed", {
              agentId: claims.agentId,
              characterId,
              error: error instanceof Error ? error.message : String(error),
            });
          }),
          warmInferenceAdmissionSnapshot(claims.organizationId).catch(
            (error) => {
              // error-policy:J7 the shared turn stays fail-closed on its combined
              // admission cache if this optional prewarm cannot complete.
              logger.warn("[voice-scope-hydration] admission prefill failed", {
                agentId: claims.agentId,
                organizationId: claims.organizationId,
                error: error instanceof Error ? error.message : String(error),
              });
            },
          ),
        ];
        if (env.SHARED_RUNTIME_CONVERSATIONS) {
          optionalWarmups.push(
            coordinateSharedConversationPrewarm(
              claims.agentId,
              claims.conversationId,
              { namespace: env.SHARED_RUNTIME_CONVERSATIONS },
            ).catch((error) => {
              // error-policy:J7 conversation hydration is a latency hint; the
              // real turn retains its typed cache-warming retry fallback.
              logger.warn(
                "[voice-scope-hydration] conversation prefill failed",
                {
                  agentId: claims.agentId,
                  conversationId: claims.conversationId,
                  error: error instanceof Error ? error.message : String(error),
                },
              );
            }),
          );
        }
        await Promise.all(optionalWarmups);
      }),
  );
}
