/**
 * Provision-time cache prewarm for shared-runtime agents (CHAT-CORE-LATENCY §6
 * item 1: move hydration from "first paying request" to "agent create").
 *
 * A fresh shared agent's FIRST turn is served entirely from caches
 * (fail-closed, cache-only by design): conversation history (Durable Object),
 * the combined inference-admission snapshot (org balance + rate tier), model
 * pricing rates, and the linked character projection. None of those entries
 * exist for a brand-new agent/org, so the first send bounces off 2-4 retryable
 * 503s ("Conversation cache is warming. Retry shortly.", "Billing
 * authorization is warming. Retry shortly.") before the first 200 — measured
 * 13-27s of client-visible first-message wall on staging across 14/14 fresh
 * agents (QA-MATRIX-2026-08-11 §2/§3, FIRSTFIVE-CLOSE-2026-08-12). Clients
 * that do not retry the retryable 503 surface a broken first message at the
 * exact worst moment of the funnel.
 *
 * This runs the SAME authoritative hydration the 503 path already schedules
 * under waitUntil — just at create time, seconds before a human can type. By
 * the first message every gate the turn consults is warm.
 *
 * Best-effort by design: legs are independent and a failure only means the
 * first turn falls back to today's retryable-503 warming behavior — this can
 * only remove latency, never change an authorization or billing outcome.
 * Callers must keep it off the response path (Worker executionCtx.waitUntil).
 */

import type { Context } from "hono";

import type { AgentSandbox } from "../../../db/repositories/agent-sandboxes";
import type { AppEnv, RuntimeDurableObjectNamespace } from "../../../types/cloud-worker-env";
import { calculateCost, getProviderFromModel, normalizeModelName } from "../../pricing";
import { logger } from "../../utils/logger";
import {
  warmInferenceAdmissionGate,
  warmInferenceRateLimitGate,
} from "../inference-admission-gate";
import { warmInferenceAdmissionSnapshot } from "../inference-admission-snapshot";
import {
  coordinateSharedConversationPrewarm,
  coordinateSharedHistory,
} from "./conversation-coordinator";
import { seedSharedAgentScopeCache } from "./resolve-shared-agent";
import { resolveSharedAgentTurnModel } from "./run-shared-agent-turn";
import { projectSharedAgentCharacter } from "./shared-agent-character";
import type { SharedRuntimeAgent } from "./shared-runtime-agent";

export interface PrewarmSharedAgentOptions {
  /**
   * The conversation Durable Object namespace. Optional so non-Worker callers
   * (tests, legacy runtimes) can still warm the KV-backed projections; without
   * it only the conversation-object leg is skipped.
   */
  namespace?: RuntimeDurableObjectNamespace;
  /**
   * The creating request's Hono context — the credential it carries is the one
   * the immediate first message will present, so it is what the authorization
   * scope leg needs to derive `CacheKeys.sharedAgentScope.resolve(<prefix>,
   * agentId)`. Without it that leg is skipped and the first send pays the
   * "authorization cache is warming" 503.
   */
  requestContext?: Context<AppEnv>;
  /**
   * The creating user's steward id, for a session-keyed scope entry to pass
   * its hit-time same-user re-verification. Ignored on the API-key path.
   */
  stewardUserId?: string;
}

interface PrewarmLeg {
  leg: string;
  run: Promise<unknown>;
}

