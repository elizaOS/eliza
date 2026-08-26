/**
 * Declares the deterministic route for affirmative requests that explicitly
 * name Computer Use as the desired host-control capability.
 */
import type { DirectActionRoutingRule } from "@elizaos/core";

const QUOTED_SEGMENT = /`[^`]*`|"[^"]*"|“[^”]*”|‘[^’]*’/gu;
const EXPLICIT_COMPUTER_USE_REQUEST =
  /^(?:(?:hey|hi)\s*,?\s+)?(?:(?:please|kindly)\s*,?\s+)?(?:(?:can|could|would|will)\s+(?:you|u)\s+(?:please\s+)?|i\s+(?:(?:want|need)\s+(?:you|u)\s+to|would\s+like\s+(?:you|u)\s+to)\s+)?use\s+(?:computer[\s_-]*use|(?:my|the)\s+computer)\b/iu;
const IMMEDIATE_NEGATED_ACTION = /^\s+to\s+(?:not|never)\b/iu;
const EXPLICIT_RECONSIDERATION =
  /(?:^|[?!.,;:—-]\s*)(?:actually\s*,?\s*|on\s+second\s+thought\s*,?\s*)(?:please\s+)?(?:do\s+not|don't|never|cancel|stop)\b/iu;
const TERMINAL_CANCEL =
  /(?:^|[?!.,;:—-]\s*)(?:please\s+)?(?:cancel|stop)(?:\s+(?:that|it|the\s+request))?\s*[.!?]*$/iu;
const BUT_NEGATED_ACTION =
  /\bbut\s+(?:please\s+)?(?:do\s+not|don't|never)\s+(.+)$/iu;
const GENERIC_NEGATED_REFERENCE = /^(?:actually\s+)?(?:do\s+)?(?:that|it)\b/iu;

function retractsExplicitComputerUseRequest(trailingRequest: string): boolean {
  if (IMMEDIATE_NEGATED_ACTION.test(trailingRequest)) return true;
  if (EXPLICIT_RECONSIDERATION.test(trailingRequest)) return true;
  if (TERMINAL_CANCEL.test(trailingRequest)) return true;

  const butNegation = BUT_NEGATED_ACTION.exec(trailingRequest);
  if (!butNegation) return false;
  const positiveInstruction = trailingRequest
    .slice(0, butNegation.index)
    .replace(/[\s?!.,;:—-]/gu, "");
  if (positiveInstruction.length === 0) return true;
  return GENERIC_NEGATED_REFERENCE.test(butNegation[1] ?? "");
}

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
  const explicitRequest = EXPLICIT_COMPUTER_USE_REQUEST.exec(normalized);
  if (!explicitRequest) return false;
  const trailingRequest = normalized.slice(explicitRequest[0].length);
  return !retractsExplicitComputerUseRequest(trailingRequest);
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
