/**
 * SHELL action — runs a shell command on the server.
 *
 * When triggered the action:
 *   1. Extracts the command from parameters or MCP-style JSON
 *   2. POSTs to the local API server to execute it
 *   3. The API broadcasts output via WebSocket for real-time display
 *   4. Captures the output for planner follow-up
 *   5. Stores the full output as a document attachment for follow-up actions
 *
 * @module actions/terminal
 */

import type {
  Action,
  ActionExample,
  HandlerOptions,
  IAgentRuntime,
  JsonValue,
  Media,
  Memory,
} from "@elizaos/core";
import {
  buildStoreVariantBlockedMessage,
  ContentType,
  isLocalCodeExecutionAllowed,
  logger,
  stringToUuid,
} from "@elizaos/core";
import { hasOwnerAccess } from "../security/access.ts";

/** API port for posting terminal requests. */
const API_PORT = process.env.API_PORT || process.env.SERVER_PORT || "2138";
const TERMINAL_ACTION_NAME = "SHELL";
const MAX_TERMINAL_DATA_CHARS = 16000;

const FAIL = { success: false, text: "" } as const;

type TerminalActionParameters = {
  arguments?: JsonValue;
  command?: JsonValue;
  shellCommand?: JsonValue;
};

type TerminalActionInput = {
  command?: string;
};

type CapturedTerminalRun = {
  command: string;
  runId?: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  maxDurationMs?: number;
};

type TerminalOutputAttachment = {
  attachment: Media;
  memoryId?: string;
};

function readStringValue(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isJsonRecord(value: JsonValue): value is Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseJsonArguments(
  value: JsonValue | undefined,
): Record<string, JsonValue> | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value) as JsonValue;
    if (isJsonRecord(parsed)) {
      return parsed;
    }
  } catch {
    // Ignore invalid MCP-style argument payloads and fall back to NL parsing.
  }
  return undefined;
}

/**
 * Extract a command from handler options and message text.
 *
 * Resolution order:
 *   1. `parameters.command` — explicit parameter
 *   2. `parameters.shellCommand` — explicit alias
 *   3. `parameters.arguments` — MCP-style JSON string like `{"command":"ls"}`
 */
function getCommand(options?: HandlerOptions): string | undefined {
  const params = (options?.parameters ?? {}) as TerminalActionParameters;
  const argumentParams = parseJsonArguments(params.arguments);

  // The planner must extract the command as an explicit `command` param.
  // We intentionally do not fall back to regex-scraping the message text or
  // keyword-matching the request for hardcoded commands ("free -h" for
  // "memory", etc.) — that would be intent classification in the handler
  // instead of in the LLM planner, which bypasses the LLM's judgment on
  // safety, scope, and argument construction.
  return (
    readStringValue(params.command) ??
    readStringValue(params.shellCommand) ??
    readStringValue(argumentParams?.command) ??
    readStringValue(argumentParams?.shellCommand)
  );
}

function resolveTerminalInput(options?: HandlerOptions): TerminalActionInput {
  return {
    command: getCommand(options),
  };
}

function normalizeCapturedRun(
  command: string,
  value: JsonValue,
): CapturedTerminalRun {
  const data = isJsonRecord(value) ? value : {};
  const exitCode =
    typeof data.exitCode === "number" && Number.isFinite(data.exitCode)
      ? data.exitCode
      : Number(data.exitCode ?? 0) || 0;

  return {
    command,
    runId: readStringValue(data.runId),
    exitCode,
    stdout: typeof data.stdout === "string" ? data.stdout : "",
    stderr: typeof data.stderr === "string" ? data.stderr : "",
    timedOut: data.timedOut === true,
    truncated: data.truncated === true,
    maxDurationMs:
      typeof data.maxDurationMs === "number" &&
      Number.isFinite(data.maxDurationMs)
        ? data.maxDurationMs
        : undefined,
  };
}

function formatOutputBlock(content: string): string {
  return content.trimEnd() || "(empty)";
}

