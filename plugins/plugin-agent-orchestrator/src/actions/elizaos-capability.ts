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

type ElizaOsCapabilityOp =
  | "status"
  | "privacy_mode"
  | "root_status"
  | "open_persistent_storage";

const DEFAULT_RUNNER = "/usr/local/lib/elizaos/capability-runner";
const OPS: readonly ElizaOsCapabilityOp[] = [
  "status",
  "privacy_mode",
  "root_status",
  "open_persistent_storage",
] as const;

const RUNNER_COMMANDS: Record<ElizaOsCapabilityOp, string> = {
  status: "status",
  privacy_mode: "privacy-mode",
  root_status: "root-status",
  open_persistent_storage: "open-persistent-storage",
};

function normalizeOp(value: unknown): ElizaOsCapabilityOp | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  return (OPS as readonly string[]).includes(normalized)
    ? (normalized as ElizaOsCapabilityOp)
    : undefined;
}

function contentRecord(message: Memory): Record<string, unknown> {
  return message.content && typeof message.content === "object"
    ? (message.content as Record<string, unknown>)
    : {};
}

function paramsRecord(options?: HandlerOptions): Record<string, unknown> {
  const params = options?.parameters;
  return params && typeof params === "object"
    ? (params as Record<string, unknown>)
    : {};
}

function runnerPath(): string | undefined {
  const configured = process.env.ELIZAOS_CAPABILITY_RUNNER?.trim();
  if (configured) return configured;
  return process.env.ELIZAOS_EDITION ? DEFAULT_RUNNER : undefined;
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function parseKeyValues(stdout: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of stdout.split(/\r?\n/)) {
    const index = line.indexOf("=");
    if (index <= 0) continue;
    values[line.slice(0, index)] = line.slice(index + 1);
  }
  return values;
}

function runBroker(
  runner: string,
  command: string,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      runner,
      [command],
      {
        encoding: "utf8",
        maxBuffer: 64 * 1024,
        timeout: 5000,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(Object.assign(error, { stdout, stderr }));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

async function emit(
  callback: HandlerCallback | undefined,
  text: string,
): Promise<void> {
  if (callback) await callback({ text });
}

function resultText(op: ElizaOsCapabilityOp, stdout: string): string {
  const trimmed = stdout.trim();
  if (!trimmed) return `elizaOS ${op} completed.`;
  if (op === "privacy_mode") return `elizaOS privacy mode: ${trimmed}`;
  return `elizaOS ${op.replace(/_/g, " ")}:\n${trimmed}`;
}

function failureText(error: unknown): string {
  if (error && typeof error === "object") {
    const withOutput = error as { stderr?: unknown; message?: unknown };
    if (typeof withOutput.stderr === "string" && withOutput.stderr.trim()) {
      return withOutput.stderr.trim();
    }
    if (typeof withOutput.message === "string" && withOutput.message.trim()) {
      return withOutput.message.trim();
    }
  }
  return "elizaOS capability broker failed.";
}

export const elizaOsCapabilityAction: Action = {
  name: "ELIZAOS",
  contexts: ["automation", "agent_internal", "settings"],
  roleGate: { minRole: "USER" },
  similes: [
    "ELIZAOS_STATUS",
    "ELIZAOS_PRIVACY_MODE",
    "ELIZAOS_ROOT_STATUS",
    "ELIZAOS_PERSISTENT_STORAGE",
    "OPEN_PERSISTENT_STORAGE",
  ],
  description:
    "Call the local elizaOS Live capability broker. Supported actions: status, privacy_mode, root_status, open_persistent_storage. This is a constrained OS bridge for the Tails-based live USB; destructive root actions are intentionally not exposed.",
  descriptionCompressed:
    "elizaOS Live broker: status|privacy_mode|root_status|open_persistent_storage via constrained local OS bridge",
  parameters: [
    {
      name: "action",
      description:
        "Operation: status, privacy_mode, root_status, open_persistent_storage.",
      required: true,
      schema: { type: "string" as const, enum: [...OPS] },
    },
  ],
  validate: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
  ): Promise<boolean> => {
    const runner = runnerPath();
    return runner ? isExecutable(runner) : false;
  },
  handler: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const params = paramsRecord(options);
    const content = contentRecord(message);
    const op =
      normalizeOp(params.action) ??
      normalizeOp(params.op) ??
      normalizeOp(content.action) ??
      "status";
    const runner = runnerPath();

    if (!runner || !(await isExecutable(runner))) {
      return {
        success: false,
        error: "elizaOS capability broker is not available in this runtime.",
        text: "elizaOS capability broker is not available in this runtime.",
      };
    }

    try {
      const command = RUNNER_COMMANDS[op];
      const { stdout } = await runBroker(runner, command);
      const text = resultText(op, stdout);
      await emit(callback, text);
      return {
        success: true,
        text,
        data: {
          action: op,
          values: parseKeyValues(stdout),
        },
      };
    } catch (error) {
      const text = failureText(error);
      await emit(callback, text);
      return { success: false, error: text, text };
    }
  },
};
