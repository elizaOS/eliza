/**
 * OWNER_FINANCES action stub for @elizaos/plugin-finances.
 *
 * This is a SCAFFOLD ONLY. The real implementation currently lives in
 *   plugins/plugin-lifeops/src/actions/owner-surfaces.ts  (ownerFinancesAction)
 * with the underlying money / payments / recurring-charge handlers in
 *   plugins/plugin-lifeops/src/actions/money.ts
 *   plugins/plugin-lifeops/src/actions/payments.ts
 *   plugins/plugin-lifeops/src/actions/lib/payments-recurring.ts (planned)
 *
 * The follow-up migration pass will:
 *   1. Move the OWNER_FINANCE_ACTIONS / OWNER_FINANCE_SIMILES constants here.
 *   2. Move MONEY_PARAMETERS and `runMoneyHandler` (or its successor) here.
 *   3. Replace the placeholder handler below with the real dispatch logic.
 *   4. Drop ownerFinancesAction from owner-surfaces.ts and re-export the
 *      action from this plugin instead.
 *
 * Until then this stub:
 *   - registers the OWNER_FINANCES action name so the planner can plan against it,
 *   - returns a clear "not yet wired" ActionResult,
 *   - never throws.
 */

import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";

const OWNER_FINANCES_NOT_WIRED_MESSAGE =
  "OWNER_FINANCES is being migrated from @elizaos/plugin-lifeops into @elizaos/plugin-finances. The action is registered but not yet wired.";

export const ownerFinancesAction: Action = {
  name: "OWNER_FINANCES",
  similes: ["FINANCES", "FINANCE", "MONEY", "TRANSACTIONS", "RECURRING"],
  description:
    "Owner finances dashboard: sources, imports, spending, recurring charges, subscriptions. (Scaffold — implementation migrating from plugin-lifeops.)",
  descriptionCompressed:
    "owner finances dashboard|sources|csv|transactions|spending|recurring|subscription",
  contexts: ["money", "owner"],
  contextGate: { anyOf: ["money", "owner"] },
  roleGate: { minRole: "ADMIN" },
  parameters: [
    {
      name: "action",
      description: "Owner finance op (passthrough until migration completes).",
      required: false,
      schema: { type: "string" as const },
    },
  ],
  validate: async (_runtime: IAgentRuntime, _message: Memory, _state?: State) =>
    true,
  handler: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state: State | undefined,
    _options: unknown,
    _callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    // TODO(lifeops-decomp): replace with the migrated runMoneyHandler dispatch.
    return {
      success: false,
      text: OWNER_FINANCES_NOT_WIRED_MESSAGE,
    };
  },
};
