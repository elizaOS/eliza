/**
 * SHELL_COMMAND action — runs a shell command on the server.
 *
 * When triggered the action:
 *   1. Extracts the command from the parameters, NL text, or MCP-style JSON
 *   2. POSTs to the local API server to execute it
 *   3. The API broadcasts output via WebSocket for real-time display
 *   4. Optionally captures the output and stores it in bounded clipboard state
 *   5. Returns a descriptive text response
 *
 * @module actions/terminal
 */

import type {
  Action,
  HandlerOptions,
  IAgentRuntime,
  Memory,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import {
  getValidationKeywordTerms,
  textIncludesKeywordTerm,
} from "@elizaos/shared/validation-keywords";
import { hasOwnerAccess } from "../security/access.js";

/** API port for posting terminal requests. */
const API_PORT = process.env.API_PORT || process.env.SERVER_PORT || "2138";

const FAIL = { success: false, text: "" } as const;
const TERMINAL_COMMAND_VERBS = getValidationKeywordTerms(
  "action.terminal.commandVerb",
  {
    includeAllLocales: true,
  },
);
const TERMINAL_COMMAND_FILLERS = getValidationKeywordTerms(
  "action.terminal.commandFiller",
  {
    includeAllLocales: true,
  },
);
const TERMINAL_UTILITY_TERMS = getValidationKeywordTerms(
  "action.terminal.utility",
  {
    includeAllLocales: true,
  },
);
const TERMINAL_BITCOIN_TERMS = getValidationKeywordTerms(
  "action.terminal.cryptoBitcoin",
  {
    includeAllLocales: true,
  },
);
const TERMINAL_ETHEREUM_TERMS = getValidationKeywordTerms(
  "action.terminal.cryptoEthereum",
  {
    includeAllLocales: true,
  },
);
const TERMINAL_SOLANA_TERMS = getValidationKeywordTerms(
  "action.terminal.cryptoSolana",
  {
    includeAllLocales: true,
  },
);
const TERMINAL_DISK_TERMS = getValidationKeywordTerms("action.terminal.disk", {
  includeAllLocales: true,
});
const TERMINAL_UPTIME_TERMS = getValidationKeywordTerms(
  "action.terminal.uptime",
  {
    includeAllLocales: true,
  },
);
const TERMINAL_MEMORY_TERMS = getValidationKeywordTerms(
  "action.terminal.memory",
  {
    includeAllLocales: true,
  },
);
const TERMINAL_PROCESS_TERMS = getValidationKeywordTerms(
  "action.terminal.process",
  {
    includeAllLocales: true,
  },
);

type TerminalActionParameters = {
  arguments?: unknown;
  command?: unknown;
  shellCommand?: unknown;
  addToClipboard?: unknown;
  persistToClipboard?: unknown;
  saveToClipboard?: unknown;
  clipboardTitle?: unknown;
  title?: unknown;
};

type TerminalActionInput = {
  command?: string;
  addToClipboard: boolean;
  clipboardTitle?: string;
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

type ClipboardStoreResult = {
  requested?: boolean;
  stored: boolean;
  replaced?: boolean;
  reason?: string;
  item?: {
    id?: string;
    title?: string;
  };
  snapshot?: {
    items: unknown[];
    maxItems: number;
  };
};

type ClipboardStoreFn = (
  runtime: IAgentRuntime,
  message: Memory,
  options: {
    fallbackTitle: string;
    content: string;
    sourceType: string;
    sourceId: string;
    sourceLabel: string;
  },
) => Promise<ClipboardStoreResult>;

let cachedClipboardStoreFn: ClipboardStoreFn | null | undefined;

function parseBooleanFlag(value: unknown): boolean {
  if (value === true) {
    return true;
  }
  if (typeof value === "string") {
    return /^(true|1|yes|y|on)$/i.test(value.trim());
  }
  return false;
}

function readStringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function escapePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsKeywordTerm(text: string, terms: readonly string[]): boolean {
  return terms.some((term) => textIncludesKeywordTerm(text, term));
}

function stripLeadingCommandFillers(value: string): string {
  let trimmed = value.trim();
  let changed = true;
  const sortedFillers = [...TERMINAL_COMMAND_FILLERS].sort(
    (left, right) => right.length - left.length,
  );

  while (changed && trimmed) {
    changed = false;
    for (const filler of sortedFillers) {
      const pattern = new RegExp(
        `^(?:the\\s+)?${escapePattern(filler).replace(/\\ /g, "\\s+")}\\s*(.*)$`,
        "iu",
      );
      const match = trimmed.match(pattern);
      if (!match?.[1]) {
        continue;
      }
      trimmed = match[1].trim();
      changed = true;
      break;
    }
  }

  return trimmed;
}

function extractTrailingCommandText(text: string): string | undefined {
  const sortedTerms = [...TERMINAL_COMMAND_VERBS].sort(
    (left, right) => right.length - left.length,
  );
  for (const term of sortedTerms) {
    const pattern = new RegExp(
      `${escapePattern(term).replace(/\\ /g, "\\s+")}\\s*(.+)$`,
      "iu",
    );
    const match = text.match(pattern);
    const remainder = match?.[1]?.trim();
    if (!remainder) {
      continue;
    }

    const trimmed = stripLeadingCommandFillers(remainder)
      .replace(/[?.!]+$/g, "")
      .replace(/\s+(?:in|on|from|to|for|at)\s+(?:the\s+)?[\w\s]+$/i, "")
      .trim();
    if (trimmed) {
      return trimmed;
    }
  }

  return undefined;
}

function resolveCryptoCommand(text: string): string | undefined {
  if (containsKeywordTerm(text, TERMINAL_BITCOIN_TERMS)) {
    return 'curl -s "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true"';
  }
  if (containsKeywordTerm(text, TERMINAL_ETHEREUM_TERMS)) {
    return 'curl -s "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd&include_24hr_change=true"';
  }
  if (containsKeywordTerm(text, TERMINAL_SOLANA_TERMS)) {
    return 'curl -s "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd&include_24hr_change=true"';
  }
  return undefined;
}

function parseJsonArguments(
  value: unknown,
): Record<string, unknown> | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value) as Record<string, unknown> | null;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    // Ignore invalid MCP-style argument payloads and fall back to NL parsing.
  }
  return undefined;
}

