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

const OPERATIONS = [
  "root-status",
  "service",
  "package",
  "network",
  "power",
  "exec",
] as const;

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
    return false;
  }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((part) => typeof part !== "string")) {
    return [];
  }
  return value;
}

function run(runner: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      runner,
      args,
      { encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 120_000 },
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

export const osCapabilityAction: Action = {
  name: "ELIZAOS",
  contexts: ["automation", "agent_internal", "settings", "code"],
  roleGate: { minRole: "USER" },
  similes: [
    "ELIZAOS_ROOT_STATUS",
    "ELIZAOS_SERVICE",
    "ELIZAOS_PACKAGE",
    "ELIZAOS_NETWORK",
    "ELIZAOS_POWER",
    "ELIZAOS_ROOT_EXEC",
  ],
  description:
    "Operate the local elizaOS device through its audited root capability broker. Use operation=exec with an argv array for an owner-authorized arbitrary root command.",
  parameters: [
    {
      name: "operation",
      description: "Broker operation.",
      required: true,
      schema: { type: "string", enum: [...OPERATIONS] },
    },
    {
      name: "args",
      description:
        "Argument vector after the operation. For exec, start with -- followed by an absolute executable path and its arguments.",
      required: false,
      schema: { type: "array", items: { type: "string" } },
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
    const params = record(options?.parameters);
    const content = record(message.content);
    const operation = params.operation ?? content.operation;
    if (
      typeof operation !== "string" ||
      !OPERATIONS.includes(operation as (typeof OPERATIONS)[number])
    ) {
      return { success: false, text: "Invalid elizaOS operation." };
    }
    const args = stringArray(params.args ?? content.args);
    const runner = runnerPath();
    if (!runner || !(await runnerAvailable())) {
      return {
        success: false,
        text: "elizaOS capability broker is unavailable.",
      };
    }

    try {
      const output = await run(runner, [operation, ...args]);
      const text = output || `elizaOS ${operation} completed.`;
      await callback?.({ text, actions: ["ELIZAOS"] });
      return { success: true, text, data: { operation, output } };
    } catch (error) {
      runtime.logger.error(
        { error, operation },
        "elizaOS capability operation failed",
      );
      const detail = record(error);
      const stderr =
        typeof detail.stderr === "string" ? detail.stderr.trim() : "";
      const text =
        stderr || (error instanceof Error ? error.message : String(error));
      await callback?.({ text, actions: ["ELIZAOS"] });
      return { success: false, text, error: text, data: { operation } };
    }
  },
};
