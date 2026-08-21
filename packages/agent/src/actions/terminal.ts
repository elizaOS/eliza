/**
 * TERMINAL_SHELL action — runs one explicit shell command on the server.
 *
 * When triggered the action:
 *   1. Extracts the command from parameters or MCP-style JSON
 *   2. POSTs to the local API server to execute it
 *   3. The API broadcasts output via WebSocket for real-time display
 *   4. Captures the output for planner follow-up
 *   5. Stores the full output as a document attachment for follow-up actions
 *
 * The loopback POST to `/api/terminal/run` uses
 * `TERMINAL_RUN_FETCH_TIMEOUT_MS` so a hung API cannot stall TERMINAL_SHELL.
 *
 * @module actions/terminal
 */

import { randomUUID } from "node:crypto";
import type {
  Action,
  ActionExample,
  EffectReceipt,
  HandlerOptions,
  IAgentRuntime,
  JsonValue,
  Media,
  Memory,
} from "@elizaos/core";
import {
  buildStoreVariantBlockedMessage,
  ContentType,
  ElizaError,
  isLocalCodeExecutionAllowed,
  logger,
  redactSensitiveText,
  stringToUuid,
  truncateWellFormed,
} from "@elizaos/core";
import { readAliasedEnv, resolveServerOnlyPort } from "@elizaos/shared";
import { resolveTerminalRunLimits } from "../api/terminal-run-limits.ts";
import { normalizeTerminalCommand } from "../utils/terminal-command.ts";

const TERMINAL_ACTION_NAME = "TERMINAL_SHELL";
/** HTTP bound for the loopback `/api/terminal/run` hop. Longer than the API's 30s command cap so honest `timedOut` JSON can still return. */
export const TERMINAL_RUN_FETCH_TIMEOUT_MS = 60_000;
const MAX_TERMINAL_DATA_CHARS = 16000;
const TERMINAL_TRANSPORT_GRACE_MS = 10_000;
const MAX_TERMINAL_RESPONSE_BYTES = 2 * 1024 * 1024;
// Max sanitized stdout, in chars, that may be relayed verbatim as the user-facing
// message. Small single-line results (a SHA, a count, a path) are useful to
// echo for "run X and tell me the value" turns; anything larger — or with
// multiple lines — must NOT be dumped to the (possibly shared) channel.
const TERMINAL_RELAY_MAX_CHARS = 200;

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
  runId: string;
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

type AbortAwareHandlerOptions = HandlerOptions & {
  abortSignal?: AbortSignal;
};

function callerAbortSignal(
  options: HandlerOptions | undefined,
): AbortSignal | undefined {
  const signal = (options as AbortAwareHandlerOptions | undefined)?.abortSignal;
  return signal instanceof AbortSignal ? signal : undefined;
}

/** @internal Exported for deterministic transport-boundary tests. */
export function resolveTerminalTransportTimeoutMs(): number {
  return resolveTerminalRunLimits().maxDurationMs + TERMINAL_TRANSPORT_GRACE_MS;
}

async function cancelResponseBody(
  body: ReadableStream<Uint8Array> | null,
  reason: unknown,
): Promise<void> {
  if (!body) return;
  try {
    await body.cancel(reason);
  } catch (error) {
    // error-policy:J6 response cancellation is teardown-only; the original
    // bounded-read failure remains authoritative.
    logger.warn({ error }, "[terminal] Failed to cancel response body");
  }
}

