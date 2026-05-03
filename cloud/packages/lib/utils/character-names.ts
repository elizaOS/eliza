/**
 * Character Name and Default Character Utilities
 */

import type { ElizaCharacter } from "@/lib/types/eliza-character";

const FIRST_NAMES = [
  "Nova",
  "Echo",
  "Pixel",
  "Byte",
  "Vector",
  "Cipher",
  "Nexus",
  "Flux",
  "Atlas",
  "Phoenix",
  "Orion",
  "Luna",
  "Aurora",
  "Iris",
  "Cleo",
  "Apollo",
  "Sage",
  "River",
  "Storm",
  "Ember",
  "Ash",
  "Sky",
  "Coral",
  "Frost",
  "Aria",
  "Felix",
  "Maya",
  "Leo",
  "Mira",
  "Kai",
  "Zara",
  "Quinn",
  "Stella",
  "Jasper",
  "Ruby",
  "Onyx",
  "Pearl",
  "Jade",
  "Opal",
  "Raven",
  "Zephyr",
  "Cosmo",
  "Astrid",
  "Blaze",
  "Lyra",
  "Solara",
  "Vega",
  "Nyx",
] as const;

/**
 * Generate a random first name for a new character.
 */
export function generateDefaultCharacterName(): string {
  return FIRST_NAMES[Math.floor(Math.random() * FIRST_NAMES.length)];
}

/**
 * Create a new default character with blank fields for user to fill in.
 */
export function createDefaultCharacter(): ElizaCharacter {
  return {
    name: "",
    username: "",
    bio: "",
    system: "",
    topics: [],
    adjectives: [],
    postExamples: [],
    plugins: [],
    settings: {},
    secrets: {},
    style: {},
    templates: {},
  };
}
