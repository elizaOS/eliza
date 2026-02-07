/**
 * Tactical Decision Evaluator
 * Assesses the tactical soundness of player decisions
 */

import type { Evaluator, IAgentRuntime, Memory, State } from '@elizaos/core';
import type { CharacterSheet } from '../../../types';
import { getHP } from '../../../types';

export interface TacticalMetrics {
  situationalAwareness: number;  // 0-10: Considers battlefield state
  resourceManagement: number;    // 0-10: Uses resources appropriately
  teamCoordination: number;      // 0-10: Works with party
  riskAssessment: number;        // 0-10: Appropriate risk-taking
  overallTacticalScore: number;
}

export const tacticalDecisionEvaluator: Evaluator = {
  name: 'tacticalDecision',
  description: 'Evaluates tactical soundness of combat decisions',
  
  alwaysRun: false, // Only run in combat
  
  similes: [
    'tactical analysis',
    'combat strategy',
    'smart play',
  ],
  
  examples: [
    {
      prompt: 'Fighter at low HP charges into group of enemies',
      messages: [
        {
          name: 'player',
          content: {
            text: 'I charge into the center of the enemies!',
          },
        },
      ],
      outcome: 'Low risk assessment - should consider defensive options when wounded.',
    },
  ],
  
  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    const role = await runtime.getSetting('role');
    const combatState = await runtime.getSetting('combatState') as { isActive?: boolean } | null;
    
    return role === 'player' && Boolean(combatState?.isActive);
  },
  
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State
  ) => {
    const text = typeof message.content === 'string'
      ? message.content
      : message.content?.text;
    
    if (!text) return undefined;
    
    const characterSheet = await runtime.getSetting('characterSheet') as unknown as CharacterSheet | null;
    const combatState = await runtime.getSetting('combatState');
    
    if (!characterSheet) return undefined;
    
    const hp = getHP(characterSheet);
    const hpPercent = (hp.current / hp.max) * 100;
    
    const metrics: TacticalMetrics = {
      situationalAwareness: evaluateSituationalAwareness(text),
      resourceManagement: evaluateResourceManagement(text, characterSheet),
      teamCoordination: evaluateTeamCoordination(text),
      riskAssessment: evaluateRiskAssessment(text, hpPercent),
      overallTacticalScore: 0,
    };
    
    // Calculate overall score
    metrics.overallTacticalScore = Math.round(
      (metrics.situationalAwareness +
       metrics.resourceManagement +
       metrics.teamCoordination +
       metrics.riskAssessment) / 4 * 10
    ) / 10;
    
    // Emit warning if making very poor tactical decisions at low HP
    if (hpPercent <= 25 && metrics.riskAssessment < 4) {
      runtime.emitEvent?.('tactical_warning' as any, {
        issue: 'high_risk_at_low_hp',
        hpPercent,
        suggestion: 'Consider defensive actions, healing, or retreat',
        timestamp: new Date(),
      });
    }
    return undefined;
  },
};

function evaluateSituationalAwareness(text: string): number {
  const lowerText = text.toLowerCase();
  let score = 6;
  
  // Positive indicators
  const awarenessIndicators = [
    /\b(notice|see|observe|aware|scan)\b/i,
    /\b(position|flank|cover|terrain)\b/i,
    /\b(enemy|enemies|threat|danger)\b/i,
    /\b(ally|allies|party|team)\b/i,
  ];
  
  for (const pattern of awarenessIndicators) {
    if (pattern.test(lowerText)) score += 1;
  }
  
  // Negative indicators (acting without consideration)
  if (/\b(immediately|without thinking|blindly)\b/i.test(lowerText)) {
    score -= 1;
  }
  
  return Math.max(0, Math.min(10, score));
}

function evaluateResourceManagement(text: string, sheet: CharacterSheet): number {
  const lowerText = text.toLowerCase();
  let score = 7;
  
  // Check spell slot usage
  if (sheet.spellSlots) {
    const totalSlots = Object.values(sheet.spellSlots).reduce(
      (sum, slot) => sum + slot.current, 0
    );
    
    // Using high-level spells when low on slots
    if (/\b(cast|spell)\b/i.test(lowerText)) {
      if (totalSlots <= 2) {
        // Consider whether it's appropriate
        if (/\b(cantrip|0th level)\b/i.test(lowerText)) {
          score += 1; // Good - using cantrips when low
        } else {
          score -= 1; // Using slots when low - might be necessary but risky
        }
      }
    }
  }
  
  // Healing item usage
  if (/\b(potion|heal)\b/i.test(lowerText)) {
    const sheetHp = getHP(sheet);
    const hpPercent = (sheetHp.current / sheetHp.max) * 100;
    if (hpPercent <= 50) {
      score += 1; // Good use of healing
    } else if (hpPercent >= 90) {
      score -= 1; // Wasteful healing
    }
  }
  
  // Using daily/limited abilities
  if (/\b(action surge|rage|smite|channel divinity)\b/i.test(lowerText)) {
    // Generally fine - these should be used, not hoarded
    score += 0.5;
  }
  
  return Math.max(0, Math.min(10, score));
}

function evaluateTeamCoordination(text: string): number {
  const lowerText = text.toLowerCase();
  let score = 6;
  
  // Positive team indicators
  const teamIndicators = [
    /\b(help|assist|support|protect|defend)\b/i,
    /\b(ally|allies|party|together|we)\b/i,
    /\b(flank|coordinate|set up)\b/i,
    /\b(cover|heal|buff)\b/i,
  ];
  
  for (const pattern of teamIndicators) {
    if (pattern.test(lowerText)) score += 1;
  }
  
  // Negative solo indicators
  if (/\b(alone|by myself|solo|ignore.*party)\b/i.test(lowerText)) {
    score -= 2;
  }
  
  return Math.max(0, Math.min(10, score));
}

function evaluateRiskAssessment(text: string, hpPercent: number): number {
  const lowerText = text.toLowerCase();
  let score = 7;
  
  // Aggressive actions
  const aggressivePatterns = [
    /\b(charge|rush|attack|engage)\b/i,
    /\b(reckless|bold|aggressive)\b/i,
  ];
  
  // Defensive actions
  const defensivePatterns = [
    /\b(dodge|defend|retreat|disengage)\b/i,
    /\b(heal|potion|rest|careful)\b/i,
    /\b(cover|hide|avoid)\b/i,
  ];
  
  let isAggressive = false;
  let isDefensive = false;
  
  for (const pattern of aggressivePatterns) {
    if (pattern.test(lowerText)) isAggressive = true;
  }
  
  for (const pattern of defensivePatterns) {
    if (pattern.test(lowerText)) isDefensive = true;
  }
  
  // Evaluate based on HP
  if (hpPercent <= 25) {
    // Low HP - defensive is good
    if (isDefensive) score += 2;
    if (isAggressive && !isDefensive) score -= 3;
  } else if (hpPercent <= 50) {
    // Medium HP - balanced approach
    if (isDefensive) score += 1;
    if (isAggressive) score += 0; // Neutral
  } else {
    // High HP - aggression is fine
    if (isAggressive) score += 1;
    if (isDefensive && hpPercent >= 90) score -= 0.5; // Overly cautious
  }
  
  return Math.max(0, Math.min(10, score));
}

export default tacticalDecisionEvaluator;
