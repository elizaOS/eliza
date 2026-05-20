import { Actions } from './templates/multi-step-decision';

const KNOWN_ACTIONS = new Set(Object.values(Actions));
const ACTION_ALIASES: Record<string, string> = {
  TR: Actions.TRADE,
  TRAD: Actions.TRADE,
  CMNT: Actions.COMMENT,
  CMT: Actions.COMMENT,
  TRANSFER: Actions.SEND_MONEY,
  SEND: Actions.SEND_MONEY,
  PAY: Actions.SEND_MONEY,
  TIP: Actions.SEND_MONEY,
  SHARE_INFO: Actions.SHARE_INFORMATION,
  SHARE_INTEL: Actions.SHARE_INFORMATION,
  INTEL: Actions.SHARE_INFORMATION,
  REQUEST_PAY: Actions.REQUEST_PAYMENT,
  INVOICE: Actions.REQUEST_PAYMENT,
  ASK_PAYMENT: Actions.REQUEST_PAYMENT,
};

export function normalizeDecisionAction(action: string): string {
  const normalized = action.trim().toUpperCase();
  if (!normalized) {
    return '';
  }

  if (ACTION_ALIASES[normalized]) {
    return ACTION_ALIASES[normalized];
  }

  if (KNOWN_ACTIONS.has(normalized as (typeof Actions)[keyof typeof Actions])) {
    return normalized;
  }

  const candidates = normalized
    .split(/[\n|,;/]+/)
    .map((fragment) => fragment.trim())
    .filter(Boolean)
    .map((fragment) => fragment.replace(/[\s-]+/g, '_'));

  for (const candidate of candidates) {
    if (ACTION_ALIASES[candidate]) {
      return ACTION_ALIASES[candidate];
    }
    if (
      KNOWN_ACTIONS.has(candidate as (typeof Actions)[keyof typeof Actions])
    ) {
      return candidate;
    }
  }

  if (normalized.length >= 2) {
    const prefixMatches = [...KNOWN_ACTIONS].filter((knownAction) =>
      knownAction.startsWith(normalized)
    );
    if (prefixMatches.length === 1) {
      return prefixMatches[0] ?? normalized;
    }
  }

  let bestMatch = '';
  let bestIndex = Number.POSITIVE_INFINITY;
  for (const knownAction of KNOWN_ACTIONS) {
    const index = normalized.indexOf(knownAction);
    if (index !== -1 && index < bestIndex) {
      bestIndex = index;
      bestMatch = knownAction;
    }
  }

  return bestMatch || normalized;
}