async function readTerminalResponseJson(
  response: Response,
  signal: AbortSignal,
): Promise<JsonValue> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^\d+$/u.test(declaredLength)) {
      await cancelResponseBody(
        response.body,
        "Terminal response had an invalid Content-Length",
      );
      throw new ElizaError("Terminal response had an invalid Content-Length", {
        code: "TERMINAL_RESPONSE_INVALID",
        severity: "fatal",
      });
    }
    if (Number(declaredLength) > MAX_TERMINAL_RESPONSE_BYTES) {
      await cancelResponseBody(
        response.body,
        "Terminal response exceeded the byte limit",
      );
      throw new ElizaError("Terminal response exceeded the byte limit", {
        code: "TERMINAL_RESPONSE_INVALID",
        severity: "fatal",
      });
    }
  }

  if (!response.body) {
    throw new ElizaError("Terminal response omitted its body", {
      code: "TERMINAL_RESPONSE_INVALID",
      severity: "fatal",
    });
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      reject(
        signal.reason ??
          new DOMException("Terminal request aborted", "AbortError"),
      );
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });

  try {
    signal.throwIfAborted();
    while (true) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_TERMINAL_RESPONSE_BYTES) {
        await reader.cancel("Terminal response exceeded the byte limit");
        throw new ElizaError("Terminal response exceeded the byte limit", {
          code: "TERMINAL_RESPONSE_INVALID",
          severity: "fatal",
        });
      }
      chunks.push(value);
    }
  } catch (error) {
    if (signal.aborted) {
      try {
        await reader.cancel(signal.reason);
      } catch (cancelError) {
        // error-policy:J6 response cancellation is teardown-only; preserve the
        // caller or transport abort reason.
        logger.warn(
          { error: cancelError },
          "[terminal] Failed to cancel aborted response body",
        );
      }
      throw signal.reason ?? error;
    }
    throw error;
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }

  let text: string;
  try {
    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    // error-policy:J2 malformed transport bytes become a typed boundary error.
    throw new ElizaError("Terminal response was not valid UTF-8", {
      code: "TERMINAL_RESPONSE_INVALID",
      cause: error,
      severity: "fatal",
    });
  }

  try {
    return JSON.parse(text) as JsonValue;
  } catch (error) {
    // error-policy:J2 the terminal boundary requires a structured response;
    // preserve the parser error for the runtime's action failure channel.
    throw new ElizaError("Terminal execution response was not valid JSON", {
      code: "TERMINAL_RESPONSE_INVALID",
      cause: error,
      severity: "fatal",
    });
  }
}

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
    // error-policy:J3 planner arguments are untrusted input. Invalid JSON is
    // treated as an absent wrapper so the explicit typed parameters still win.
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
  const command = getCommand(options);
  return {
    command: command ? normalizeTerminalCommand(command) : undefined,
  };
}