function buildCommandArtifactContent(result: CapturedTerminalRun): string {
  return [
    `Command: ${result.command}`,
    `Exit code: ${result.exitCode}`,
    result.timedOut
      ? `Timed out: yes${typeof result.maxDurationMs === "number" ? ` (${result.maxDurationMs} ms limit)` : ""}`
      : "Timed out: no",
    result.truncated ? "Captured output truncated to 128 KB." : "",
    "",
    "STDOUT:",
    formatOutputBlock(result.stdout),
    "",
    "STDERR:",
    formatOutputBlock(result.stderr),
  ]
    .filter(Boolean)
    .join("\n");
}

function buildOutputPreview(content: string, maxLength = 3_000): string {
  const trimmed = content.trimEnd();
  if (trimmed.length <= maxLength) {
    return formatOutputBlock(trimmed);
  }
  return `${trimmed.slice(0, maxLength).trimEnd()}\n\n[... ${trimmed.length - maxLength} chars omitted; use the attachment for full output ...]`;
}

function truncateForData(text: string, max = MAX_TERMINAL_DATA_CHARS): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…[truncated]`;
}

async function createCommandOutputAttachment(
  runtime: IAgentRuntime | undefined,
  message: Memory,
  result: CapturedTerminalRun,
): Promise<TerminalOutputAttachment | undefined> {
  if (!runtime?.createMemory) {
    return undefined;
  }

  const attachmentId = stringToUuid(
    `terminal-output:${message.id ?? message.roomId}:${result.runId ?? result.command}:${Date.now()}`,
  );
  const title = `Shell output: ${result.command}`;
  const attachment: Media = {
    id: attachmentId,
    url: `memory://terminal-output/${attachmentId}`,
    title,
    source: TERMINAL_ACTION_NAME,
    description: `Full stdout/stderr for \`${result.command}\` (exit ${result.exitCode}).`,
    text: buildCommandArtifactContent(result),
    contentType: ContentType.DOCUMENT,
  };

  try {
    const memoryId = await runtime.createMemory(
      {
        id: stringToUuid(`terminal-output-memory:${attachmentId}`),
        entityId: runtime.agentId,
        agentId: runtime.agentId,
        roomId: message.roomId,
        createdAt: Date.now(),
        content: {
          text: `Stored terminal output attachment ${attachment.id}: ${attachment.title}`,
          source: TERMINAL_ACTION_NAME,
          attachments: [attachment],
        },
      },
      "messages",
    );

    return { attachment, memoryId };
  } catch (error) {
    logger.warn(
      `[terminal] Failed to store shell output attachment (${error instanceof Error ? error.message : String(error)})`,
    );
    return { attachment };
  }
}

function buildCapturedResponseText(
  result: CapturedTerminalRun,
  outputAttachment: TerminalOutputAttachment | undefined,
): string {
  const outputContent = buildCommandArtifactContent(result);

  return [
    `Shell command completed: \`${result.command}\``,
    `Exit code: ${result.exitCode}`,
    result.timedOut
      ? `Timed out${typeof result.maxDurationMs === "number" ? ` after ${result.maxDurationMs} ms` : ""}.`
      : "",
    result.truncated ? "Captured output truncated to 128 KB." : "",
    outputAttachment
      ? `Full output attachment: ${outputAttachment.attachment.id} (${outputAttachment.attachment.title})`
      : "",
    outputAttachment?.memoryId
      ? `Attachment memory: ${outputAttachment.memoryId}`
      : outputAttachment
        ? "Attachment memory could not be persisted; full output is still present in this action result."
        : "No attachment was stored for this output.",
    "",
    "Output preview:",
    buildOutputPreview(outputContent),
    "",
    "Next-step contract for the planner:",
    "- Decide whether to reply to the user, stay silent, or continue with another action.",
    "- If the output should be kept for this task, call SAVE_ATTACHMENT_TO_CLIPBOARD with the attachmentId above.",
    "- If replying, answer naturally from the output instead of echoing this report.",
  ]
    .filter(Boolean)
    .join("\n");
}

