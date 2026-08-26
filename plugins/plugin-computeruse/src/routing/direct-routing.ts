/**
 * Declares the deterministic route for affirmative requests that explicitly
 * name Computer Use as the desired host-control capability.
 */
import type { DirectActionRoutingRule } from "@elizaos/core";

const EXPLICIT_COMPUTER_USE_REQUEST =
  /\b(?:use\s+(?:computer[\s_-]*use|(?:my|the)\s+computer)|computer[\s_-]*use\s+to)\b/iu;
const NEGATED_COMPUTER_USE_REQUEST =
  /\b(?:do\s+not|don't|dont|never)\s+(?:please\s+)?use\s+(?:computer[\s_-]*use|(?:my|the)\s+computer)\b/iu;

/**
 * Match only an explicit request for the Computer Use capability. Generic
 * "open X" requests stay available to browser, view, and automation routing;
 * naming Computer Use is the user's unambiguous choice of the host-desktop
 * boundary.
 */
export function looksLikeExplicitComputerUseRequest(text: string): boolean {
  const normalized = text.trim();
  return (
    !NEGATED_COMPUTER_USE_REQUEST.test(normalized) &&
    EXPLICIT_COMPUTER_USE_REQUEST.test(normalized)
  );
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
    matches: looksLikeExplicitComputerUseRequest,
  };
}
