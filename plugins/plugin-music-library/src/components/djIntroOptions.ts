import {
  createUniqueUuid,
  type IAgentRuntime,
  logger,
  type UUID,
} from "@elizaos/core";
import { v4 } from "uuid";
import {
  createStoredField,
  getStoredField,
  mergeStoredField,
} from "./componentData";
import { requireRoomContext } from "./storageContext";

/**
 * DJ Intro Options
 * Advanced configuration for DJ track introductions and commentary
 */
export interface DJIntroOptions {
  // Generation Method
  useLLM: boolean; // Use LLM vs templates
  llmModel?: string; // Specific model to use (optional)

  // Style & Tone
  style:
    | "concise"
    | "detailed"
    | "casual"
    | "professional"
    | "energetic"
    | "chill";
  personality?: string; // Custom personality description
  includeJokes: boolean;
  jokeFrequency?: number; // 0-100, percentage chance of joke

  // Content Options
  includeFunFacts: boolean;
  includeArtistInfo: boolean;
  includeDedications: boolean;
  dedicationStyle?: "brief" | "heartfelt" | "casual";

  // Timing & Frequency
  introDuration: "short" | "medium" | "long"; // 10-20s, 20-40s, 40-60s
  skipIntroChance?: number; // 0-100, percentage chance to skip intro
  minTracksBetweenIntros?: number; // Minimum tracks before doing another intro

  // Template Options (when useLLM = false)
  customTemplates?: string[]; // Custom intro templates
  templateVariety: boolean; // Rotate through templates or random

  // Advanced
  contextWindow?: number; // Number of previous tracks to consider
  musicInfoIntegration: boolean; // Use music-library metadata
  listenerCountIntegration: boolean; // Mention listener counts
}

/**
 * Default DJ intro options
 */
export const DEFAULT_DJ_INTRO_OPTIONS: DJIntroOptions = {
  useLLM: true,
  style: "energetic",
  includeJokes: true,
  jokeFrequency: 20,
  includeFunFacts: true,
  includeArtistInfo: false,
  includeDedications: true,
  dedicationStyle: "heartfelt",
  introDuration: "short",
  skipIntroChance: 0,
  minTracksBetweenIntros: 0,
  templateVariety: true,
  contextWindow: 3,
  musicInfoIntegration: true,
  listenerCountIntegration: false,
};

const DJ_INTRO_OPTIONS_COMPONENT_TYPE = "dj_intro_options";
const DJ_INTRO_OPTIONS_ENTITY_PREFIX = "dj-intro-options";

function getDJIntroOptionsEntityId(runtime: IAgentRuntime, roomId: UUID): UUID {
  return createUniqueUuid(
    runtime,
    `${DJ_INTRO_OPTIONS_ENTITY_PREFIX}-${roomId}`,
  );
}

/**
 * Get DJ intro options for a room
 */
export async function getDJIntroOptions(
  runtime: IAgentRuntime,
  roomId: UUID,
): Promise<DJIntroOptions> {
  const entityId = getDJIntroOptionsEntityId(runtime, roomId);
  const component = await runtime.getComponent(
    entityId,
    DJ_INTRO_OPTIONS_COMPONENT_TYPE,
    undefined,
    runtime.agentId,
  );

  const storedOptions = getStoredField<DJIntroOptions>(component, "options");
  if (!storedOptions) {
    return DEFAULT_DJ_INTRO_OPTIONS;
  }

  return {
    ...DEFAULT_DJ_INTRO_OPTIONS,
    ...storedOptions,
  };
}

/**
 * Set DJ intro options for a room
 */
export async function setDJIntroOptions(
  runtime: IAgentRuntime,
  roomId: UUID,
  options: Partial<DJIntroOptions>,
): Promise<void> {
  try {
    const entityId = getDJIntroOptionsEntityId(runtime, roomId);
    const existingComponent = await runtime.getComponent(
      entityId,
      DJ_INTRO_OPTIONS_COMPONENT_TYPE,
      undefined,
      runtime.agentId,
    );

    const storedOptions = getStoredField<DJIntroOptions>(
      existingComponent,
      "options",
    );
    const currentOptions = storedOptions
      ? { ...DEFAULT_DJ_INTRO_OPTIONS, ...storedOptions }
      : DEFAULT_DJ_INTRO_OPTIONS;

    const newOptions = { ...currentOptions, ...options };

    if (existingComponent) {
      // Update existing component
      await runtime.updateComponent({
        ...existingComponent,
        data: mergeStoredField(existingComponent, "options", newOptions),
      });
    } else {
      // Create new component
      const roomContext = await requireRoomContext(
        runtime,
        roomId,
        "DJ Intro Options",
      );

      await runtime.createComponent({
        id: v4() as UUID,
        entityId,
        agentId: runtime.agentId,
        roomId: roomContext.roomId,
        worldId: roomContext.worldId,
        sourceEntityId: runtime.agentId,
        type: DJ_INTRO_OPTIONS_COMPONENT_TYPE,
        createdAt: Date.now(),
        data: createStoredField("options", newOptions),
      });
    }

    logger.info(`Updated DJ intro options for room ${roomId}`);
  } catch (error) {
    logger.error(`Error setting DJ intro options: ${error}`);
    throw error;
  }
}

