/**
 * Agent Ordering Utilities
 *
 * Shared utilities for ordering and shuffling agent lists in team chat.
 * Used by both the API route and tests.
 */

/**
 * Strategies for ordering agent responses to untagged messages.
 */
export type AgentOrderingStrategy =
  | "random"
  | "created_asc"
  | "created_desc"
  | "alphabetical";

/**
 * Minimal agent info needed for ordering.
 */
export interface OrderableAgent {
  id: string;
  displayName: string | null;
  createdAt: Date | null;
}

/**
 * Orders agent IDs based on the specified strategy.
 *
 * @param agentIds - Array of agent IDs to order
 * @param teamAgents - Array of agent objects with ordering metadata
 * @param strategy - Ordering strategy to apply
 * @returns Ordered array of agent IDs
 */
export function orderAgentIds(
  agentIds: string[],
  teamAgents: OrderableAgent[],
  strategy: AgentOrderingStrategy,
): string[] {
  const agentMap = new Map(teamAgents.map((a) => [a.id, a]));

  switch (strategy) {
    case "random":
      return shuffleArray([...agentIds]);

    case "created_asc":
      return [...agentIds].sort((a, b) => {
        const agentA = agentMap.get(a);
        const agentB = agentMap.get(b);
        const timeA = agentA?.createdAt?.getTime() ?? 0;
        const timeB = agentB?.createdAt?.getTime() ?? 0;
        return timeA - timeB;
      });

    case "created_desc":
      return [...agentIds].sort((a, b) => {
        const agentA = agentMap.get(a);
        const agentB = agentMap.get(b);
        const timeA = agentA?.createdAt?.getTime() ?? 0;
        const timeB = agentB?.createdAt?.getTime() ?? 0;
        return timeB - timeA;
      });

    case "alphabetical":
      return [...agentIds].sort((a, b) => {
        const agentA = agentMap.get(a);
        const agentB = agentMap.get(b);
        const nameA = agentA?.displayName ?? "";
        const nameB = agentB?.displayName ?? "";
        return nameA.localeCompare(nameB);
      });

    default:
      // Exhaustive check - all valid strategies handled above
      // Return copy for immutability
      return [...agentIds];
  }
}

/**
 * Fisher-Yates shuffle for randomizing array order.
 * Creates a shallow copy and shuffles it, leaving the original unchanged.
 *
 * @param array - Array to shuffle (not mutated)
 * @returns A new shuffled array
 */
export function shuffleArray<T>(array: T[]): T[] {
  const copy = [...array];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const temp = copy[i];
    copy[i] = copy[j] as T;
    copy[j] = temp as T;
  }
  return copy;
}