function normalizeCapturedRun(
  command: string,
  value: JsonValue,
  expectedRunId?: string,
): CapturedTerminalRun {
  if (!isJsonRecord(value)) {
    throw new ElizaError("Terminal response was not an object", {
      code: "TERMINAL_RESPONSE_INVALID",
      severity: "fatal",
    });
  }
  const runId = readStringValue(value.runId);
  if (
    value.ok !== true ||
    !runId ||
    (expectedRunId !== undefined && runId !== expectedRunId) ||
    typeof value.exitCode !== "number" ||
    !Number.isInteger(value.exitCode) ||
    typeof value.stdout !== "string" ||
    typeof value.stderr !== "string" ||
    typeof value.timedOut !== "boolean" ||
    typeof value.truncated !== "boolean"
  ) {
    throw new ElizaError("Terminal response omitted required execution proof", {
      code: "TERMINAL_RESPONSE_INVALID",
      context: {
        hasRunId: Boolean(runId),
        ...(expectedRunId !== undefined
          ? { expectedRunId, receivedRunId: runId }
          : {}),
        hasExitCode:
          typeof value.exitCode === "number" &&
          Number.isInteger(value.exitCode),
      },
      severity: "fatal",
    });
  }

  return {
    command,
    runId,
    exitCode: value.exitCode,
    stdout: value.stdout,
    stderr: value.stderr,
    timedOut: value.timedOut,
    truncated: value.truncated,
    maxDurationMs:
      typeof value.maxDurationMs === "number" &&
      Number.isFinite(value.maxDurationMs)
        ? value.maxDurationMs
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

/** @internal Exported for deterministic boundary tests. */
export function buildOutputPreview(content: string, maxLength = 3_000): string {
  if (maxLength <= 0) return "";
  const trimmed = content.trimEnd();
  if (trimmed.length <= maxLength) {
    return truncateWellFormed(formatOutputBlock(trimmed), maxLength);
  }

  const suffixFor = (omittedChars: number) =>
    `\n\n[... ${omittedChars} chars omitted; use the attachment for full output ...]`;
  const retainedBudget = Math.max(
    0,
    maxLength - suffixFor(trimmed.length).length,
  );
  const prefix = truncateWellFormed(trimmed, retainedBudget).trimEnd();
  const suffix = suffixFor(trimmed.length - prefix.length);

  return prefix.length + suffix.length <= maxLength
    ? `${prefix}${suffix}`
    : truncateWellFormed(trimmed, maxLength);
}

/** @internal Exported for deterministic boundary tests. */
export function truncateForData(
  text: string,
  max = MAX_TERMINAL_DATA_CHARS,
): string {
  if (max <= 0) return "";
  if (text.length <= max) return text;
  const suffix = "\n…[truncated]";
  if (max <= suffix.length) return truncateWellFormed(text, max);
  return `${truncateWellFormed(text, max - suffix.length)}${suffix}`;
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
    `terminal-output:${message.id ?? message.roomId}:${result.runId}:${Date.now()}`,
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
    // error-policy:J4 the execution result and inline output remain explicit
    // while attachment persistence degrades to an unpersisted attachment.
    logger.warn(
      `[terminal] Failed to store shell output attachment (${error instanceof Error ? error.message : String(error)})`,
    );
    return { attachment };
  }
}

function terminalEffectReceipt(
  result: CapturedTerminalRun,
  outputAttachment: TerminalOutputAttachment | undefined,
  observedAt: string,
): EffectReceipt {
  const base = {
    receiptId: `terminal-run:${result.runId}`,
    operation: "system.shell.execute",
    resource: { kind: "terminal.run", id: result.runId },
    artifacts: outputAttachment
      ? [
          {
            kind: "terminal.output",
            id: outputAttachment.attachment.id,
            ...(outputAttachment.memoryId
              ? { version: outputAttachment.memoryId }
              : {}),
          },
        ]
      : [],
    idempotency: { key: null, replayed: false },
    observedAt,
  } as const;
  if (result.exitCode === 0 && !result.timedOut) {
    return {
      ...base,
      outcome: "applied",
      commit: {
        kind: "provider_accepted",
        id: result.runId,
        committedAt: observedAt,
      },
    };
  }
  return {
    ...base,
    outcome: "failed",
    failure: {
      code: result.timedOut
        ? "TERMINAL_EXECUTION_TIMED_OUT"
        : "TERMINAL_EXECUTION_FAILED",
      retryable: false,
      acceptance: result.timedOut ? "unknown" : "rejected",
    },
  };
}

function terminalUserFacingText(
  result: CapturedTerminalRun,
  cleanStdout: string,
): string {
  if (result.timedOut) {
    return `The command timed out${typeof result.maxDurationMs === "number" ? ` after ${result.maxDurationMs} ms` : ""}; I can't verify that it completed.`;
  }
  if (result.exitCode !== 0) {
    return `The command failed with exit code ${result.exitCode}.`;
  }
  if (!cleanStdout) {
    return "The command finished successfully with exit code 0.";
  }
  // Treat every JavaScript line terminator as a channel-visible line break.
  // In particular, terminal programs commonly emit bare carriage returns;
  // counting only `\n` would let a short multi-line payload bypass the relay cap.
  const lineCount = cleanStdout.split(/\r\n|[\n\r\u2028\u2029]/u).length;
  if (cleanStdout.length <= TERMINAL_RELAY_MAX_CHARS && lineCount === 1) {
    return cleanStdout;
  }
  return `The command finished (exit 0) with ${lineCount} line${lineCount === 1 ? "" : "s"} of output; ask me about specifics instead of dumping it into chat.`;
}

/**
 * One projection boundary for every terminal consumer: runtime-known secrets
 * first (character-configured values), then shape-based tools redaction
 * (Bearer, CLI flags, URI userinfo, token prefixes). Lightweight/test runtimes
 * may stub `redactSecrets` as identity, so the pattern pass remains required.
 */
function redactCapturedTerminalText(
  runtime: IAgentRuntime,
  text: string,
): string {
  return redactSensitiveText(runtime.redactSecrets(text), { mode: "tools" });
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

  // Declared shell-direct behavior class (see SHELL_DIRECT_ACTION_TAGS in
  // core/services/message/direct-action-heuristics). The core message pipeline
  // resolves shell-direct routing/termination off these tags first, so this
  // action can rename itself without breaking the pipeline; the legacy name/
  // simile list remains only as a covered compatibility fallback.
  tags: [
    "domain:system",
    "resource:shell",
    "capability:execute",
    "effect:receipt-required",
  ],

  similes: ["RUN_IN_TERMINAL", "EXECUTE_COMMAND", "TERMINAL", "RUN_SHELL"],

  description:
    "Run a single explicit shell command that the user provided directly. " +
    "Only use when the user gives a specific command like 'run ls -la' or 'execute npm install'. " +
    "Do NOT use for building projects, creating websites, or multi-step work — use START_CODING_TASK instead. " +
    "The command output is captured as a document attachment for native planner follow-up. After the run, decide whether to reply, stay silent, continue with another action, or save the attachment via the clipboard plugin.",
  descriptionCompressed:
    "run one explicit shell command; not build/create/multi-step -> START_CODING_TASK",
  routingHint:
    "run ONE explicit user-provided command and capture its output as an attachment in the terminal view -> TERMINAL_SHELL; general shell/build/history or scripted commands -> SHELL (coding-tools); multi-step dev work -> START_CODING_TASK; MCP tools -> MCP",

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

    const input = resolveTerminalInput(options as HandlerOptions | undefined);
    const command = input.command;

    if (!command) {
      return {
        success: false,
        text: "A non-empty shell command is required.",
        error: "TERMINAL_COMMAND_REQUIRED",
      };
    }

    const terminalToken = readAliasedEnv("ELIZA_TERMINAL_RUN_TOKEN");
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (terminalToken) {
      headers["X-Eliza-Terminal-Token"] = terminalToken;
    }
    const runId = `run-${randomUUID()}`;
    headers["X-Eliza-Terminal-Run-Id"] = runId;
    const callerSignal = callerAbortSignal(
      options as HandlerOptions | undefined,
    );
    callerSignal?.throwIfAborted();
    const transportTimeoutMs = resolveTerminalTransportTimeoutMs();
    const transportSignal = AbortSignal.timeout(transportTimeoutMs);
    const requestSignal = callerSignal
      ? AbortSignal.any([callerSignal, transportSignal])
      : transportSignal;

    let response: Response;
    try {
      response = await fetch(
        `http://localhost:${resolveServerOnlyPort(process.env)}/api/terminal/run`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            command,
            clientId: "runtime-terminal-action",
            captureOutput: true,
            ...(terminalToken ? { terminalToken } : {}),
          }),
          signal: requestSignal,
        },
      );
    } catch (error) {
      if (callerSignal?.aborted) {
        throw callerSignal.reason ?? error;
      }
      // error-policy:J2 once dispatch begins, a transport failure cannot prove
      // whether the server accepted the command. Preserve the client-selected
      // run identity so the caller can reconcile the operation before retrying.
      throw new ElizaError("Terminal execution outcome is unknown", {
        code: "TERMINAL_REQUEST_OUTCOME_UNKNOWN",
        context: {
          acceptance: "unknown",
          runId,
          transportTimeoutMs,
        },
        cause: error,
        severity: "fatal",
      });
    }

    if (!response.ok) {
      await cancelResponseBody(
        response.body,
        `Terminal request rejected with HTTP ${response.status}`,
      );
      throw new ElizaError("Terminal execution request was rejected", {
        code: "TERMINAL_REQUEST_FAILED",
        context: { status: response.status },
        severity: "ephemeral",
      });
    }

    let responseBody: JsonValue;
    try {
      responseBody = await readTerminalResponseJson(response, requestSignal);
    } catch (error) {
      if (callerSignal?.aborted) {
        throw callerSignal.reason ?? error;
      }
      if (transportSignal.aborted) {
        // error-policy:J2 response headers do not prove completion. Bind the
        // ambiguous result to the same run identity used by the server.
        throw new ElizaError("Terminal execution outcome is unknown", {
          code: "TERMINAL_REQUEST_OUTCOME_UNKNOWN",
          context: {
            acceptance: "unknown",
            runId,
            transportTimeoutMs,
          },
          cause: error,
          severity: "fatal",
        });
      }
      throw error;
    }
    const rawRun = normalizeCapturedRun(command, responseBody, runId);
    // Sanitize once before constructing model text, bounded action data, the
    // user-facing relay, attachments, or persisted attachment memory.
    const capturedRun: CapturedTerminalRun = {
      ...rawRun,
      command: redactCapturedTerminalText(runtime, rawRun.command),
      stdout: redactCapturedTerminalText(runtime, rawRun.stdout),
      stderr: redactCapturedTerminalText(runtime, rawRun.stderr),
    };
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

    const cleanStdout =
      capturedRun.exitCode === 0 &&
      !capturedRun.timedOut &&
      !capturedRun.truncated &&
      capturedRun.stderr.trim().length === 0
        ? capturedRun.stdout.trim()
        : "";
    const observedAt = new Date().toISOString();
    const effectReceipt = terminalEffectReceipt(
      capturedRun,
      outputAttachment,
      observedAt,
    );
    const userFacingText = terminalUserFacingText(capturedRun, cleanStdout);
    const succeeded =
      effectReceipt.outcome === "applied" && capturedRun.exitCode === 0;

    return {
      text: buildCapturedResponseText(capturedRun, outputAttachment),
      success: succeeded,
      userFacingText,
      // Raw stdout stays available as the deterministic fallback relay for
      // "run X" turns, but must not carry the do-not-paraphrase stamp: verified
      // text outranks and prepends to the evaluator's prose in the final-message
      // precedence, which shipped bare command output (e.g. a `git ls-remote`
      // SHA line) as a leading junk paragraph before the natural reply. Only
      verifiedUserFacing: cleanStdout.length === 0,
      effectReceipts: [effectReceipt],
      userFacingEffectReceiptIds: [effectReceipt.receiptId],
      ...(succeeded
        ? {}
        : {
            error:
              effectReceipt.outcome === "failed"
                ? effectReceipt.failure.code
                : "TERMINAL_EXECUTION_FAILED",
          }),
      data: {
        actionName: TERMINAL_ACTION_NAME,
        ...boundedRun,
        outputAttachment: outputAttachment?.attachment,
        outputAttachmentMemoryId: outputAttachment?.memoryId,
        suppressVisibleCallback: true,
      },
    };
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
