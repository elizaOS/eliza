/**
 * Declares the deterministic route for affirmative requests that explicitly
 * name Computer Use as the desired host-control capability.
 */
import type { DirectActionRoutingRule } from "@elizaos/core";

const QUOTED_SEGMENT = /`[^`]*`|"[^"]*"|“[^”]*”|‘[^’]*’/gu;
const EXPLICIT_COMPUTER_USE_REQUEST =
  /^(?:(?:hey|hi)\s*,?\s+)?(?:(?:please|kindly)\s*,?\s+)?(?:(?:can|could|would|will)\s+(?:you|u)\s+(?:please\s+)?|i\s+(?:(?:want|need)\s+(?:you|u)\s+to|would\s+like\s+(?:you|u)\s+to)\s+)?use\s+(?:computer[\s_-]*use|(?:my|the)\s+computer)\b/iu;
const IMMEDIATE_NEGATED_ACTION = /^\s+to\s+(?:not|never)\b/iu;
const TERMINAL_REFERENTIAL_CANCEL =
  /(?:^|[\s?!.,;:—-])(?:(?:but|and\s+then)\s+)?(?:please\s+)?(?:cancel|stop)\s+(?:that(?:\s+request)?|it|the\s+request)\s*[.!?]*$/iu;
const TERMINAL_BARE_CANCEL =
  /(?:^|[?!.,;:—-]\s*|\bbut\s+|\band\s+then\s+)(?:please\s+)?(?:cancel|stop)\s*[.!?]*$/iu;
const TERMINAL_ABANDON =
  /(?:^|[\s?!.,;:—-])(?:never\s+mind|forget\s+it)\s*[.!?]*$/iu;
const TERMINAL_BARE_NEGATION =
  /(?:^|[?!.,;:—-]\s*|\bbut\s+)(?:please\s+)?(?:do\s+not|don't|never)\s*[.!?]*$/iu;
const BUT_NEGATED_ACTION =
  /\bbut\s+(?:actually\s*,?\s*)?(?:please\s+)?(?:do\s+not|don't|never)(?:\s+(.+))?$/iu;
const RECONSIDERED_NEGATED_ACTION =
  /(?:^|[\s?!.,;:—-])(?:and\s+|but\s+)?(?:actually\s*,?\s*|on\s+second\s+thought\s*,?\s*)(?:please\s+)?(?:do\s+not|don't|never)\s+(.+)$/iu;
const RECONSIDERED_CANCEL =
  /(?:^|[?!.,;:—-]\s*)(?:actually\s*,?\s*|on\s+second\s+thought\s*,?\s*)(?:please\s+)?(?:cancel|stop)(?:\s+(?:that(?:\s+request)?|it|the\s+request))?\s*[.!?]*$/iu;
const GENERIC_NEGATED_REFERENCE = /^(?:actually\s+)?(?:do\s+)?(?:that|it)\b/iu;
const COMPUTER_USE_REFERENCE =
  /^(?:use\s+)?(?:computer[\s_-]*use|(?:my|the)\s+computer)\b/iu;

function normalizeAction(action: string): string {
  return action
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function requestedAction(trailingRequest: string): string | undefined {
  const match =
    /^\s+(?:to|and)\s+(.+?)(?=\s+but\b|\s+actually\b|\s+on\s+second\s+thought\b|\s+and\s+then\s+(?:cancel|stop)\b|\s+(?:cancel|stop)\s+(?:that|it|the\s+request)\b|[?!.,;:—-]|$)/iu.exec(
      trailingRequest,
    );
  const normalized = normalizeAction(match?.[1] ?? "");
  return normalized.length > 0 ? normalized : undefined;
}

function negatedActionRetractsRequest(
  negatedAction: string,
  affirmativeAction: string | undefined,
): boolean {
  const normalized = negatedAction.trim();
  if (normalized.length === 0) return true;
  if (GENERIC_NEGATED_REFERENCE.test(normalized)) return true;
  if (COMPUTER_USE_REFERENCE.test(normalized)) return true;
  const affirmativeVerb = affirmativeAction?.split(" ", 1)[0];
  const normalizedNegation = normalizeAction(normalized);
  if (
    affirmativeVerb &&
    (normalizedNegation === `${affirmativeVerb} it` ||
      normalizedNegation === `${affirmativeVerb} that`)
  ) {
    return true;
  }
  return Boolean(affirmativeAction && normalizedNegation === affirmativeAction);
}

function retractsExplicitComputerUseRequest(trailingRequest: string): boolean {
  if (IMMEDIATE_NEGATED_ACTION.test(trailingRequest)) return true;
  if (TERMINAL_REFERENTIAL_CANCEL.test(trailingRequest)) return true;
  if (TERMINAL_BARE_CANCEL.test(trailingRequest)) return true;
  if (TERMINAL_ABANDON.test(trailingRequest)) return true;
  if (TERMINAL_BARE_NEGATION.test(trailingRequest)) return true;
  if (RECONSIDERED_CANCEL.test(trailingRequest)) return true;

  const affirmativeAction = requestedAction(trailingRequest);
  const reconsideration = RECONSIDERED_NEGATED_ACTION.exec(trailingRequest);
  if (
    reconsideration &&
    (!affirmativeAction ||
      negatedActionRetractsRequest(reconsideration[1] ?? "", affirmativeAction))
  ) {
    return true;
  }

  const butNegation = BUT_NEGATED_ACTION.exec(trailingRequest);
  if (!butNegation) return false;
  const positiveInstruction = trailingRequest
    .slice(0, butNegation.index)
    .replace(/[\s?!.,;:—-]/gu, "");
  if (positiveInstruction.length === 0) return true;
  return negatedActionRetractsRequest(butNegation[1] ?? "", affirmativeAction);
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
