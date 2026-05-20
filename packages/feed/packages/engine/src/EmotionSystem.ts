/**
 * Emotion System for Feed
 *
 * @module engine/EmotionSystem
 *
 * @description
 * Translates numeric mood values and luck levels into rich emotional descriptions
 * for LLM prompts. Creates context strings that influence how NPCs react to events
 * and generate social media posts.
 *
 * **Key Features:**
 * - Mood-to-emotion mapping with intensity levels
 * - Luck descriptions affecting NPC behavior
 * - Relationship modifiers for inter-NPC interactions
 * - Context generation for LLM prompts
 *
 * **Used By:**
 * - FeedGenerator: Adds emotional context to post generation
 * - GameEngine: Updates mood based on events and trading outcomes
 * - MarketDecisionEngine: Influences NPC trading decisions
 *
 * @example
 * ```typescript
 * import { moodToEmotion, generateActorContext } from './EmotionSystem';
 *
 * const state = moodToEmotion(0.8); // Very positive
 * // => { emotion: 'euphoric', intensity: 'extremely', description: 'overjoyed, excited, optimistic' }
 *
 * const context = generateActorContext(0.8, 'high', 'actor-2', relationships, 'actor-1');
 * // => "Current mood: extremely euphoric (overjoyed, excited, optimistic)\n..."
 * ```
 */

import type { ActorConnection, ActorRelationship } from './types/shared';

/**
 * Emotional state description
 *
 * @interface EmotionalState
 *
 * @property emotion - Primary emotion name (e.g., 'euphoric', 'furious')
 * @property intensity - Intensity modifier (e.g., 'slightly', 'extremely')
 * @property description - Rich description of the emotional state for LLM context
 */
export interface EmotionalState {
  emotion: string;
  intensity: string;
  description: string;
}

/**
 * Convert mood value to emotional state description
 *
 * @param mood - Numeric mood value from -1 (worst) to 1 (best)
 * @returns Structured emotional state with emotion, intensity, and description
 *
 * @description
 * Maps numeric mood values to rich emotional states that can be used in LLM prompts.
 * The emotion is determined by mood value ranges, and intensity is based on absolute value.
 *
 * **Mood Scale:**
 * - `0.7 to 1.0`: euphoric (overjoyed, excited, optimistic)
 * - `0.4 to 0.7`: happy (pleased, content, positive)
 * - `0.1 to 0.4`: content (satisfied, calm, neutral-positive)
 * - `-0.1 to 0.1`: neutral (balanced, indifferent, stable)
 * - `-0.4 to -0.1`: annoyed (irritated, bothered, slightly negative)
 * - `-0.7 to -0.4`: upset (frustrated, disappointed, negative)
 * - `-1.0 to -0.7`: furious (enraged, deeply negative, volatile)
 *
 * **Intensity Levels:**
 * - `abs(mood) < 0.3`: slightly
 * - `abs(mood) < 0.6`: moderately
 * - `abs(mood) >= 0.6`: extremely
 *
 * @usage
 * Used by FeedGenerator and GameEngine to create emotional context for NPCs.
 *
 * @example
 * ```typescript
 * const state = moodToEmotion(0.8);
 * // => { emotion: 'euphoric', intensity: 'extremely', description: 'overjoyed, excited, optimistic' }
 *
 * const sadState = moodToEmotion(-0.5);
 * // => { emotion: 'upset', intensity: 'moderately', description: 'frustrated, disappointed, negative' }
 * ```
 */
