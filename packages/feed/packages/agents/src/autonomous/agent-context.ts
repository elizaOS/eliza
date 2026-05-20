/**
 * Shared Agent Context Resolution
 *
 * Provides utilities for resolving agent identity (NPC vs USER_CONTROLLED).
 * Eliminates duplicate boilerplate across autonomous services.
 */

import { db, eq, users } from '@babylon/db';
import { StaticDataRegistry } from '@babylon/engine';

export interface AgentContext {
  agentUserId: string;
  displayName: string;
  isNpc: boolean;
  /** Lifetime P&L (0 for NPCs) */
  lifetimePnL: number;
}

/**
 * Resolve agent context from user ID.
 *
 * Checks StaticDataRegistry first (for NPCs), then falls back to User table.
 * This pattern is used across all autonomous services for consistent agent resolution.
 *
 * @param agentUserId - Agent user ID
 * @returns Agent context with display name, NPC status, and P&L
 * @throws Error if agent not found and not an NPC
 */
export async function getAgentContext(
  agentUserId: string
): Promise<AgentContext> {
  // Check if this is an NPC (has entry in StaticDataRegistry)
  const npcActor = StaticDataRegistry.getActor(agentUserId);
  const isNpc = !!npcActor;

  if (isNpc) {
    return {
      agentUserId,
      displayName: npcActor.name,
      isNpc: true,
      lifetimePnL: 0, // NPCs don't track P&L
    };
  }

  // USER_CONTROLLED: Get from User table
  const [agent] = await db
    .select({
      id: users.id,
      displayName: users.displayName,
      isAgent: users.isAgent,
      lifetimePnL: users.lifetimePnL,
    })
    .from(users)
    .where(eq(users.id, agentUserId))
    .limit(1);

  if (!agent?.isAgent) {
    throw new Error(`Agent not found: ${agentUserId}`);
  }

  return {
    agentUserId,
    displayName: agent.displayName ?? agentUserId,
    isNpc: false,
    lifetimePnL: Number(agent.lifetimePnL ?? 0),
  };
}

/**
 * Check if a user ID represents an NPC.
 *
 * @param userId - User ID to check
 * @returns True if the user is an NPC in StaticDataRegistry
 */
export function isNpcUser(userId: string): boolean {
  return !!StaticDataRegistry.getActor(userId);
}
