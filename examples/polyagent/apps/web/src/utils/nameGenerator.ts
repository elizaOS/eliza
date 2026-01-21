/**
 * Agent Name Generator
 *
 * Generates random, memorable names for AI trading agents.
 * Uses curated word lists organized by theme for variety.
 */

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
 * Generates a random agent name with display name and username.
 *
 * @returns Object with displayName (e.g., "Nova Trader") and username (e.g., "novatrader123456")
 *
 * @example
 * const { username, displayName } = generateAgentName();
 * // displayName: "Quantum Oracle"
 * // username: "quantumoracle847291"
 */
export function generateAgentName(): GeneratedAgentName {
  // Arrays are non-empty (defined above), so these are guaranteed to exist
  const prefix =
    NAME_PREFIXES[Math.floor(Math.random() * NAME_PREFIXES.length)]!;
  const suffix =
    NAME_SUFFIXES[Math.floor(Math.random() * NAME_SUFFIXES.length)]!;

  // Use 6-digit number for better uniqueness at scale
  // Range: 100000-999999 = 900,000 possible numbers
  // Combined with ~2,275 name combos = ~2 billion unique usernames
  const number = Math.floor(Math.random() * 900000) + 100000;

  const displayName = `${prefix} ${suffix}`;
  const username = `${prefix.toLowerCase()}${suffix.toLowerCase()}${number}`;

  return { username, displayName };
}

/**
 * Escapes special regex characters in a string.
 * Used for safe string replacement in prompts.
 */
export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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
