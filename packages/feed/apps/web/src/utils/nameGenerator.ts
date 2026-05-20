/**
 * Agent Name Generator
 *
 * Generates random, memorable names for AI trading agents.
 * Uses curated word lists organized by theme for variety.
 */

import { escapeRegex } from "@feed/shared";

// Agent name generation word lists
const NAME_PREFIXES = [
  // Greek letters
  "Alpha",
  "Beta",
  "Gamma",
  "Delta",
  "Epsilon",
  "Zeta",
  "Eta",
  "Theta",
  "Iota",
  "Kappa",
  "Lambda",
  "Mu",
  "Nu",
  "Xi",
  "Omicron",
  "Pi",
  "Rho",
  "Sigma",
  "Tau",
  "Upsilon",
  "Phi",
  "Chi",
  "Psi",
  "Omega",
  // Tech/Cyber
  "Quantum",
  "Neo",
  "Cyber",
  "Nexus",
  "Apex",
  "Vertex",
  "Pulse",
  "Flux",
  "Vector",
  "Helix",
  "Prism",
  "Matrix",
  "Cipher",
  "Binary",
  "Neural",
  // Nature/Elements
  "Nova",
  "Solar",
  "Lunar",
  "Stellar",
  "Cosmic",
  "Astral",
  "Phoenix",
  "Storm",
  "Thunder",
  "Frost",
  "Ember",
  "Shadow",
  "Dawn",
  "Dusk",
  // Power/Status
  "Iron",
  "Steel",
  "Titan",
  "Atlas",
  "Orion",
  "Vortex",
  "Blaze",
  "Spark",
  "Echo",
  "Phantom",
  "Specter",
  "Raven",
  "Falcon",
  "Hawk",
  "Eagle",
  // Abstract
  "Zen",
  "Aura",
  "Axiom",
  "Lumen",
  "Photon",
  "Quark",
  "Volt",
  "Arc",
] as const;

const NAME_SUFFIXES = [
  // Role-based
  "Trader",
  "Agent",
  "Bot",
  "AI",
  "Mind",
  "Brain",
  "Sage",
  "Oracle",
  // Technical
  "Core",
  "Node",
  "Edge",
  "Prime",
  "Pro",
  "Max",
  "Ultra",
  "Plus",
  "X",
  "Zero",
  "One",
  "Protocol",
  "System",
  "Engine",
  "Logic",
  // Abstract
  "Flow",
  "Wave",
  "Sync",
  "Link",
  "Net",
  "Hub",
  "Lab",
  "Works",
  "Force",
  "Drive",
  "Pulse",
  "Signal",
  "Stream",
  "Grid",
  "Mesh",
] as const;

export interface GeneratedAgentName {
  username: string;
  displayName: string;
}

/**
 * Generates a random agent name with a 1-word display name and 2-word username.
 * No numbers are appended by default — numbers are only added when the username
 * is already taken (handled by the username check hook).
 *
 * @returns Object with displayName (e.g., "Phoenix") and username (e.g., "phoenix_trader")
 *
 * @example
 * const { username, displayName } = generateAgentName();
 * // displayName: "Nova"
 * // username: "nova_oracle"
 */
export function generateAgentName(): GeneratedAgentName {
  // Arrays are non-empty (defined above), so these are guaranteed to exist
  const prefix =
    NAME_PREFIXES[Math.floor(Math.random() * NAME_PREFIXES.length)]!;
  const suffix =
    NAME_SUFFIXES[Math.floor(Math.random() * NAME_SUFFIXES.length)]!;

  const displayName = prefix;
  const username = `${prefix.toLowerCase()}_${suffix.toLowerCase()}`;

  return { username, displayName };
}

export { escapeRegex };

/**
 * Creates a regex pattern for matching a name with flexible boundaries.
 * Handles punctuation, unicode, and edge cases better than \b word boundaries.
 *
 * Uses negative lookbehind/lookahead for alphanumeric chars to avoid
 * matching substrings while allowing punctuation/emoji at boundaries.
 *
 * @param name - The name to create a pattern for (will be escaped)
 * @returns RegExp that matches the name with proper boundaries
 */
export function createNameMatchRegex(name: string): RegExp {
  const escaped = escapeRegex(name);
  // Match name that is not preceded or followed by alphanumeric chars
  // This handles cases like "Nova!" or emoji names better than \b
  return new RegExp(`(?<![a-zA-Z0-9])${escaped}(?![a-zA-Z0-9])`, "g");
}
