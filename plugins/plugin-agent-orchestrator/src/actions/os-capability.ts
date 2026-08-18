/**
 * Exposes the narrow elizaOS Live capability broker to verified owners. The
 * action mirrors the canonical OS runner's four zero-argument commands and
 * repeats scoped OWNER authorization at execution, independent of discovery.
 */
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import type {
  Action,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { checkSenderRole } from "@elizaos/core";

const ACTIONS = [
  "status",
  "privacy_mode",
  "root_status",
  "open_persistent_storage",
] as const;
type ElizaOsAction = (typeof ACTIONS)[number];

const RUNNER_COMMANDS: Record<ElizaOsAction, string> = {
  status: "status",
  privacy_mode: "privacy-mode",
  root_status: "root-status",
  open_persistent_storage: "open-persistent-storage",
};

function normalizeAction(value: unknown): ElizaOsAction | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  return ACTIONS.includes(normalized as ElizaOsAction)
    ? (normalized as ElizaOsAction)
    : undefined;
}

function runnerPath(): string | undefined {
  const value = process.env.ELIZAOS_CAPABILITY_RUNNER?.trim();
  return value || undefined;
}

async function runnerAvailable(): Promise<boolean> {
  const runner = runnerPath();
  if (!runner) return false;
  try {
    await access(runner, constants.X_OK);
    return true;
  } catch {
    // error-policy:J4 an absent/non-executable optional OS broker makes the
    // action unavailable; it never degrades into another execution path.
    return false;
  }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function hasUnsupportedArguments(
  params: Record<string, unknown>,
  content: Record<string, unknown>,
): boolean {
  return (
    Object.hasOwn(params, "args") ||
    Object.hasOwn(content, "args") ||
    Object.hasOwn(params, "arguments") ||
    Object.hasOwn(content, "arguments")
  );
}

function run(runner: string, command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      runner,
      [command],
      {
        encoding: "utf8",
        maxBuffer: 64 * 1024,
        timeout: 5_000,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(Object.assign(error, { stdout, stderr }));
          return;
        }
        resolve(stdout.trim());
      },
    );
  });
}

async function hasScopedOwnerAuthority(
  runtime: IAgentRuntime,
  message: Memory,
): Promise<boolean> {
  try {
    const role = await checkSenderRole(runtime, message);
    return role?.role === "OWNER" && role.isOwner === true;
  } catch (error) {
    // error-policy:J1 role resolution is the execution authorization boundary;
    // lookup failures are reported and translated to an explicit denial.
    runtime.reportError("os-capability.authorize", error, {
      roomId: message.roomId,
      entityId: message.entityId,
    });
    return false;
  }
}

export const osCapabilityAction: Action = {
  name: "ELIZAOS",
  contexts: ["automation", "agent_internal", "settings"],
  roleGate: { minRole: "OWNER" },
  similes: [
    "ELIZAOS_STATUS",
    "ELIZAOS_PRIVACY_MODE",
    "ELIZAOS_ROOT_STATUS",
    "ELIZAOS_PERSISTENT_STORAGE",
    "OPEN_PERSISTENT_STORAGE",
  ],
  description:
    "Call the local elizaOS Live capability broker. Supported actions: status, privacy_mode, root_status, open_persistent_storage. A verified OWNER in a scoped world is required.",
  parameters: [
    {
      name: "action",
      description:
        "Operation: status, privacy_mode, root_status, open_persistent_storage.",
      required: true,
      schema: { type: "string", enum: [...ACTIONS] },
    },
  ],
  examples: [],
  validate: runnerAvailable,
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    if (!(await hasScopedOwnerAuthority(runtime, message))) {
      return {
        success: false,
        text: "elizaOS capability requires a verified OWNER in a scoped world.",
      };
    }

    const params = record(options?.parameters);
    const content = record(message.content);
    if (hasUnsupportedArguments(params, content)) {
      return {
        success: false,
        text: "elizaOS capability actions do not accept arguments.",
      };
    }

    const action = normalizeAction(params.action ?? content.action);
    if (!action) {
      return { success: false, text: "Invalid elizaOS action." };
    }

    const runner = runnerPath();
    if (!runner || !(await runnerAvailable())) {
      return {
        success: false,
        text: "elizaOS capability broker is unavailable.",
      };
    }

    try {
      const output = await run(runner, RUNNER_COMMANDS[action]);
      const text = output || `elizaOS ${action.replace(/_/g, " ")} completed.`;
      await callback?.({ text, actions: ["ELIZAOS"] });
      return { success: true, text, data: { action, output } };
    } catch (error) {
      // error-policy:J1 the action boundary translates a broker process failure
      // into a planner-visible failure without attempting a broader fallback.
      runtime.logger.error(
        { error, action },
        "[os-capability] elizaOS capability operation failed",
      );
      const detail = record(error);
      const stderr =
        typeof detail.stderr === "string" ? detail.stderr.trim() : "";
      const text =
        stderr || (error instanceof Error ? error.message : String(error));
      await callback?.({ text, actions: ["ELIZAOS"] });
      return { success: false, text, error: text, data: { action } };
    }
  },
};
