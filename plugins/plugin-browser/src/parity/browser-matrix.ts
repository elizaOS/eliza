/**
 * Machine-checkable browser action parity matrix (#9476).
 *
 * This is the browser equivalent of plugin-computeruse's parity guard: the
 * matrix is data, and the validator cross-checks it against the live registered
 * action surface plus the BROWSER action schema. That keeps browser capability
 * coverage from drifting silently while real-driver and benchmark lanes are
 * added.
 */

import type { Action } from "@elizaos/core";
import { listSubactionsFromParameters } from "@elizaos/core";
import { browserAction } from "../actions/browser.js";

export type BrowserParityStatus = "have" | "partial" | "planned" | "na";
export type BrowserParitySurface =
  | "workspace"
  | "legacy-alias"
  | "credential"
  | "waiter";

export interface BrowserParityCapability {
  /** Canonical capability id. Usually the exposed BROWSER action value. */
  id: string;
  /** Value declared in the BROWSER action schema. */
  actionValue?: string;
  /** Registered promoted action name for this capability. */
  elizaVerb?: string;
  /** Runtime command/subaction this capability dispatches to. */
  dispatchesTo?: string;
  status: BrowserParityStatus;
  surface: BrowserParitySurface;
  note?: string;
}

const WORKSPACE = "workspace" as const;

