/**
 * Character Prompt Helper
 *
 * Extracts character personality traits for use in social media post generation.
 * Provides a simplified interface for getting character voice/style without
 * needing the full elizaOS runtime.
 */

import { logger } from "@/lib/utils/logger";
import { charactersService } from "./characters/characters";

/**
 * Fisher-Yates shuffle algorithm for unbiased random sampling.
 * Returns a new shuffled array without modifying the original.
 */
function shuffleArray<T>(array: T[]): T[] {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

/**
 * Get random sample from array using Fisher-Yates shuffle.
 */
function getRandomSample<T>(array: T[], count: number): T[] {
  return shuffleArray(array).slice(0, count);
}

export interface CharacterPromptContext {
  name: string;
  bio: string;
  adjectives: string[];
  topics: string[];
  postExamples: string[];
  postStyle: string[];
  allStyle: string[];
}

/**
 * Get character personality context for social media post generation.
 * Returns null if character not found.
 */
export async function getCharacterPromptContext(
  characterId: string,
): Promise<CharacterPromptContext | null> {
  const character = await charactersService.getById(characterId);

  if (!character) {
    logger.warn("[CharacterPromptHelper] Character not found", { characterId });
    return null;
  }

  const bio = Array.isArray(character.bio) ? character.bio.join(" ") : character.bio || "";

  const style = character.style || {};
  const postStyle = style.post || [];
  const allStyle = style.all || [];

  const context = {
    name: character.name,
    bio,
    adjectives: character.adjectives || [],
    topics: character.topics || [],
    postExamples: character.post_examples || [],
    postStyle,
    allStyle,
  };

  // Log detailed character context for debugging
  logger.info("[CharacterPromptHelper] Loaded character context", {
    characterId,
    name: context.name,
    bioLength: context.bio.length,
    adjectiveCount: context.adjectives.length,
    topicCount: context.topics.length,
    postExampleCount: context.postExamples.length,
    styleCount: context.postStyle.length + context.allStyle.length,
  });

  return context;
}

/**
 * Build a system prompt section for character-voiced content generation.
 * Used by Twitter, Discord, Telegram automation services.
 */
export function buildCharacterSystemPrompt(context: CharacterPromptContext): string {
  const parts: string[] = [];

  parts.push(`You are ${context.name}.`);

  if (context.bio) {
    parts.push(`About you: ${context.bio}`);
  }

  if (context.adjectives.length > 0) {
    const selectedAdjectives = getRandomSample(context.adjectives, 5);
    parts.push(`Your personality: ${selectedAdjectives.join(", ")}`);
  }

  if (context.topics.length > 0) {
    const selectedTopics = getRandomSample(context.topics, 5);
    parts.push(`Topics you enjoy: ${selectedTopics.join(", ")}`);
  }

  const styleGuidelines = [...context.postStyle, ...context.allStyle];
  if (styleGuidelines.length > 0) {
    const selectedStyles = getRandomSample(styleGuidelines, 5);
    parts.push(`Your writing style: ${selectedStyles.join("; ")}`);
  }

  if (context.postExamples.length > 0) {
    const examples = getRandomSample(context.postExamples, 3);
    parts.push(`Example posts you've written:\n${examples.map((ex) => `- "${ex}"`).join("\n")}`);
  }

  const prompt = parts.join("\n\n");

  // Log the generated prompt for debugging
  logger.debug("[CharacterPromptHelper] Built character prompt", {
    name: context.name,
    promptLength: prompt.length,
    promptPreview: `${prompt.substring(0, 200)}...`,
  });

  return prompt;
}