async function settlePrewarmLegs(
  agent: Pick<SharedRuntimeAgent, "id" | "organization_id">,
  legs: PrewarmLeg[],
): Promise<void> {
  const results = await Promise.allSettled(legs.map(({ run }) => run));
  results.forEach((result, index) => {
    if (result.status === "rejected") {
      logger.warn("[shared-runtime prewarm] leg failed; first turn falls back to warming 503s", {
        agentId: agent.id,
        organizationId: agent.organization_id,
        leg: legs[index].leg,
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    }
  });
}

/**
 * Hydrate every cache the cache-only shared first turn consults. Resolves when
 * all legs have settled; never rejects (failed legs are logged and the turn
 * path's retryable warming 503s remain the fallback).
 */
export async function prewarmSharedAgentTurnCaches(
  agent: AgentSandbox,
  options: PrewarmSharedAgentOptions = {},
): Promise<void> {
  const legs: PrewarmLeg[] = [];

  // The admission snapshot carries policy, while the gate is the independent
  // serialized authority that enforces it. Warming both avoids exchanging a
  // cache miss for a cold Durable Object timeout on the first turn.
  legs.push({
    leg: "admission-gate",
    run: warmInferenceAdmissionGate(agent.organization_id),
  });
  legs.push({
    leg: "rate-limit-gate",
    run: warmInferenceRateLimitGate(agent.organization_id),
  });

  // 1. Combined admission snapshot: org balance + rate-limit tier. The
  //    projection behind "Billing authorization is warming", "Inference
  //    admission cache is warming", and the rate-limit warming 503s.
  legs.push({
    leg: "admission-snapshot",
    run: warmInferenceAdmissionSnapshot(agent.organization_id),
  });

  // 2. Hydrate the linked character before resolving pricing. The live turn's
  //    canonical projection gives linked settings.model precedence over the
  //    nested and top-level agent config, so pricing cannot be selected safely
  //    until this authoritative read completes. getById also writes the exact
  //    `character:data:<id>` entry the cache-only turn reads.
  const pricingAndCharacter = (async () => {
    const linked = agent.character_id
      ? await import("../characters/characters").then(({ charactersService }) =>
          charactersService.getById(agent.character_id!),
        )
      : undefined;
    const character = projectSharedAgentCharacter(agent, linked);
    const model = resolveSharedAgentTurnModel(character.model);
    if (model) {
      await calculateCost(
        normalizeModelName(model),
        getProviderFromModel(model),
        1,
        1,
        "bitrouter",
      );
    }
  })();
  legs.push({ leg: "character-and-pricing", run: pricingAndCharacter });

  // 3. Conversation Durable Object hydration ("Conversation cache is
  //    warming"). The first history read on a cold object starts its
  //    authoritative Postgres hydration under the object's own waitUntil and
  //    reports warming; Promise.allSettled observes and logs that rejection
  //    while leaving the object hydrated for the real first turn. Launch model:
  //    one canonical
  //    conversation per shared agent (roomId === agentId), the same room the
  //    REST turn dispatch addresses.
  if (options.namespace) {
    legs.push({
      leg: "conversation-object",
      run: coordinateSharedHistory(agent.id, agent.id, { namespace: options.namespace }),
    });
  }

  // 4. Credential-scoped authorization entry ("Agent authorization cache is
  //    warming"). The first message route resolves the agent cache-only against
  //    the creator's own credential; seeding that exact entry here is what lets
  //    a fresh create take an immediate send. Hits still re-run the
  //    per-request credential gate, so this leg only removes latency.
  if (options.requestContext) {
    legs.push({
      leg: "authorization-scope",
      run: seedSharedAgentScopeCache(options.requestContext, agent, options.stewardUserId),
    });
  }

  await settlePrewarmLegs(agent, legs);
}

/**
 * Warm the authorities a Personal Shared turn needs. Platform-funded turns use
 * only the rate-limit window, so this deliberately avoids balance-ledger
 * hydration. Established accounts can skip the conversation leg while still
 * keeping inference admission off the first model request.
 */
export async function prewarmPersonalSharedAgentTurnCaches(
  agent: Pick<SharedRuntimeAgent, "id" | "organization_id">,
  namespace: RuntimeDurableObjectNamespace,
  options: { warmConversation?: boolean; conversationId?: string } = {},
): Promise<void> {
  const legs: PrewarmLeg[] = [
    {
      leg: "rate-limit-gate",
      run: warmInferenceRateLimitGate(agent.organization_id),
    },
  ];
  if (options.warmConversation !== false) {
    legs.push({
      leg: "conversation-object",
      run: coordinateSharedConversationPrewarm(agent.id, options.conversationId ?? agent.id, {
        namespace,
        startEmpty: true,
      }),
    });
  }
  await settlePrewarmLegs(agent, legs);
}
