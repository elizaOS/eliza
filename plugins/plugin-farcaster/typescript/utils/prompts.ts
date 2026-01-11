/**
 * Prompt utilities for formatting casts and timelines.
 */

import type { Character } from "@elizaos/core";
import type { Cast } from "../types";

/**
 * Format a cast for display.
 */
export const formatCast = (cast: Cast): string => {
  return `ID: ${cast.hash}
    From: ${cast.profile.name} (@${cast.profile.username})${cast.inReplyTo ? `\nIn reply to: ${cast.inReplyTo.fid}` : ""}
Text: ${cast.text}`;
};

/**
 * Format a timeline for display.
 */
export const formatTimeline = (character: Character, timeline: Cast[]): string =>
  `# ${character.name}'s Home Timeline
${timeline.map(formatCast).join("\n")}
`;
