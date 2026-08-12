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

import type { AgentSandbox } from "../../../db/repositories/agent-sandboxes";
import type { RuntimeDurableObjectNamespace } from "../../../types/cloud-worker-env";
import { calculateCost, getProviderFromModel } from "../../pricing";
import { logger } from "../../utils/logger";
import { warmInferenceAdmissionSnapshot } from "../inference-admission-snapshot";
import { coordinateSharedHistory } from "./conversation-coordinator";
import { resolveSharedAgentTurnModel } from "./run-shared-agent-turn";

export interface PrewarmSharedAgentOptions {
  /**
   * The conversation Durable Object namespace. Optional so non-Worker callers
   * (tests, legacy runtimes) can still warm the KV-backed projections; without
   * it only the conversation-object leg is skipped.
   */
  namespace?: RuntimeDurableObjectNamespace;
}

function configuredModel(agent: AgentSandbox): string | undefined {
  const config = agent.agent_config;
  if (!config || typeof config !== "object") return undefined;
  const model = (config as Record<string, unknown>).model;
  return typeof model === "string" && model.trim() ? model.trim() : undefined;
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
  const legs: Array<{ leg: string; run: Promise<unknown> }> = [];

  // 1. Combined admission snapshot: org balance + rate-limit tier. The
  //    projection behind "Billing authorization is warming", "Inference
  //    admission cache is warming", and the rate-limit warming 503s.
  legs.push({
    leg: "admission-snapshot",
    run: warmInferenceAdmissionSnapshot(agent.organization_id),
  });

  // 2. Pricing rates for the model the first turn will bill. The authoritative
  //    (non-cache-only) read populates the durable pricing cache that the
  //    cache-only admission path consults ("AI pricing cache is warming").
  const model = resolveSharedAgentTurnModel(configuredModel(agent));
  if (model) {
    legs.push({
      leg: "pricing",
      run: calculateCost(model, getProviderFromModel(model), 1, 1, "bitrouter"),
    });
  }

  // 3. Linked character projection ("Character cache is warming"). getById
  //    writes the same `character:data:<id>` entry the cache-only turn reads.
  if (agent.character_id) {
    const characterId = agent.character_id;
    legs.push({
      leg: "character",
      run: import("../characters/characters").then(({ charactersService }) =>
        charactersService.getById(characterId),
      ),
    });
  }

  // 4. Conversation Durable Object hydration ("Conversation cache is
  //    warming"). The first history read on a cold object starts its
  //    authoritative Postgres hydration under the object's own waitUntil and
  //    reports warming; swallowing that expected rejection leaves the object
  //    hydrated for the real first turn. Launch model: one canonical
  //    conversation per shared agent (roomId === agentId), the same room the
  //    REST turn dispatch addresses.
  if (options.namespace) {
    legs.push({
      leg: "conversation-object",
      run: coordinateSharedHistory(agent.id, agent.id, { namespace: options.namespace }).catch(
        () => undefined,
      ),
    });
  }

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
