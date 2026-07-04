/**
 * `DEFAULT_SETUP_POLICY` and `isActionAllowed`: the allow-list of action types
 * and the token/turn budgets a setup session may take before container handoff.
 * Enforced by setup-session implementations to keep the guided flow scoped.
 */

import type { SetupActionPolicy } from "./types.js";

export const DEFAULT_SETUP_POLICY: SetupActionPolicy = {
  allowList: [
    "REPLY",
    "EXTRACT_OWNER_FACT",
    "ASK_FOR_LANGUAGE",
    "OFFER_TUTORIAL_STEP",
    "OPEN_SETTINGS_VIEW",
  ],
  budgets: {
    maxTokensPerTurn: 2000,
    maxToolCallsPerTurn: 4,
    maxTurns: 40,
  },
};

export function isActionAllowed(
  actionType: string,
  policy: SetupActionPolicy,
): boolean {
  return policy.allowList.includes(actionType);
}
