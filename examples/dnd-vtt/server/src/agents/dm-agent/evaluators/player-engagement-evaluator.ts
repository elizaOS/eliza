/**
 * Player Engagement Evaluator
 * Tracks player activity and suggests ways to improve engagement
 */

import type { Evaluator, IAgentRuntime, Memory, State } from '@elizaos/core';

export interface PlayerActivity {
  characterId: string;
  characterName: string;
  lastActionTime: Date;
  actionCount: number;
  interactionTypes: string[];
  isEngaged: boolean;
}

export interface EngagementMetrics {
  totalPlayers: number;
  activePlayerCount: number;
  disengagedPlayers: string[];
  spotlightDistribution: Record<string, number>;
  suggestedFocus?: string;
  overallEngagement: number; // 0-100
}

// Time in minutes before a player is considered disengaged
const DISENGAGEMENT_THRESHOLD_MINUTES = 5;

export const playerEngagementEvaluator: Evaluator = {
  name: 'playerEngagement',
  description: 'Tracks player activity and suggests engagement improvements',
  
  alwaysRun: true,
  
  similes: [
    'check engagement',
    'player activity',
    'spotlight balance',
    'who is quiet',
  ],
  
  examples: [
    {
      prompt: 'One player has not taken action in 10 minutes',
      messages: [],
      outcome: 'Flag player as potentially disengaged, suggest involving them.',
    },
    {
      prompt: 'One player has taken 80% of recent actions',
      messages: [],
      outcome: 'Suggest giving other players opportunities to shine.',
    },
  ],
  
  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    const role = runtime.getSetting('role');
    return role === 'dm';
  },
  
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State
  ) => {
    // Get player activity data
    const raw = runtime.getSetting('playerActivity');
    let playerActivity: Record<string, PlayerActivity> | null = null;
    if (raw && typeof raw === 'string') {
      try {
        playerActivity = JSON.parse(raw) as Record<string, PlayerActivity>;
      } catch {
        playerActivity = null;
      }
    }
    
    if (!playerActivity || Object.keys(playerActivity).length === 0) {
      return undefined;
    }
    
    const now = new Date();
    const players = Object.values(playerActivity);
    
    // Calculate engagement for each player
    const disengagedPlayers: string[] = [];
    let activeCount = 0;
    
    for (const player of players) {
      const lastActionTime = new Date(player.lastActionTime);
      const minutesSinceAction = (now.getTime() - lastActionTime.getTime()) / 60000;
      
      if (minutesSinceAction > DISENGAGEMENT_THRESHOLD_MINUTES) {
        disengagedPlayers.push(player.characterName);
        player.isEngaged = false;
      } else {
        player.isEngaged = true;
        activeCount++;
      }
    }
    
    // Calculate spotlight distribution
    const totalActions = players.reduce((sum, p) => sum + p.actionCount, 0);
    const spotlightDistribution: Record<string, number> = {};
    
    for (const player of players) {
      spotlightDistribution[player.characterName] = totalActions > 0
        ? Math.round((player.actionCount / totalActions) * 100)
        : Math.round(100 / players.length);
    }
    
    // Find suggested focus (player who needs attention)
    let suggestedFocus: string | undefined;
    
    // Priority 1: Player who hasn't acted recently
    if (disengagedPlayers.length > 0) {
      // Find the one who's been quiet longest
      const longestQuiet = players
        .filter(p => !p.isEngaged)
        .sort((a, b) => new Date(a.lastActionTime).getTime() - new Date(b.lastActionTime).getTime())[0];
      
      if (longestQuiet) {
        suggestedFocus = longestQuiet.characterName;
      }
    }
    
    // Priority 2: Player with lowest spotlight share
    if (!suggestedFocus && totalActions > 5) {
      const lowestSpotlight = players
        .sort((a, b) => a.actionCount - b.actionCount)[0];
      
      if (lowestSpotlight && spotlightDistribution[lowestSpotlight.characterName] < 15) {
        suggestedFocus = lowestSpotlight.characterName;
      }
    }
    
    // Calculate overall engagement score
    const engagementFactors = [
      activeCount / players.length, // Active player ratio
      calculateSpotlightBalance(spotlightDistribution, players.length), // Distribution balance
      disengagedPlayers.length === 0 ? 1 : 0.5, // Bonus if no one is disengaged
    ];
    
    const overallEngagement = Math.round(
      (engagementFactors.reduce((a, b) => a + b, 0) / engagementFactors.length) * 100
    );
    
    const metrics: EngagementMetrics = {
      totalPlayers: players.length,
      activePlayerCount: activeCount,
      disengagedPlayers,
      spotlightDistribution,
      suggestedFocus,
      overallEngagement,
    };
    
    // Emit event if engagement is low
    if (overallEngagement < 50 || disengagedPlayers.length >= players.length / 2) {
      const engagementPayload = {
        runtime,
        engagement: overallEngagement,
        disengaged: disengagedPlayers,
        suggestion: suggestedFocus 
          ? `Consider directing action toward ${suggestedFocus}`
          : 'Consider introducing an engaging event for the whole party',
        timestamp: new Date(),
      };
      await runtime.emitEvent('low_engagement_warning', engagementPayload);
    }
    
    return {
      success: true,
      data: { metrics },
    };
  },
};

function calculateSpotlightBalance(distribution: Record<string, number>, playerCount: number): number {
  // Perfect balance would be 100/playerCount for each player
  const idealShare = 100 / playerCount;
  const values = Object.values(distribution);
  
  // Calculate standard deviation from ideal
  const variance = values.reduce((sum, v) => sum + Math.pow(v - idealShare, 2), 0) / values.length;
  const stdDev = Math.sqrt(variance);
  
  // Convert to 0-1 score (lower stdDev = better balance = higher score)
  // StdDev of 0 = perfect (1.0), stdDev of 50 = terrible (0.0)
  return Math.max(0, 1 - (stdDev / 50));
}

/**
 * Utility function to record a player action
 */
export async function recordPlayerAction(
  runtime: IAgentRuntime,
  characterId: string,
  characterName: string,
  actionType: string
): Promise<void> {
  const raw = runtime.getSetting('playerActivity');
  let playerActivity: Record<string, PlayerActivity> = {};
  if (raw && typeof raw === 'string') {
    try {
      playerActivity = JSON.parse(raw) as Record<string, PlayerActivity>;
    } catch {
      playerActivity = {};
    }
  }
  
  if (!playerActivity[characterId]) {
    playerActivity[characterId] = {
      characterId,
      characterName,
      lastActionTime: new Date(),
      actionCount: 0,
      interactionTypes: [],
      isEngaged: true,
    };
  }
  
  playerActivity[characterId].lastActionTime = new Date();
  playerActivity[characterId].actionCount++;
  
  if (!playerActivity[characterId].interactionTypes.includes(actionType)) {
    playerActivity[characterId].interactionTypes.push(actionType);
  }
  
  playerActivity[characterId].isEngaged = true;
  
  runtime.setSetting('playerActivity', JSON.stringify(playerActivity));
}

export default playerEngagementEvaluator;