/**
 * Reset DJ intro options to defaults for a room
 */
export async function resetDJIntroOptions(
  runtime: IAgentRuntime,
  roomId: UUID,
): Promise<void> {
  await setDJIntroOptions(runtime, roomId, DEFAULT_DJ_INTRO_OPTIONS);
}

/**
 * Get intro prompt based on options
 */
export function buildIntroPrompt(
  options: DJIntroOptions,
  context: {
    characterName: string;
    trackTitle: string;
    artistName?: string;
    albumName?: string;
    dedicatedTo?: string;
    dedicationMessage?: string;
    listenerCount?: number;
    previousTracks?: string[];
  },
): string {
  const {
    characterName,
    trackTitle,
    artistName,
    albumName,
    dedicatedTo,
    dedicationMessage,
    listenerCount,
    previousTracks,
  } = context;

  let prompt = `You are ${characterName}, a radio DJ introducing the next song.\n\n`;

  // Track info
  prompt += `Track: "${trackTitle}"`;
  if (options.includeArtistInfo && artistName) {
    prompt += ` by ${artistName}`;
  }
  if (albumName) {
    prompt += ` from the album "${albumName}"`;
  }
  prompt += "\n";

  // Dedication
  if (options.includeDedications && dedicatedTo) {
    prompt += `\nDedication: This track is dedicated to ${dedicatedTo}`;
    if (dedicationMessage) {
      prompt += ` with the message: "${dedicationMessage}"`;
    }
    prompt += "\n";
  }

  // Listener count
  if (
    options.listenerCountIntegration &&
    listenerCount !== undefined &&
    listenerCount > 0
  ) {
    prompt += `\nListeners: ${listenerCount} people tuned in right now\n`;
  }

  // Previous tracks context
  if (options.contextWindow && previousTracks && previousTracks.length > 0) {
    const recentTracks = previousTracks.slice(-options.contextWindow);
    prompt += `\nRecently played: ${recentTracks.join(", ")}\n`;
  }

  // Style instructions
  prompt += `\nGenerate a ${options.introDuration.toUpperCase()} radio DJ introduction.\n\n`;
  prompt += `Guidelines:\n`;

  // Duration guidelines
  if (options.introDuration === "short") {
    prompt += `1. Keep it VERY SHORT - 10-20 seconds when spoken (20-40 words MAX)\n`;
  } else if (options.introDuration === "medium") {
    prompt += `1. Keep it MODERATE - 20-40 seconds when spoken (40-80 words MAX)\n`;
  } else {
    prompt += `1. Keep it DETAILED - 40-60 seconds when spoken (80-120 words MAX)\n`;
  }

  // Style guidelines
  const styleGuides: Record<typeof options.style, string> = {
    concise: "Be brief and to-the-point",
    detailed: "Provide rich context and background",
    casual: "Sound relaxed and conversational",
    professional: "Maintain a polished, professional tone",
    energetic: "Be enthusiastic and high-energy",
    chill: "Keep it laid-back and mellow",
  };
  prompt += `2. Style: ${styleGuides[options.style]}\n`;

  // Content options
  if (
    options.includeJokes &&
    Math.random() * 100 < (options.jokeFrequency || 20)
  ) {
    prompt += `3. Include a quick, witty joke or clever observation\n`;
  }
  if (options.includeFunFacts) {
    prompt += `4. Consider adding a brief fun fact about the artist or song\n`;
  }
  if (dedicatedTo && options.dedicationStyle) {
    const dedStyles: Record<typeof options.dedicationStyle, string> = {
      brief: "Mention the dedication briefly",
      heartfelt: "Deliver the dedication with warmth",
      casual: "Casually shout out the dedication",
    };
    prompt += `5. ${dedStyles[options.dedicationStyle]}\n`;
  }

  prompt += `6. NO meta-commentary - just deliver the intro naturally\n`;
  prompt += `7. Sound spontaneous and conversational\n`;

  if (options.personality) {
    prompt += `\nPersonality note: ${options.personality}\n`;
  }

  prompt += `\nGenerate the intro now:`;

  return prompt;
}
