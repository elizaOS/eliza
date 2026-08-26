/**
 * Declares the deterministic route for affirmative requests that explicitly
 * name Computer Use as the desired host-control capability.
 */
import type { DirectActionRoutingRule } from "@elizaos/core";

const QUOTED_SEGMENT = /`[^`]*`|"[^"]*"|“[^”]*”|‘[^’]*’/gu;
const EXPLICIT_COMPUTER_USE_REQUEST =
  /^(?:(?:hey|hi)\s*,?\s+)?(?:(?:please|kindly)\s*,?\s+)?(?:(?:can|could|would|will)\s+(?:you|u)\s+(?:please\s+)?|i\s+(?:(?:want|need)\s+(?:you|u)\s+to|would\s+like\s+(?:you|u)\s+to)\s+)?use\s+(?:computer[\s_-]*use|(?:my|the)\s+computer)\b/iu;
const IMMEDIATE_NEGATED_ACTION = /^\s+to\s+(?:not|never)\b/iu;
const TERMINAL_CANCEL =
  /(?:^|[\s?!.,;:—-])(?:(?:but|and\s+then)\s+)?(?:please\s+)?(?:cancel|stop)(?:\s+(?:that(?:\s+request)?|it|the\s+request))?\s*[.!?]*$/iu;
const BUT_NEGATED_ACTION =
  /\bbut\s+(?:actually\s*,?\s*)?(?:please\s+)?(?:do\s+not|don't|never)(?:\s+(.+))?$/iu;
const RECONSIDERED_NEGATED_ACTION =
  /(?:^|[?!.,;:—-]\s*)(?:actually\s*,?\s*|on\s+second\s+thought\s*,?\s*)(?:please\s+)?(?:do\s+not|don't|never)\s+(.+)$/iu;
const RECONSIDERED_CANCEL =
  /(?:^|[?!.,;:—-]\s*)(?:actually\s*,?\s*|on\s+second\s+thought\s*,?\s*)(?:please\s+)?(?:cancel|stop)(?:\s+(?:that(?:\s+request)?|it|the\s+request))?\s*[.!?]*$/iu;
const GENERIC_NEGATED_REFERENCE = /^(?:actually\s+)?(?:do\s+)?(?:that|it)\b/iu;
const COMPUTER_USE_REFERENCE =
  /^(?:use\s+)?(?:computer[\s_-]*use|(?:my|the)\s+computer)\b/iu;

function requestedActionVerb(trailingRequest: string): string | undefined {
  return /^\s+to\s+([\p{L}\p{N}_-]+)/iu
    .exec(trailingRequest)?.[1]
    ?.toLocaleLowerCase();
}

function negatedActionRetractsRequest(
  negatedAction: string,
  requestedVerb: string | undefined,
): boolean {
  const normalized = negatedAction.trim();
  if (normalized.length === 0) return true;
  if (GENERIC_NEGATED_REFERENCE.test(normalized)) return true;
  if (COMPUTER_USE_REFERENCE.test(normalized)) return true;
  const negatedVerb = /^(?:actually\s+)?([\p{L}\p{N}_-]+)/iu.exec(
    normalized,
  )?.[1];
  return Boolean(
    requestedVerb && negatedVerb?.toLocaleLowerCase() === requestedVerb,
  );
}

function retractsExplicitComputerUseRequest(trailingRequest: string): boolean {
  if (IMMEDIATE_NEGATED_ACTION.test(trailingRequest)) return true;
  if (TERMINAL_CANCEL.test(trailingRequest)) return true;
  if (RECONSIDERED_CANCEL.test(trailingRequest)) return true;

  const requestedVerb = requestedActionVerb(trailingRequest);
  const reconsideration = RECONSIDERED_NEGATED_ACTION.exec(trailingRequest);
  if (
    reconsideration &&
    (!requestedVerb ||
      negatedActionRetractsRequest(reconsideration[1] ?? "", requestedVerb))
  ) {
    return true;
  }

  const butNegation = BUT_NEGATED_ACTION.exec(trailingRequest);
  if (!butNegation) return false;
  const positiveInstruction = trailingRequest
    .slice(0, butNegation.index)
    .replace(/[\s?!.,;:—-]/gu, "");
  if (positiveInstruction.length === 0) return true;
  return negatedActionRetractsRequest(butNegation[1] ?? "", requestedVerb);
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
