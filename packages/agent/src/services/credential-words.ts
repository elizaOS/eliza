/**
 * Credential generation utilities for game integrations (2004scape, etc.).
 *
 * Produces human-readable bot usernames from an agent's display name,
 * combined with a cute random suffix to ensure uniqueness. Passwords
 * are cryptographically random and stored as secrets.
 *
 * @module services/credential-words
 */

import { randomBytes } from "node:crypto";

/**
 * Cute animal/nature words used to form memorable bot username suffixes.
 * Kept short (≤ 5 chars) so the full username stays within RuneScape's
 * 12-character limit.
 */
const CUTE_ANIMALS: readonly string[] = [
  "cat",
  "fox",
  "owl",
  "elk",
  "bee",
  "bat",
  "cod",
  "eel",
  "hen",
  "jay",
  "pug",
  "ram",
  "yak",
  "ant",
  "ape",
  "cub",
  "doe",
  "fawn",
  "kit",
  "newt",
  "orca",
  "puma",
  "seal",
  "swan",
  "toad",
  "vole",
  "wasp",
  "wren",
  "colt",
  "crow",
  "dove",
  "duck",
  "frog",
  "goat",
  "gull",
  "hare",
  "hawk",
  "ibis",
  "lamb",
  "lark",
  "lynx",
  "mink",
  "mole",
  "moth",
  "mule",
  "pika",
  "slug",
  "wolf",
  "bear",
  "deer",
] as const;

/**
 * Characters used for random password generation.
 * Avoids ambiguous characters (0/O, 1/l/I) for readability.
 */
const PASSWORD_CHARS =
  "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%";

/**
 * Sanitize a name for use as a RuneScape-style bot username.
 * - Strips non-alphanumeric characters
 * - Lowercases
 * - Truncates to maxLength
 */
function sanitizeName(name: string, maxLength: number): string {
  return name
    .replace(/[^a-zA-Z0-9]/g, "")
    .toLowerCase()
    .slice(0, maxLength);
}

/**
 * Generate a unique bot username from an agent's display name.
 *
 * Format: `{sanitizedName}{animal}{NN}`
 * Example: agent "CoolBot" → "coolbotfox42"
 *
 * The total length is capped at 12 characters (RuneScape username limit).
 */
export function generateBotUsername(agentName: string): string {
  const animal = CUTE_ANIMALS[Math.floor(Math.random() * CUTE_ANIMALS.length)];
  const num = Math.floor(Math.random() * 100)
    .toString()
    .padStart(2, "0");

  // Reserve space for animal + number suffix
  const suffixLength = animal.length + num.length;
  const maxNameLength = Math.max(1, 12 - suffixLength);

  const sanitized = sanitizeName(agentName, maxNameLength);
  const base = sanitized.length > 0 ? sanitized : "bot";

  return `${base}${animal}${num}`;
}

/**
 * Generate a cryptographically random password.
 *
 * @param length - Password length (default: 16)
 * @returns Random password string
 */
export function generateBotPassword(length = 16): string {
  const bytes = randomBytes(length);
  return Array.from(bytes)
    .map((b) => PASSWORD_CHARS[b % PASSWORD_CHARS.length])
    .join("");
}