export function moodToEmotion(mood: number): EmotionalState {
  // Clamp mood to valid range [-1, 1]
  const clampedMood = Math.max(-1, Math.min(1, mood));

  // Determine intensity based on absolute value
  const absValue = Math.abs(clampedMood);
  let intensity: string;
  if (absValue < 0.3) intensity = 'slightly';
  else if (absValue < 0.6) intensity = 'moderately';
  else intensity = 'extremely';

  // Determine emotion based on value and sign
  let emotion: string;
  let description: string;

  if (clampedMood >= 0.7) {
    emotion = 'euphoric';
    description = 'overjoyed, excited, optimistic';
  } else if (clampedMood >= 0.4) {
    emotion = 'happy';
    description = 'pleased, content, positive';
  } else if (clampedMood >= 0.1) {
    emotion = 'content';
    description = 'satisfied, calm, neutral-positive';
  } else if (clampedMood >= -0.1) {
    emotion = 'neutral';
    description = 'balanced, indifferent, stable';
  } else if (clampedMood >= -0.4) {
    emotion = 'annoyed';
    description = 'irritated, bothered, slightly negative';
  } else if (clampedMood >= -0.7) {
    emotion = 'upset';
    description = 'frustrated, disappointed, negative';
  } else {
    emotion = 'furious';
    description = 'enraged, deeply negative, volatile';
  }

  return {
    emotion,
    intensity,
    description,
  };
}

/**
 * Get relationship modifier for NPC responses
 *
 * @param relationship - Relationship type (e.g., 'ally', 'rival', 'enemy')
 * @returns Object containing behavior modifier string and sentiment bonus value
 *
 * @description
 * Maps relationship types to response modifiers and sentiment adjustments for LLM prompts.
 * Used when NPCs interact with or reference other NPCs in posts and group chats.
 *
 * **Relationship Modifiers:**
 * - `friend`: friendly and warm (+0.4 sentiment)
 * - `ally`: supportive and positive (+0.3 sentiment)
 * - `advisor`: helpful and constructive (+0.2 sentiment)
 * - `source`: informative but cautious (+0.1 sentiment)
 * - `neutral`: balanced and objective (0 sentiment)
 * - `critic`: skeptical and questioning (-0.2 sentiment)
 * - `rival`: competitive and challenging (-0.3 sentiment)
 * - `enemy`: hostile and antagonistic (-0.5 sentiment)
 * - `hates`: deeply negative and dismissive (-0.6 sentiment)
 *
 * @usage
 * Used by FeedGenerator to adjust NPC tone when posting about related actors.
 *
 * @example
 * ```typescript
 * const rivalMod = getRelationshipModifier('rival');
 * // => { modifier: 'competitive and challenging', sentimentBonus: -0.3 }
 *
 * const allyMod = getRelationshipModifier('ally');
 * // => { modifier: 'supportive and positive', sentimentBonus: 0.3 }
 * ```
 */
export function getRelationshipModifier(relationship: string): {
  modifier: string;
  sentimentBonus: number;
} {
  const relationshipMap: Record<
    string,
    { modifier: string; sentimentBonus: number }
  > = {
    ally: { modifier: 'supportive and positive', sentimentBonus: 0.3 },
    friend: { modifier: 'friendly and warm', sentimentBonus: 0.4 },
    advisor: { modifier: 'helpful and constructive', sentimentBonus: 0.2 },
    source: { modifier: 'informative but cautious', sentimentBonus: 0.1 },
    neutral: { modifier: 'balanced and objective', sentimentBonus: 0 },
    critic: { modifier: 'skeptical and questioning', sentimentBonus: -0.2 },
    rival: { modifier: 'competitive and challenging', sentimentBonus: -0.3 },
    enemy: { modifier: 'hostile and antagonistic', sentimentBonus: -0.5 },
    hates: { modifier: 'deeply negative and dismissive', sentimentBonus: -0.6 },
  };

  return (
    relationshipMap[relationship.toLowerCase()] || relationshipMap['neutral']!
  );
}

/**
 * Convert luck level to descriptive text
 *
 * @param luck - Luck level ('low', 'medium', or 'high')
 * @returns Human-readable description of the luck state
 *
 * @description
 * Maps luck levels to descriptions that influence NPC behavior and outcomes.
 * Used in LLM prompts to add variety to NPC personalities and actions.
 *
 * **Luck Descriptions:**
 * - `low`: things going wrong, unlucky streak
 * - `medium`: normal circumstances, balanced luck
 * - `high`: things going well, lucky streak
 *
 * @usage
 * Combined with mood to create complete emotional context for NPCs.
 *
 * @example
 * ```typescript
 * const desc = luckToDescription('high');
 * // => "things going well, lucky streak"
 *
 * const badDesc = luckToDescription('low');
 * // => "things going wrong, unlucky streak"
 * ```
 */