function resolveClipboardRequested(
  params: TerminalActionParameters,
  argumentParams: Record<string, unknown> | undefined,
  message?: Memory,
): boolean {
  return [
    params.addToClipboard,
    params.persistToClipboard,
    params.saveToClipboard,
    argumentParams?.addToClipboard,
    argumentParams?.persistToClipboard,
    argumentParams?.saveToClipboard,
    message?.content?.addToClipboard,
    message?.content?.persistToClipboard,
    message?.content?.saveToClipboard,
  ].some((value) => parseBooleanFlag(value));
}

function resolveClipboardTitle(
  params: TerminalActionParameters,
  argumentParams: Record<string, unknown> | undefined,
  message?: Memory,
): string | undefined {
  return (
    readStringValue(params.clipboardTitle) ??
    readStringValue(params.title) ??
    readStringValue(argumentParams?.clipboardTitle) ??
    readStringValue(argumentParams?.title) ??
    readStringValue(message?.content?.clipboardTitle) ??
    readStringValue(message?.content?.title)
  );
}

/**
 * Extract a command from handler options and message text.
 *
 * Resolution order:
 *   1. `parameters.command` — explicit parameter
 *   2. `parameters.shellCommand` — explicit alias
 *   3. `parameters.arguments` — MCP-style JSON string like `{"command":"ls"}`
 *   4. Natural language extraction from message text
 */
