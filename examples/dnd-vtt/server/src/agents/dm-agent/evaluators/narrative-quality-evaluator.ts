/**
 * Narrative Quality Evaluator
 * Assesses the quality and consistency of DM narrative outputs
 */

import type { Evaluator, IAgentRuntime, Memory, State } from '@elizaos/core';

export interface NarrativeMetrics {
  descriptiveness: number;       // 0-10: How vivid and detailed
  consistency: number;           // 0-10: Matches established world/tone
  engagement: number;            // 0-10: Hooks and dramatic tension
  pacing: number;                // 0-10: Appropriate length and flow
  sensoryDetails: number;        // 0-10: Appeals to multiple senses
  characterVoice: number;        // 0-10: NPC voices are distinct
  overallScore: number;          // Average of all metrics
}

export const narrativeQualityEvaluator: Evaluator = {
  name: 'narrativeQuality',
  description: 'Evaluates the quality of DM narrative outputs',
  
  alwaysRun: false, // Only run when explicitly triggered
  
  similes: [
    'check narrative',
    'evaluate story',
    'assess description',
    'review dm output',
  ],
  
  examples: [
    {
      prompt: 'DM described a tavern scene briefly',
      messages: [
        {
          name: 'dm',
          content: {
            text: 'You enter the Rusty Anchor tavern.',
          },
        },
      ],
      outcome: 'Low descriptiveness - needs more sensory details and atmosphere.',
    },
    {
      prompt: 'DM described a tavern scene with rich detail',
      messages: [
        {
          name: 'dm',
          content: {
            text: 'The Rusty Anchor hits you with a wave of warmth and noise as you push through the weathered oak door. Pipe smoke hangs in lazy ribbons beneath soot-stained rafters, while the crackling hearth throws dancing shadows across faces both familiar and strange. The bartender, a scarred half-orc named Grella, looks up from polishing a tankard and gives you a nod that might be recognition or warning.',
          },
        },
      ],
      outcome: 'High quality - rich sensory details, character introduction, atmosphere established.',
    },
  ],
  
  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    // Only evaluate DM narrative outputs
    const role = runtime.getSetting('role');
    const content = message.content as Record<string, unknown> | undefined;
    return role === 'dm' && content?.type === 'narrative';
  },
  
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State
  ) => {
    const text = typeof message.content === 'string' 
      ? message.content 
      : message.content?.text;
    
    if (!text || text.length < 20) {
      return undefined;
    }
    
    // Analyze the narrative
    const metrics = analyzeNarrative(text);
    
    // Store metrics for tracking over time
    const raw = runtime.getSetting('narrativeMetricsHistory');
    let previousMetrics: NarrativeMetrics[] = [];
    if (raw && typeof raw === 'string') {
      try {
        previousMetrics = JSON.parse(raw) as NarrativeMetrics[];
      } catch {
        previousMetrics = [];
      }
    }
    previousMetrics.push(metrics);
    
    // Keep last 50 evaluations
    if (previousMetrics.length > 50) {
      previousMetrics.shift();
    }
    
    runtime.setSetting('narrativeMetricsHistory', JSON.stringify(previousMetrics));
    
    // Log if quality is low
    if (metrics.overallScore < 5) {
      console.warn('Low narrative quality detected:', metrics);
    }
    
    return {
      success: true,
      data: { metrics },
    };
  },
};

function analyzeNarrative(text: string): NarrativeMetrics {
  const metrics: NarrativeMetrics = {
    descriptiveness: 0,
    consistency: 0,
    engagement: 0,
    pacing: 0,
    sensoryDetails: 0,
    characterVoice: 0,
    overallScore: 0,
  };
  
  // Analyze descriptiveness based on adjectives and descriptive phrases
  const descriptiveWords = text.match(/\b(ancient|weathered|gleaming|shadowy|massive|tiny|ornate|rustic|elegant|grim|bright|dark|cold|warm|damp|musty|sweet|bitter|sharp|soft|rough|smooth)\b/gi) || [];
  metrics.descriptiveness = Math.min(10, (descriptiveWords.length / Math.max(1, text.split(' ').length / 20)) * 10);
  
  // Analyze sensory details
  const sightWords = text.match(/\b(see|look|appear|gleam|shine|shadow|light|dark|color|bright)\b/gi) || [];
  const soundWords = text.match(/\b(hear|sound|noise|whisper|roar|crack|rumble|echo|silent|loud)\b/gi) || [];
  const smellWords = text.match(/\b(smell|scent|aroma|stench|fragrant|musty|fresh|rotten)\b/gi) || [];
  const touchWords = text.match(/\b(feel|touch|rough|smooth|cold|warm|wet|dry|soft|hard)\b/gi) || [];
  const tasteWords = text.match(/\b(taste|flavor|sweet|bitter|sour|salty|savory)\b/gi) || [];
  
  const sensesEngaged = [
    sightWords.length > 0,
    soundWords.length > 0,
    smellWords.length > 0,
    touchWords.length > 0,
    tasteWords.length > 0,
  ].filter(Boolean).length;
  
  metrics.sensoryDetails = sensesEngaged * 2;
  
  // Analyze engagement (hooks, questions, tension)
  const engagementIndicators = [
    /\?/.test(text), // Questions
    /\.{3}|\u{2014}/u.test(text), // Dramatic pauses
    /\b(suddenly|but|however|yet|meanwhile)\b/i.test(text), // Tension words
    /\b(you notice|you see|you hear|catches your attention)\b/i.test(text), // Direct engagement
  ].filter(Boolean).length;
  
  metrics.engagement = engagementIndicators * 2.5;
  
  // Analyze pacing based on sentence variety and length
  const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0);
  const avgSentenceLength = sentences.reduce((sum, s) => sum + s.split(' ').length, 0) / Math.max(1, sentences.length);
  
  // Good pacing: varied sentence length, not too short or too long
  if (avgSentenceLength >= 8 && avgSentenceLength <= 20) {
    metrics.pacing = 8;
  } else if (avgSentenceLength >= 5 && avgSentenceLength <= 25) {
    metrics.pacing = 6;
  } else {
    metrics.pacing = 4;
  }
  
  // Bonus for paragraph breaks indicating pacing awareness
  if (text.includes('\n\n')) {
    metrics.pacing = Math.min(10, metrics.pacing + 1);
  }
  
  // Analyze character voice (dialogue variety)
  const dialogueMatches = text.match(/"[^"]+"/g) || [];
  if (dialogueMatches.length > 0) {
    metrics.characterVoice = Math.min(10, 5 + dialogueMatches.length);
  } else {
    metrics.characterVoice = 5; // Neutral if no dialogue present
  }
  
  // Consistency is harder to measure without context - default to moderate
  // In a full implementation, this would compare against established world state
  metrics.consistency = 7;
  
  // Calculate overall score
  const scores = [
    metrics.descriptiveness,
    metrics.sensoryDetails,
    metrics.engagement,
    metrics.pacing,
    metrics.characterVoice,
    metrics.consistency,
  ];
  
  metrics.overallScore = Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10;
  
  return metrics;
}

export default narrativeQualityEvaluator;