export const BROWSER_PARITY_MATRIX: readonly BrowserParityCapability[] = [
  {
    id: "open",
    actionValue: "open",
    elizaVerb: "BROWSER_OPEN",
    dispatchesTo: "open",
    status: "have",
    surface: WORKSPACE,
  },
  {
    id: "navigate",
    actionValue: "navigate",
    elizaVerb: "BROWSER_NAVIGATE",
    dispatchesTo: "navigate",
    status: "have",
    surface: WORKSPACE,
  },
  {
    id: "click",
    actionValue: "click",
    elizaVerb: "BROWSER_CLICK",
    dispatchesTo: "click",
    status: "have",
    surface: WORKSPACE,
  },
  {
    id: "type",
    actionValue: "type",
    elizaVerb: "BROWSER_TYPE",
    dispatchesTo: "type",
    status: "have",
    surface: WORKSPACE,
  },
  {
    id: "press",
    actionValue: "press",
    elizaVerb: "BROWSER_PRESS",
    dispatchesTo: "press",
    status: "have",
    surface: WORKSPACE,
  },
  {
    id: "get",
    actionValue: "get",
    elizaVerb: "BROWSER_GET",
    dispatchesTo: "get",
    status: "have",
    surface: WORKSPACE,
  },
  {
    id: "state",
    actionValue: "state",
    elizaVerb: "BROWSER_STATE",
    dispatchesTo: "state",
    status: "have",
    surface: WORKSPACE,
  },
  {
    id: "snapshot",
    actionValue: "snapshot",
    elizaVerb: "BROWSER_SNAPSHOT",
    dispatchesTo: "snapshot",
    status: "have",
    surface: WORKSPACE,
  },
  {
    id: "screenshot",
    actionValue: "screenshot",
    elizaVerb: "BROWSER_SCREENSHOT",
    dispatchesTo: "screenshot",
    status: "have",
    surface: WORKSPACE,
  },
  {
    id: "reload",
    actionValue: "reload",
    elizaVerb: "BROWSER_RELOAD",
    dispatchesTo: "reload",
    status: "have",
    surface: WORKSPACE,
  },
  {
    id: "back",
    actionValue: "back",
    elizaVerb: "BROWSER_BACK",
    dispatchesTo: "back",
    status: "have",
    surface: WORKSPACE,
  },
  {
    id: "forward",
    actionValue: "forward",
    elizaVerb: "BROWSER_FORWARD",
    dispatchesTo: "forward",
    status: "have",
    surface: WORKSPACE,
  },
  {
    id: "close",
    actionValue: "close",
    elizaVerb: "BROWSER_CLOSE",
    dispatchesTo: "close",
    status: "have",
    surface: WORKSPACE,
  },
  {
    id: "show",
    actionValue: "show",
    elizaVerb: "BROWSER_SHOW",
    dispatchesTo: "show",
    status: "have",
    surface: WORKSPACE,
  },
  {
    id: "hide",
    actionValue: "hide",
    elizaVerb: "BROWSER_HIDE",
    dispatchesTo: "hide",
    status: "have",
    surface: WORKSPACE,
  },
  {
    id: "wait",
    actionValue: "wait",
    elizaVerb: "BROWSER_WAIT",
    dispatchesTo: "wait",
    status: "have",
    surface: WORKSPACE,
  },
  {
    id: "tab",
    actionValue: "tab",
    elizaVerb: "BROWSER_TAB",
    dispatchesTo: "tab",
    status: "have",
    surface: WORKSPACE,
  },
  {
    id: "realistic-click",
    actionValue: "realistic_click",
    elizaVerb: "BROWSER_REALISTIC_CLICK",
    dispatchesTo: "realistic-click",
    status: "have",
    surface: WORKSPACE,
  },
  {
    id: "realistic-fill",
    actionValue: "realistic_fill",
    elizaVerb: "BROWSER_REALISTIC_FILL",
    dispatchesTo: "realistic-fill",
    status: "have",
    surface: WORKSPACE,
  },
  {
    id: "realistic-type",
    actionValue: "realistic_type",
    elizaVerb: "BROWSER_REALISTIC_TYPE",
    dispatchesTo: "realistic-type",
    status: "have",
    surface: WORKSPACE,
  },
  {
    id: "realistic-press",
    actionValue: "realistic_press",
    elizaVerb: "BROWSER_REALISTIC_PRESS",
    dispatchesTo: "realistic-press",
    status: "have",
    surface: WORKSPACE,
  },
  {
    id: "cursor-move",
    actionValue: "cursor_move",
    elizaVerb: "BROWSER_CURSOR_MOVE",
    dispatchesTo: "cursor-move",
    status: "have",
    surface: WORKSPACE,
  },
  {
    id: "cursor-hide",
    actionValue: "cursor_hide",
    elizaVerb: "BROWSER_CURSOR_HIDE",
    dispatchesTo: "cursor-hide",
    status: "have",
    surface: WORKSPACE,
  },
  {
    id: "autofill-login",
    actionValue: "autofill_login",
    elizaVerb: "BROWSER_AUTOFILL_LOGIN",
    dispatchesTo: "autofill-login",
    status: "have",
    surface: "credential",
    note: "Vault-gated credential autofill over the active workspace tab.",
  },
  {
    id: "wait-for-url",
    actionValue: "wait_for_url",
    elizaVerb: "BROWSER_WAIT_FOR_URL",
    dispatchesTo: "wait-for-url",
    status: "have",
    surface: "waiter",
    note: "Polls current tab URL against a substring or /regex/ pattern.",
  },

  // Legacy aliases remain promoted because they are still declared in the
  // BROWSER action schema. Keep them explicit so removing one is deliberate.
  {
    id: "info",
    actionValue: "info",
    elizaVerb: "BROWSER_INFO",
    dispatchesTo: "state",
    status: "have",
    surface: "legacy-alias",
  },
  {
    id: "context",
    actionValue: "context",
    elizaVerb: "BROWSER_CONTEXT",
    dispatchesTo: "state",
    status: "have",
    surface: "legacy-alias",
  },
  {
    id: "get-context",
    actionValue: "get_context",
    elizaVerb: "BROWSER_GET_CONTEXT",
    dispatchesTo: "state",
    status: "have",
    surface: "legacy-alias",
  },
  {
    id: "list-tabs",
    actionValue: "list_tabs",
    elizaVerb: "BROWSER_LIST_TABS",
    dispatchesTo: "tab:list",
    status: "have",
    surface: "legacy-alias",
  },
  {
    id: "open-tab",
    actionValue: "open_tab",
    elizaVerb: "BROWSER_OPEN_TAB",
    dispatchesTo: "tab:new",
    status: "have",
    surface: "legacy-alias",
  },
  {
    id: "close-tab",
    actionValue: "close_tab",
    elizaVerb: "BROWSER_CLOSE_TAB",
    dispatchesTo: "tab:close",
    status: "have",
    surface: "legacy-alias",
  },
  {
    id: "switch-tab",
    actionValue: "switch_tab",
    elizaVerb: "BROWSER_SWITCH_TAB",
    dispatchesTo: "tab:switch",
    status: "have",
    surface: "legacy-alias",
  },
];