function getCommand(
  options?: HandlerOptions,
  message?: Memory,
): string | undefined {
  const params = (options?.parameters ?? {}) as TerminalActionParameters;
  const argumentParams = parseJsonArguments(params.arguments);

  const explicitCommand =
    readStringValue(params.command) ??
    readStringValue(params.shellCommand) ??
    readStringValue(argumentParams?.command) ??
    readStringValue(argumentParams?.shellCommand);
  if (explicitCommand) {
    return explicitCommand;
  }

  const text = message?.content?.text;
  if (typeof text === "string" && text.length > 0) {
    const extracted = extractTrailingCommandText(text)
      ?.replace(/^[`'"]+|[`'".!?]+$/g, "")
      .trim();
    if (extracted) {
      return extracted;
    }
  }

  const rawText = text ?? "";
  const cryptoCommand = resolveCryptoCommand(rawText);
  if (cryptoCommand) {
    return cryptoCommand;
  }
  if (containsKeywordTerm(rawText, TERMINAL_DISK_TERMS)) {
    return "df -h /home/eliza";
  }
  if (containsKeywordTerm(rawText, TERMINAL_UPTIME_TERMS)) {
    return "uptime";
  }
  if (containsKeywordTerm(rawText, TERMINAL_MEMORY_TERMS)) {
    return "free -h";
  }
  if (containsKeywordTerm(rawText, TERMINAL_PROCESS_TERMS)) {
    return "ps aux --sort=-rss | head -15";
  }

  return undefined;
}

function resolveTerminalInput(
  options?: HandlerOptions,
  message?: Memory,
): TerminalActionInput {
  const params = (options?.parameters ?? {}) as TerminalActionParameters;
  const argumentParams = parseJsonArguments(params.arguments);

  return {
    command: getCommand(options, message),
    addToClipboard: resolveClipboardRequested(params, argumentParams, message),
    clipboardTitle: resolveClipboardTitle(params, argumentParams, message),
  };
}

function normalizeCapturedRun(
  command: string,
  value: unknown,
): CapturedTerminalRun {
  const data =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
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

async function getClipboardStoreFn(): Promise<ClipboardStoreFn | null> {
  if (cachedClipboardStoreFn !== undefined) {
    return cachedClipboardStoreFn;
  }

  try {
    // clipboard is now built into @elizaos/core advanced-capabilities
    const mod = (await import(
      "@elizaos/core/advanced-capabilities/clipboard/index"
    )) as unknown as {
      maybeStoreTaskClipboardItem?: ClipboardStoreFn;
    };
    cachedClipboardStoreFn =
      typeof mod.maybeStoreTaskClipboardItem === "function"
        ? mod.maybeStoreTaskClipboardItem
        : null;
  } catch (error) {
    cachedClipboardStoreFn = null;
    logger.warn(
      `[terminal] Clipboard plugin unavailable; shell output will not be persisted (${error instanceof Error ? error.message : String(error)})`,
    );
  }

  return cachedClipboardStoreFn;
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

async function maybeStoreCommandOutput(
  runtime: IAgentRuntime | undefined,
  message: Memory,
  input: TerminalActionInput,
  result: CapturedTerminalRun,
) {
  if (!input.addToClipboard) {
    return {
      requested: false,
      stored: false,
    } as const;
  }

  if (!runtime) {
    return {
      requested: true,
      stored: false,
      reason:
        "Runtime unavailable; command output could not be added to the clipboard.",
    } as const;
  }

  const clipboardMessage = {
    ...message,
    content: {
      ...message.content,
      addToClipboard: true,
      ...(input.clipboardTitle ? { clipboardTitle: input.clipboardTitle } : {}),
    },
  } as Memory;

  const storeClipboardItem = await getClipboardStoreFn();
  if (!storeClipboardItem) {
    return {
      requested: true,
      stored: false,
      reason:
        "Clipboard plugin unavailable; command output could not be added to the clipboard.",
    } as const;
  }

  return storeClipboardItem(runtime, clipboardMessage, {
    fallbackTitle: input.clipboardTitle ?? result.command,
    content: buildCommandArtifactContent(result),
    sourceType: "command",
    sourceId: result.command,
    sourceLabel: result.command,
  });
}

function buildCapturedResponseText(
  result: CapturedTerminalRun,
  clipboardResult: Awaited<ReturnType<typeof maybeStoreCommandOutput>>,
): string {
  const clipboardItem = clipboardResult.stored
    ? clipboardResult.item
    : undefined;
  const clipboardSnapshot = clipboardResult.stored
    ? clipboardResult.snapshot
    : undefined;

  return [
    `Executed shell command: \`${result.command}\``,
    `Exit code: ${result.exitCode}`,
    result.timedOut
      ? `Timed out${typeof result.maxDurationMs === "number" ? ` after ${result.maxDurationMs} ms` : ""}.`
      : "",
    result.truncated ? "Captured output truncated to 128 KB." : "",
    clipboardResult.requested
      ? clipboardResult.stored
        ? `${clipboardResult.replaced ? "Updated" : "Added"} clipboard item ${clipboardItem?.id ?? "unknown"}: ${clipboardItem?.title ?? result.command}`
        : `Clipboard add skipped: ${clipboardResult.reason}`
      : "",
    clipboardSnapshot
      ? `Clipboard usage: ${clipboardSnapshot.items.length}/${clipboardSnapshot.maxItems}.`
      : "",
    clipboardSnapshot
      ? "Clear unused clipboard state when it is no longer needed."
      : "",
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

export const terminalAction: Action = {
  name: "SHELL_COMMAND",

  similes: [
    "RUN_IN_TERMINAL",
    "RUN_COMMAND",
    "EXECUTE_COMMAND",
    "TERMINAL",
    "SHELL",
    "RUN_SHELL",
    "EXEC",
    "CALL_MCP_TOOL",
  ],

  description:
    "Run a single explicit shell command that the user provided directly. " +
    "Only use when the user gives a specific command like 'run ls -la' or 'execute npm install'. " +
    "Do NOT use for building projects, creating websites, or multi-step work — use CREATE_TASK instead. " +
    "Set addToClipboard=true to capture the command output, return it inline, and store it in bounded clipboard state.",

  validate: async (runtime, message) => {
    if (!(await hasOwnerAccess(runtime, message))) {
      return false;
    }

    const text = (message?.content?.text ?? "").trim();
    if (!text) return false;
    if (/`[^`]+`/.test(text)) return true;
    if (/```/.test(text)) return true;
    if (extractTrailingCommandText(text)) return true;
    if (containsKeywordTerm(text, TERMINAL_UTILITY_TERMS)) {
      return true;
    }
    if (resolveCryptoCommand(text)) {
      return true;
    }
    if (
      containsKeywordTerm(text, TERMINAL_DISK_TERMS) ||
      containsKeywordTerm(text, TERMINAL_UPTIME_TERMS) ||
      containsKeywordTerm(text, TERMINAL_MEMORY_TERMS) ||
      containsKeywordTerm(text, TERMINAL_PROCESS_TERMS)
    ) {
      return true;
    }
    return false;
  },

  handler: async (runtime, message, _state, options) => {
    if (!(await hasOwnerAccess(runtime, message))) {
      return {
        success: false,
        text: "Permission denied: only the owner may run terminal commands.",
      };
    }

    const input = resolveTerminalInput(
      options as HandlerOptions | undefined,
      message as Memory | undefined,
    );
    const command = input.command;

    if (!command) {
      return FAIL;
    }

    try {
      const response = await fetch(
        `http://localhost:${API_PORT}/api/terminal/run`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            command,
            clientId: "runtime-terminal-action",
            ...(input.addToClipboard ? { captureOutput: true } : {}),
          }),
        },
      );

      if (!response.ok) {
        return FAIL;
      }

      if (!input.addToClipboard) {
        return {
          text: `Running in terminal: \`${command}\``,
          success: true,
          data: { command },
        };
      }

      const capturedRun = normalizeCapturedRun(command, await response.json());
      const clipboardResult = await maybeStoreCommandOutput(
        runtime as IAgentRuntime | undefined,
        message as Memory,
        input,
        capturedRun,
      );

      return {
        text: buildCapturedResponseText(capturedRun, clipboardResult),
        success: true,
        data: {
          ...capturedRun,
          clipboard: clipboardResult,
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
    {
      name: "addToClipboard",
      description:
        "When true, wait for the command to finish, capture stdout/stderr, and store the result in bounded clipboard state.",
      required: false,
      schema: { type: "boolean" as const },
    },
    {
      name: "clipboardTitle",
      description: "Optional clipboard title to use when addToClipboard=true.",
      required: false,
      schema: { type: "string" as const },
    },
  ],
};