export const terminalAction: Action = {
  name: TERMINAL_ACTION_NAME,
  contexts: ["terminal", "code", "files", "admin"],
  roleGate: { minRole: "OWNER" },

  similes: [
    "RUN_IN_TERMINAL",
    "RUN_COMMAND",
    "EXECUTE_COMMAND",
    "TERMINAL",
    "RUN_SHELL",
    "EXEC",
    "CALL_MCP_TOOL",
  ],

  description:
    "Run a single explicit shell command that the user provided directly. " +
    "Only use when the user gives a specific command like 'run ls -la' or 'execute npm install'. " +
    "Do NOT use for building projects, creating websites, or multi-step work — use START_CODING_TASK instead. " +
    "The command output is captured as a document attachment for native planner follow-up. After the run, decide whether to reply, stay silent, continue with another action, or save the attachment via the clipboard plugin.",
  descriptionCompressed:
    "run single explicit shell command user provide directly use user give specific command like run ls - la execute npm install use build project, create website, multi-step work use START_CODING_TASK instead command output captur document attachment native planner follow-up after run, decide whether reply, stay silent, continue w/ another action, save attachment via clipboard plugin",

  validate: async () => isLocalCodeExecutionAllowed(),

  handler: async (runtime, message, _state, options) => {
    if (!isLocalCodeExecutionAllowed()) {
      return {
        success: false,
        text: buildStoreVariantBlockedMessage("Terminal commands"),
        data: {
          actionName: TERMINAL_ACTION_NAME,
          suppressPostActionContinuation: true,
          terminal: { storeBuildBlocked: true },
        },
      };
    }

    if (!(await hasOwnerAccess(runtime, message))) {
      return {
        success: false,
        text: "Permission denied: only the owner may run terminal commands.",
        data: {
          actionName: TERMINAL_ACTION_NAME,
          suppressPostActionContinuation: true,
          terminal: { permissionDenied: true },
        },
      };
    }

    const input = resolveTerminalInput(options as HandlerOptions | undefined);
    const command = input.command;

    if (!command) {
      return FAIL;
    }

    try {
      const terminalToken = process.env.ELIZA_TERMINAL_RUN_TOKEN?.trim();
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (terminalToken) {
        headers["X-Eliza-Terminal-Token"] = terminalToken;
      }

      const response = await fetch(
        `http://localhost:${API_PORT}/api/terminal/run`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            command,
            clientId: "runtime-terminal-action",
            captureOutput: true,
            ...(terminalToken ? { terminalToken } : {}),
          }),
        },
      );

      if (!response.ok) {
        return FAIL;
      }

      const responseBody = (await response.json()) as JsonValue;
      const capturedRun = normalizeCapturedRun(command, responseBody);
      const boundedRun = {
        ...capturedRun,
        stdout: truncateForData(capturedRun.stdout),
        stderr: truncateForData(capturedRun.stderr),
      };
      const outputAttachment = await createCommandOutputAttachment(
        runtime,
        message,
        capturedRun,
      );

      return {
        text: buildCapturedResponseText(capturedRun, outputAttachment),
        success: true,
        data: {
          actionName: TERMINAL_ACTION_NAME,
          ...boundedRun,
          outputAttachment: outputAttachment?.attachment,
          outputAttachmentMemoryId: outputAttachment?.memoryId,
          suppressVisibleCallback: true,
        },
      };
    } catch {
      return FAIL;
    }
  },

  parameters: [
    {
      name: "command",
      description: "The shell command to execute in the terminal",
      required: true,
      schema: { type: "string" as const },
    },
  ],
  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "Run ls -la in my home directory.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "The directory listing completed. It shows the current files and folders in your home directory.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Execute `git status` and save the output so I can look at it later.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "The `git status` output was captured. I saved the full output as an attachment and can keep it in the clipboard if it is useful for the next step.",
        },
      },
    ],
  ] as ActionExample[][],
};
