/**
 * Hydrates realtime voice agent scope after a cache-only request reports a
 * retryable warming state. This module is dynamically loaded only from a
 * waitUntil task, keeping repository construction and Postgres I/O outside the
 * response-facing voice turn module and its warm dependency graph.
 */

import { runWithDbCacheAsync } from "@/db/client";
import { agentSandboxesRepository } from "@/db/repositories/agent-sandboxes";
import { cache } from "@/lib/cache/client";
import { CacheKeys, CacheTTL } from "@/lib/cache/keys";
import { runWithCloudBindingsAsync } from "@/lib/runtime/cloud-bindings";
import type { Bindings } from "@/types/cloud-worker-env";
import type { InternalElizaConversationFetchClaims } from "./internal-eliza-conversation-fetch";

export async function hydrateVoiceSharedAgentScope(
  env: Bindings,
  claims: InternalElizaConversationFetchClaims,
): Promise<void> {
  await runWithCloudBindingsAsync(
    env as unknown as Record<string, unknown>,
    () =>
      runWithDbCacheAsync(async () => {
        const agent = await agentSandboxesRepository.findByIdAndOrg(
          claims.agentId,
          claims.organizationId,
        );
        if (
          !agent ||
          agent.id !== claims.agentId ||
          agent.organization_id !== claims.organizationId ||
          agent.user_id !== claims.userId ||
          agent.execution_tier !== "shared"
        ) {
          return;
        }

        await cache.set(
          CacheKeys.sharedAgentScope.voice(
            claims.organizationId,
            claims.userId,
            claims.agentId,
          ),
          agent,
          CacheTTL.sharedAgentScope.resolve,
        );
      }),
  );
}
