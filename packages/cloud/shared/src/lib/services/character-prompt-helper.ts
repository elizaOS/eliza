/**
 * Character Prompt Helper
 *
 * Extracts character personality traits for use in social media post generation.
 * Provides a simplified interface for getting character voice/style without
 * needing the full elizaOS runtime.
 */

import { logger } from "../utils/logger";
import { charactersService } from "./characters/characters";

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

  // Every list field below is caller-supplied jsonb stored verbatim (the
  // character POST/PUT routes don't validate shapes), so any of them can be a
  // non-array JSON value. buildCharacterSystemPrompt spreads them (`[...arr]`
  // via getRandomSample and the style merge), which throws on truthy
  // non-iterables — one malformed character must not 500 the social-automation
  // routes that post in its voice (#13637 class).
  const style = character.style || {};
  const postStyle = Array.isArray(style.post) ? style.post : [];
  const allStyle = Array.isArray(style.all) ? style.all : [];

  const context = {
    name: character.name,
    bio,
    adjectives: Array.isArray(character.adjectives) ? character.adjectives : [],
    topics: Array.isArray(character.topics) ? character.topics : [],
    postExamples: Array.isArray(character.post_examples) ? character.post_examples : [],
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
    parts.push(`Your personality: ${context.adjectives.join(", ")}`);
  }

  if (context.topics.length > 0) {
    parts.push(`Topics you enjoy: ${context.topics.join(", ")}`);
  }

  const styleGuidelines = [...context.postStyle, ...context.allStyle];
  if (styleGuidelines.length > 0) {
    parts.push(`Your writing style: ${styleGuidelines.join("; ")}`);
  }

  if (context.postExamples.length > 0) {
    parts.push(
      `Example posts you've written:\n${context.postExamples.map((ex) => `- "${ex}"`).join("\n")}`,
    );
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
