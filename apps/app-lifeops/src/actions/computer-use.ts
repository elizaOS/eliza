/**
 * LifeOps computer-use action.
 *
 * Thin wrapper over @elizaos/plugin-computeruse's useComputerAction with
 * LifeOps-specific access control (owner-only) and an opt-out feature flag
 * (ELIZA_LIFEOPS_COMPUTER_USE_ENABLED=0). If the plugin package is not
 * installed in the workspace, exports a stub action that returns a clear
 * "not installed" result instead of crashing the plugin load.
 */

import type {
  Action,
  ActionExample,
  ActionResult,
  IAgentRuntime,
  Memory,
} from "@elizaos/core";
import { hasOwnerAccess } from "@elizaos/agent/security/access";

const ACTION_NAME = "LIFEOPS_COMPUTER_USE";

function isComputerUseEnabled(): boolean {
  return process.env.ELIZA_LIFEOPS_COMPUTER_USE_ENABLED !== "0";
}

async function loadBaseAction(): Promise<Action | null> {
  try {
    // Dynamic import so a missing peer dependency does not break plugin load.
    const mod = (await import(
      /* @vite-ignore */ "@elizaos/plugin-computeruse"
    )) as {
      useComputerAction?: Action;
      default?: { actions?: readonly Action[] };
      computerUsePlugin?: { actions?: readonly Action[] };
    };
    if (mod.useComputerAction) return mod.useComputerAction;
    const plugin = mod.computerUsePlugin ?? mod.default;
    const fromPlugin = plugin?.actions?.find(
      (a) => a.name === "USE_COMPUTER" || a.name === "USE_COMPUTER_ACTION",
    );
    return fromPlugin ?? plugin?.actions?.[0] ?? null;
  } catch {
    return null;
  }
}

let cachedBaseAction: Action | null | undefined;

async function getBaseAction(): Promise<Action | null> {
  if (cachedBaseAction === undefined) {
    cachedBaseAction = await loadBaseAction();
  }
  return cachedBaseAction;
}

const stubExamples: ActionExample[][] = [
  [
    {
      name: "{{name1}}",
      content: { text: "Take a screenshot of my desktop" },
    },
    {
      name: "{{agentName}}",
      content: {
        text: "The @elizaos/plugin-computeruse package is not installed. Install it and restart the agent to enable desktop automation.",
      },
    },
  ],
];

export const lifeOpsComputerUseAction: Action = {
  name: ACTION_NAME,
  similes: [
    "USE_COMPUTER",
    "DESKTOP_AUTOMATION",
    "COMPUTER_USE",
    "CONTROL_DESKTOP",
  ],
  description:
    "Control the owner's desktop (screenshots, mouse, keyboard, browser, " +
    "windows, files, terminal) via @elizaos/plugin-computeruse. Use this for " +
    "portal uploads, browser form-filling, and other on-machine workflows the " +
    "assistant should perform directly, including standing instructions like " +
    "'when I send the file, upload it to the portal for me.' Owner-only. " +
    "Disabled when ELIZA_LIFEOPS_COMPUTER_USE_ENABLED=0.",

  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    if (!isComputerUseEnabled()) return false;
    if (!(await hasOwnerAccess(runtime, message))) return false;
    const base = await getBaseAction();
    if (!base) return false;
    if (!base.validate) return true;
    return base.validate(runtime, message, undefined);
  },

  parameters: [],

  examples: stubExamples,

  handler: async (runtime, message, state, options, callback): Promise<ActionResult> => {
    if (!isComputerUseEnabled()) {
      return {
        text: "Computer use is disabled (ELIZA_LIFEOPS_COMPUTER_USE_ENABLED=0).",
        success: false,
        values: { success: false, error: "COMPUTER_USE_DISABLED" },
        data: { actionName: ACTION_NAME },
      };
    }
    if (!(await hasOwnerAccess(runtime, message))) {
      return {
        text: "Permission denied: only the owner may drive computer use.",
        success: false,
        values: { success: false, error: "PERMISSION_DENIED" },
        data: { actionName: ACTION_NAME },
      };
    }

    const base = await getBaseAction();
    if (!base) {
      return {
        text: "The @elizaos/plugin-computeruse package is not installed. Install it and restart the agent to enable desktop automation.",
        success: false,
        values: { success: false, error: "COMPUTER_USE_NOT_INSTALLED" },
        data: { actionName: ACTION_NAME },
      };
    }

    const result = await base.handler(runtime, message, state, options, callback, []);
    if (result && typeof result === "object" && "success" in result) {
      return result as ActionResult;
    }
    return {
      text: "",
      success: true,
      values: { success: true },
      data: { actionName: ACTION_NAME, raw: result },
    };
  },
};