export function luckToDescription(luck: 'low' | 'medium' | 'high'): string {
  const luckMap = {
    low: 'things going wrong, unlucky streak',
    medium: 'normal circumstances, balanced luck',
    high: 'things going well, lucky streak',
  };

  return luckMap[luck];
}

/**
 * Generate complete emotional context string for LLM prompts
 *
 * @param mood - Numeric mood value from -1 to 1
 * @param luck - Luck level ('low', 'medium', or 'high')
 * @param targetActorId - Optional ID of actor being responded to or referenced
 * @param relationships - Optional array of actor relationships (supports both formats)
 * @param actorId - ID of the actor generating content (required if targetActorId provided)
 * @returns Formatted context string for LLM prompt injection
 *
 * @description
 * Creates a rich context string combining mood, luck, and relationship information
 * for use in LLM prompts. This context influences how NPCs generate posts, chat
 * messages, and react to events.
 *
 * **Features:**
 * - Converts numeric mood to descriptive emotional state
 * - Adds luck description
 * - Includes relationship context when interacting with specific actors
 * - Supports both ActorRelationship (new) and deprecated ActorConnection formats
 *
 * **Generated Context Format:**
 * ```
 * Current mood: [intensity] [emotion] ([description])
 * Current luck: [luck description]
 * Relationship with [targetId]: [type] - be [modifier]
 * Context: [relationship history]
 * ```
 *
 * @usage
 * - FeedGenerator: Adds to post generation prompts
 * - GameEngine: Creates context for event reactions
 * - GroupChat: Influences chat message tone
 *
 * @example
 * ```typescript
 * // Simple context without relationships
 * const ctx = generateActorContext(0.6, 'high');
 * // => "Current mood: moderately happy (pleased, content, positive)\nCurrent luck: things going well, lucky streak"
 *
 * // Full context with relationship
 * const ctx = generateActorContext(
 *   0.3, 'medium', 'actor-2', relationships, 'actor-1'
 * );
 * // => "Current mood: slightly content (...)\nCurrent luck: ...\nRelationship with actor-2: rival - be competitive..."
 * ```
 */
export function generateActorContext(
  mood: number,
  luck: 'low' | 'medium' | 'high',
  targetActorId?: string,
  relationships?: ActorRelationship[] | ActorConnection[],
  actorId?: string
): string {
  const emotional = moodToEmotion(mood);
  const luckDesc = luckToDescription(luck);

  let context = `Current mood: ${emotional.intensity} ${emotional.emotion} (${emotional.description})
Current luck: ${luckDesc}`;

  // Add relationship context if responding to specific actor
  if (targetActorId && actorId && relationships && relationships.length > 0) {
    // Support both ActorRelationship and ActorConnection formats
    const firstItem = relationships[0];
    if (!firstItem) {
      return context;
    }

    const isNewFormat = 'actor1Id' in firstItem;

    if (isNewFormat) {
      // ActorRelationship format
      const relationship = (relationships as ActorRelationship[]).find(
        (r) =>
          (r.actor1Id === actorId && r.actor2Id === targetActorId) ||
          (r.actor2Id === actorId && r.actor1Id === targetActorId)
      );

      if (relationship) {
        const relMod = getRelationshipModifier(relationship.relationshipType);
        context += `
Relationship with ${targetActorId}: ${relationship.relationshipType} - be ${relMod.modifier}
Context: ${relationship.history || 'No additional context'}`;
      }
    } else {
      // ActorConnection format
      const relationship = (relationships as ActorConnection[]).find(
        (r) =>
          (r.actor1 === actorId && r.actor2 === targetActorId) ||
          (r.actor2 === actorId && r.actor1 === targetActorId)
      );

      if (relationship) {
        const relMod = getRelationshipModifier(relationship.relationship);
        context += `
Relationship with ${targetActorId}: ${relationship.relationship} - be ${relMod.modifier}
Context: ${relationship.context}`;
      }
    }
  }

  return context;
}
