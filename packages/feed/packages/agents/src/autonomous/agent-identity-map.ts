/**
 * Agent Identity Map Builder
 *
 * Builds a complete identity map of ALL agents (NPCs + user agents) with their
 * team and alignment. This is the foundation for interaction labeling — without
 * it, the system cannot determine if an interaction was with a scammer or ally.
 *
 * Called by AutonomousCoordinator before each tick when trajectory recording
 * is enabled.
 */

import { db, userAgentConfigs } from '@babylon/db';
import { StaticDataRegistry } from '@babylon/engine';
import type { IAgentRuntime } from '@elizaos/core';
import { getAgentConfig } from '../shared/agent-config';

/** Agent identity entry for interaction labeling */
export interface AgentIdentity {
  team: string; // 'red' | 'blue' | 'gray'
  alignment: string; // 'good' | 'neutral' | 'evil'
  instanceId: string;
}

/**
 * Build identity map of ALL agents so interaction labeling can determine
 * whether a counterparty is red/blue/gray. Without this, all interaction
 * labels are empty and scam/legitimate tracking is disabled.
 */
export async function buildAgentIdentityMap(): Promise<
  Map<string, AgentIdentity>
> {
  const map = new Map<string, AgentIdentity>();

  // 1. All NPCs from StaticDataRegistry (character JSON files)
  try {
    const allActors = StaticDataRegistry.getAllActors();
    for (const actor of allActors) {
      const babylon = (actor as unknown as Record<string, unknown>).babylon as
        | Record<string, unknown>
        | undefined;
      if (!babylon) continue;
      map.set(actor.id, {
        team: (babylon.team as string) ?? 'gray',
        alignment: (babylon.alignment as string) ?? 'neutral',
        instanceId: actor.id,
      });
    }
  } catch {
    // StaticDataRegistry may not be initialized in all contexts
  }

  // 2. All user agents from database
  try {
    const agents = await db
      .select({
        userId: userAgentConfigs.userId,
      })
      .from(userAgentConfigs);

    for (const agent of agents) {
      if (!agent.userId) continue;
      // User agents default to gray/neutral — team/alignment not stored in DB schema
      map.set(agent.userId, {
        team: 'gray',
        alignment: 'neutral',
        instanceId: agent.userId,
      });
    }
  } catch {
    // DB may not be available in all contexts
  }

  return map;
}

/**
 * Populate the identity map on the runtime and set the agent's own alignment.
 * Call this BEFORE the multi-step executor runs when trajectory recording is enabled.
 */
export async function populateIdentityMapOnRuntime(
  runtime: IAgentRuntime,
  agentUserId: string,
  isNpc: boolean
): Promise<void> {
  const identityMap = await buildAgentIdentityMap();
  (
    runtime as { _agentIdentityMap?: Map<string, AgentIdentity> }
  )._agentIdentityMap = identityMap;

  // Store this agent's own alignment for downstream use
  if (isNpc) {
    const babylon = (
      runtime.character as unknown as { babylon?: Record<string, unknown> }
    ).babylon;
    (runtime as { _agentTeam?: string })._agentTeam =
      (babylon?.team as string) ?? 'gray';
    (runtime as { _agentAlignment?: string })._agentAlignment =
      (babylon?.alignment as string) ?? 'neutral';
  } else {
    const config = await getAgentConfig(agentUserId);
    const alignment = (config as Record<string, unknown>)?.alignment;
    const team = (config as Record<string, unknown>)?.team;
    (runtime as { _agentTeam?: string })._agentTeam =
      team === 'red' || team === 'blue' ? (team as string) : 'gray';
    (runtime as { _agentAlignment?: string })._agentAlignment =
      alignment === 'good' || alignment === 'evil'
        ? (alignment as string)
        : 'neutral';
  }
}
