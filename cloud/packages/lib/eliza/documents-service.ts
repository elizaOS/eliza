/**
 * Knowledge service access helpers.
 */

import type { AgentRuntime } from "@elizaos/core";
import type { KnowledgeService as KnowledgeServiceType } from "@elizaos/plugin-knowledge";

const MAX_RETRIES = 5;
const INITIAL_DELAY_MS = 50; // Start low, increases exponentially
const MAX_DELAY_MS = 500;

/**
 * Get the knowledge service from runtime with exponential backoff.
 * Starts with 50ms delay and doubles each retry (50, 100, 200, 400, 500).
 * Total max wait: ~1.3s vs previous 3s.
 */
export async function getKnowledgeService(
  runtime: AgentRuntime,
): Promise<KnowledgeServiceType | null> {
  let service = runtime.getService("knowledge") as KnowledgeServiceType | null;
  if (service) return service;

  let delay = INITIAL_DELAY_MS;
  for (let i = 0; i < MAX_RETRIES; i++) {
    await new Promise((resolve) => setTimeout(resolve, delay));
    service = runtime.getService("knowledge") as KnowledgeServiceType | null;
    if (service) return service;
    delay = Math.min(delay * 2, MAX_DELAY_MS);
  }

  return null;
}

export async function hasKnowledgeService(runtime: AgentRuntime): Promise<boolean> {
  return (await getKnowledgeService(runtime)) !== null;
}
