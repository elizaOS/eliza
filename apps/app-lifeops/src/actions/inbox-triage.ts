/**
 * LifeOps inbox-triage compatibility shim.
 *
 * Historically this module exposed Gmail-only inbox triage. Triage is now
 * implemented cross-platform under `@elizaos/core` (T7d,
 * `features/messaging/triage`). This file remains for backwards-compat:
 *
 *  - `inboxAction` is still re-exported from `./inbox.js` (existing CLI /
 *    scenario wiring imports from here).
 *  - `inboxTriageAction` is a thin Action that delegates to the new
 *    cross-platform `TRIAGE_MESSAGES` action with `sources: ["gmail"]` so
 *    callers targeting Gmail specifically get the same behavior they used
 *    to, while benefiting from the new engine + store.
 */

import type {
  Action,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { triageMessagesAction } from "@elizaos/core";

export { inboxAction } from "./inbox.js";

export const inboxTriageAction: Action = {
  name: "INBOX_TRIAGE_GMAIL",
  description:
    "Compatibility-only Gmail triage shim. Delegates to the cross-platform TRIAGE_MESSAGES action with sources=['gmail']; new planner-facing inbox/email routing should use OWNER_INBOX instead.",
  similes: ["TRIAGE_GMAIL", "GMAIL_TRIAGE", "CHECK_GMAIL"],
  examples: [],

  validate: async (): Promise<boolean> => true,

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const delegated: HandlerOptions = {
      ...options,
      parameters: {
        ...(options?.parameters ?? {}),
        sources: ["gmail"],
      },
    };
    return triageMessagesAction.handler(
      runtime,
      message,
      state,
      delegated,
      callback,
    );
  },
};
