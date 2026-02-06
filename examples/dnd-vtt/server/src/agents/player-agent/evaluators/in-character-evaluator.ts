/**
 * In-Character Evaluator
 * Assesses whether player responses stay in character
 */

import type { Evaluator, IAgentRuntime, Memory, State } from '@elizaos/core';
import type { CharacterSheet } from '../../../types';
import type { PersonalityArchetype } from '../index';

export interface InCharacterMetrics {
  voiceConsistency: number;    // 0-10: Matches established character voice
  personalityMatch: number;    // 0-10: Actions align with personality
  classAppropriate: number;    // 0-10: Uses class abilities appropriately
  staysInFirstPerson: boolean;
  usesMetagaming: boolean;
  overallScore: number;
}

export const inCharacterEvaluator: Evaluator = {
  name: 'inCharacter',
  description: 'Evaluates whether responses stay true to the character',
  
  alwaysRun: true,
  
  similes: [
    'character voice',
    'roleplay quality',
    'in character',
    'personality match',
  ],
  
  examples: [
    {
      prompt: 'Chaotic character makes a careful, methodical plan',
      messages: [
        {
          name: 'player',
          content: {
            text: 'I carefully analyze the situation and create a detailed 10-step plan.',
          },
        },
      ],
      outcome: 'Low personality match - chaotic characters act impulsively.',
    },
  ],
  
  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    const role = await runtime.getSetting('role');
    return role === 'player';
  },
  
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State
  ) => {
    const text = typeof message.content === 'string'
      ? message.content
      : message.content?.text;
    
    if (!text || text.length < 10) {
      return undefined;
    }
    
    const characterSheet = await runtime.getSetting('characterSheet') as CharacterSheet | null;
    const personality = await runtime.getSetting('personality') as { archetype?: PersonalityArchetype } | null;
    
    if (!characterSheet) {
      return undefined;
    }
    
    const metrics: InCharacterMetrics = {
      voiceConsistency: 7, // Default moderate
      personalityMatch: 7,
      classAppropriate: 7,
      staysInFirstPerson: true,
      usesMetagaming: false,
      overallScore: 7,
    };
    
    // Check first person usage
    const thirdPersonIndicators = [
      /\b(he|she|they)\s+(do|does|did|would|should|could|attack|move|cast)/i,
      new RegExp(`\\b${characterSheet.name}\\s+(do|does|did|would)`, 'i'),
    ];
    
    for (const pattern of thirdPersonIndicators) {
      if (pattern.test(text)) {
        metrics.staysInFirstPerson = false;
        metrics.voiceConsistency -= 3;
        break;
      }
    }
    
    // Check for first person usage (good)
    if (/\bI\s+(do|did|would|should|could|attack|move|cast|say|ask|try)/i.test(text)) {
      metrics.voiceConsistency += 1;
    }
    
    // Check for metagaming
    const metagamingPatterns = [
      /\b(hit points?|HP|AC|DC|modifier|bonus|d20|d\d+)\b/i,
      /\b(player|DM|dungeon master|game|session|character sheet)\b/i,
      /\b(optimal|meta|min-max)\b/i,
      /\b(out of character|OOC)\b/i,
    ];
    
    for (const pattern of metagamingPatterns) {
      if (pattern.test(text)) {
        metrics.usesMetagaming = true;
        metrics.voiceConsistency -= 2;
        break;
      }
    }
    
    // Check personality alignment
    if (personality?.archetype) {
      metrics.personalityMatch = evaluatePersonalityMatch(text, personality.archetype);
    }
    
    // Check class-appropriate behavior
    metrics.classAppropriate = evaluateClassBehavior(text, characterSheet.class);
    
    // Calculate overall score
    let overall = (metrics.voiceConsistency + metrics.personalityMatch + metrics.classAppropriate) / 3;
    
    if (!metrics.staysInFirstPerson) overall -= 1;
    if (metrics.usesMetagaming) overall -= 1;
    
    metrics.overallScore = Math.max(0, Math.min(10, Math.round(overall * 10) / 10));
    
    // Store for tracking
    const historyRaw = await runtime.getSetting('inCharacterHistory');
    const history = (historyRaw ? JSON.parse(historyRaw as string) : []) as InCharacterMetrics[];
    history.push(metrics);
    if (history.length > 20) history.shift();
    await runtime.setSetting('inCharacterHistory', JSON.stringify(history));
    
    // Warn if score is low
    if (metrics.overallScore < 5) {
      runtime.emitEvent?.('roleplay_warning' as any, {
        issue: 'low_in_character_score',
        score: metrics.overallScore,
        suggestions: generateSuggestions(metrics),
        timestamp: new Date(),
      });
    }
    return undefined;
  },
};

