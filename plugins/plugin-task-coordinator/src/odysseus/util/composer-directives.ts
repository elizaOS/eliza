// Pure parsing of leading composer "/directives" so a user can opt a new
// orchestrator task into a wider capability fence from the chat box. Kept free
// of React / client imports so it is trivially unit-testable.

export interface ComposerDirectives {
  /** The message text with any recognized leading directive removed. */
  goal: string;
  /** Capability fence the spawned sub-agent should run under, when requested. */
  capabilityProfile?: "economics";
}

/** Leading tokens that opt a task into the monetized-app economics fence. */
const ECONOMICS_PREFIXES = ["/economics", "/monetize", "/monetized-app"];

/**
 * Parse leading directives from composer text. Currently recognizes the
 * economics directives (e.g. `/economics build a trivia app`), which strip the
 * token and mark the task for the economics capability profile. Unknown text is
 * returned unchanged.
 */
export function parseComposerDirectives(text: string): ComposerDirectives {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();
  for (const prefix of ECONOMICS_PREFIXES) {
    if (lower === prefix || lower.startsWith(`${prefix} `)) {
      const goal = trimmed.slice(prefix.length).trim();
      return { goal, capabilityProfile: "economics" };
    }
  }
  return { goal: trimmed };
}
