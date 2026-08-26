/**
 * Declares the deterministic route for affirmative requests that explicitly
 * name Computer Use as the desired host-control capability.
 */
import type { DirectActionRoutingRule } from "@elizaos/core";

const QUOTED_SEGMENT = /`[^`]*`|"[^"]*"|“[^”]*”|‘[^’]*’/gu;
const EXPLICIT_COMPUTER_USE_REQUEST =
  /^(?:(?:hey|hi)\s*,?\s+)?(?:(?:please|kindly)\s+|(?:can|could|would|will)\s+(?:you|u)\s+(?:please\s+)?|i\s+(?:want|need)\s+(?:you|u)\s+to\s+)?use\s+(?:computer[\s_-]*use|(?:my|the)\s+computer)\b/iu;

/**
 * Match only an explicit request for the Computer Use capability. Generic
 * "open X" requests stay available to browser, view, and automation routing;
 * naming Computer Use is the user's unambiguous choice of the host-desktop
 * boundary.
 */
export function looksLikeExplicitComputerUseRequest(text: string): boolean {
  const normalized = text
    .normalize("NFKC")
    .replace(QUOTED_SEGMENT, " ")
    .replace(/’/gu, "'")
    .trim();
  return EXPLICIT_COMPUTER_USE_REQUEST.test(normalized);
}

export function createComputerUseDirectRoutingRule(): DirectActionRoutingRule {
  return {
    id: "computer-use.explicit-host-control",
    actionNames: ["COMPUTER_USE"],
    replacesActionNames: [
      "BROWSER",
      "BROWSER_NAVIGATE",
      "AUTOMATION_TRIGGER",
      "TRIGGER",
      "VIEWS",
    ],
    requiredActionTags: [
      "domain:computer-use",
      "capability:desktop-control",
      "effect:host-action",
    ],
    contexts: ["automation", "admin"],
    unavailable: {
      code: "COMPUTER_USE_UNAVAILABLE",
      reply:
        "Computer Use is unavailable in this app session. Enable Computer Use, restart the app session, and try again. (COMPUTER_USE_UNAVAILABLE)",
    },
    matches: looksLikeExplicitComputerUseRequest,
  };
}