function evaluatePersonalityMatch(text: string, archetype: PersonalityArchetype): number {
  const lowerText = text.toLowerCase();
  let score = 7; // Default moderate
  
  const archetypeIndicators: Record<PersonalityArchetype, { positive: RegExp[]; negative: RegExp[] }> = {
    heroic: {
      positive: [/\b(protect|save|defend|help|brave)\b/i, /\b(hero|noble|duty)\b/i],
      negative: [/\b(run away|abandon|coward)\b/i],
    },
    cautious: {
      positive: [/\b(careful|check|wait|plan|think)\b/i, /\b(trap|danger|risk)\b/i],
      negative: [/\b(charge|rush|reckless)\b/i],
    },
    chaotic: {
      positive: [/\b(spontaneous|wild|crazy|fun|chaos)\b/i, /\b(impulse|sudden|random)\b/i],
      negative: [/\b(careful plan|methodical|organized)\b/i],
    },
    scholar: {
      positive: [/\b(study|research|knowledge|learn|understand)\b/i, /\b(book|tome|history)\b/i],
      negative: [/\b(don't care|boring|waste of time)\b/i],
    },
    mercenary: {
      positive: [/\b(gold|coin|payment|profit|deal)\b/i, /\b(negotiate|contract|reward)\b/i],
      negative: [/\b(free|charity|no reward)\b/i],
    },
    noble: {
      positive: [/\b(honor|duty|oath|code|dignity)\b/i, /\b(proper|respectful|tradition)\b/i],
      negative: [/\b(cheat|lie|dishonorable)\b/i],
    },
    trickster: {
      positive: [/\b(trick|prank|joke|clever|witty)\b/i, /\b(laugh|funny|mischief)\b/i],
      negative: [/\b(serious|formal|proper)\b/i],
    },
    zealot: {
      positive: [/\b(faith|god|divine|sacred|righteous)\b/i, /\b(believe|conviction|cause)\b/i],
      negative: [/\b(doubt|question|compromise)\b/i],
    },
  };
  
  const indicators = archetypeIndicators[archetype];
  if (!indicators) return score;
  
  for (const pattern of indicators.positive) {
    if (pattern.test(lowerText)) score += 1;
  }
  
  for (const pattern of indicators.negative) {
    if (pattern.test(lowerText)) score -= 2;
  }
  
  return Math.max(0, Math.min(10, score));
}

function evaluateClassBehavior(text: string, characterClass: string): number {
  const lowerText = text.toLowerCase();
  let score = 7;
  
  const classIndicators: Record<string, { positive: RegExp[]; negative: RegExp[] }> = {
    Barbarian: {
      positive: [/\b(rage|strength|smash|crush|fury)\b/i],
      negative: [/\b(delicate|subtle|finesse)\b/i],
    },
    Wizard: {
      positive: [/\b(spell|magic|arcane|study|knowledge)\b/i],
      negative: [/\b(brute force|charge in|no magic)\b/i],
    },
    Rogue: {
      positive: [/\b(sneak|stealth|hidden|shadow|backstab)\b/i],
      negative: [/\b(loud|obvious|direct assault)\b/i],
    },
    Cleric: {
      positive: [/\b(pray|heal|divine|faith|god)\b/i],
      negative: [/\b(forsake|abandon faith)\b/i],
    },
    Fighter: {
      positive: [/\b(weapon|attack|defend|tactical|formation)\b/i],
      negative: [],
    },
    Paladin: {
      positive: [/\b(smite|oath|righteous|protect|honor)\b/i],
      negative: [/\b(break oath|dishonorable)\b/i],
    },
  };
  
  const indicators = classIndicators[characterClass];
  if (!indicators) return score;
  
  for (const pattern of indicators.positive) {
    if (pattern.test(lowerText)) score += 1;
  }
  
  for (const pattern of indicators.negative) {
    if (pattern.test(lowerText)) score -= 1;
  }
  
  return Math.max(0, Math.min(10, score));
}

function generateSuggestions(metrics: InCharacterMetrics): string[] {
  const suggestions: string[] = [];
  
  if (!metrics.staysInFirstPerson) {
    suggestions.push('Use first person ("I do...") instead of third person');
  }
  
  if (metrics.usesMetagaming) {
    suggestions.push('Avoid game mechanics terms - describe actions narratively');
  }
  
  if (metrics.personalityMatch < 5) {
    suggestions.push('Consider how your character\'s personality would react');
  }
  
  if (metrics.classAppropriate < 5) {
    suggestions.push('Think about your class\'s typical approach to problems');
  }
  
  return suggestions;
}

export default inCharacterEvaluator;