export interface BrowserParityValidationProblem {
  capability: string;
  problem: string;
}

export interface BrowserParityValidationResult {
  ok: boolean;
  problems: BrowserParityValidationProblem[];
  confirmed: number;
}

function liveBrowserActionValues(): readonly string[] {
  return listSubactionsFromParameters(browserAction.parameters);
}

export function browserParitySummary(): {
  have: number;
  partial: number;
  planned: number;
  na: number;
  total: number;
} {
  let have = 0;
  let partial = 0;
  let planned = 0;
  let na = 0;
  for (const cap of BROWSER_PARITY_MATRIX) {
    if (cap.status === "have") have += 1;
    else if (cap.status === "partial") partial += 1;
    else if (cap.status === "planned") planned += 1;
    else na += 1;
  }
  return { have, partial, planned, na, total: BROWSER_PARITY_MATRIX.length };
}

export function validateBrowserParityMatrix(
  actionNames: readonly string[],
  actionValues: readonly string[] = liveBrowserActionValues(),
): BrowserParityValidationResult {
  const registered = new Set(actionNames);
  const schemaValues = new Set(actionValues);
  const matrixByVerb = new Map<string, BrowserParityCapability>();
  const matrixByActionValue = new Map<string, BrowserParityCapability>();
  const problems: BrowserParityValidationProblem[] = [];
  let confirmed = 0;

  for (const cap of BROWSER_PARITY_MATRIX) {
    if (cap.elizaVerb) {
      const existing = matrixByVerb.get(cap.elizaVerb);
      if (existing) {
        problems.push({
          capability: cap.id,
          problem: `duplicates elizaVerb ${cap.elizaVerb} from ${existing.id}`,
        });
      }
      matrixByVerb.set(cap.elizaVerb, cap);
    }
    if (cap.actionValue) {
      const existing = matrixByActionValue.get(cap.actionValue);
      if (existing) {
        problems.push({
          capability: cap.id,
          problem: `duplicates action value ${cap.actionValue} from ${existing.id}`,
        });
      }
      matrixByActionValue.set(cap.actionValue, cap);
    }

    if (cap.status === "na") {
      if (cap.elizaVerb) {
        problems.push({
          capability: cap.id,
          problem: `status "na" must not declare elizaVerb ${cap.elizaVerb}`,
        });
      }
      continue;
    }

    if (cap.elizaVerb && !registered.has(cap.elizaVerb)) {
      problems.push({
        capability: cap.id,
        problem: `verb ${cap.elizaVerb} is marked "${cap.status}" but is NOT registered`,
      });
    } else if (cap.elizaVerb) {
      confirmed += 1;
    }

    if (cap.actionValue && !schemaValues.has(cap.actionValue)) {
      problems.push({
        capability: cap.id,
        problem: `action value ${cap.actionValue} is not declared by the BROWSER action schema`,
      });
    }
  }

  for (const actionValue of schemaValues) {
    if (!matrixByActionValue.has(actionValue)) {
      problems.push({
        capability: actionValue,
        problem:
          "BROWSER action schema value is missing from BROWSER_PARITY_MATRIX",
      });
    }
  }

  for (const actionName of registered) {
    if (actionName.startsWith("BROWSER_") && !matrixByVerb.has(actionName)) {
      problems.push({
        capability: actionName,
        problem:
          "registered promoted BROWSER action is missing from BROWSER_PARITY_MATRIX",
      });
    }
  }

  return { ok: problems.length === 0, problems, confirmed };
}

export function browserActionNames(
  actions: readonly Action[],
): readonly string[] {
  return actions.map((action) => action.name);
}
