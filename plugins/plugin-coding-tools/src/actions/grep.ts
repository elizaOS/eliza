import {
  type ActionResult,
  logger as coreLogger,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
} from "@elizaos/core";

import {
  failureToActionResult,
  readBoolParam,
  readNumberParam,
  readPositiveIntSetting,
  readStringParam,
  successActionResult,
} from "../lib/format.js";
import type {
  RipgrepMode,
  RipgrepOptions,
  RipgrepService,
} from "../services/ripgrep-service.js";
import type { SandboxService } from "../services/sandbox-service.js";
import type { SessionCwdService } from "../services/session-cwd-service.js";
import {
  CODING_TOOLS_LOG_PREFIX,
  RIPGREP_SERVICE,
  SANDBOX_SERVICE,
  SESSION_CWD_SERVICE,
} from "../types.js";

const DEFAULT_HEAD_LIMIT = 250;

function isValidMode(value: string | undefined): value is RipgrepMode {
  return (
    value === "content" || value === "files_with_matches" || value === "count"
  );
}

export async function grepHandler(
  runtime: IAgentRuntime,
  message: Memory,
  _state: State | undefined,
  options: unknown,
  callback?: HandlerCallback,
): Promise<ActionResult> {
  const conversationId =
    message.roomId !== undefined && message.roomId !== null
      ? String(message.roomId)
      : undefined;
  if (!conversationId) {
    return failureToActionResult({
      reason: "missing_param",
      message: "no roomId",
    });
  }

  const pattern = readStringParam(options, "pattern");
  if (!pattern || pattern.length === 0) {
    return failureToActionResult({
      reason: "missing_param",
      message: "pattern is required",
    });
  }

  const sandbox = runtime.getService(SANDBOX_SERVICE) as InstanceType<
    typeof SandboxService
  > | null;
  const session = runtime.getService(SESSION_CWD_SERVICE) as InstanceType<
    typeof SessionCwdService
  > | null;
  const rg = runtime.getService(RIPGREP_SERVICE) as InstanceType<
    typeof RipgrepService
  > | null;
  if (!sandbox || !session || !rg) {
    return failureToActionResult({
      reason: "internal",
      message: "coding-tools services unavailable",
    });
  }

  try {
    const requestedPath = readStringParam(options, "path");
    const targetPath = requestedPath ?? session.getCwd(conversationId);

    const validation = await sandbox.validatePath(conversationId, targetPath);
    if (validation.ok === false) {
      const reason =
        validation.reason === "blocked" ? "path_blocked" : "invalid_param";
      return failureToActionResult({ reason, message: validation.message });
    }
    const resolved = validation.resolved;

    const requestedMode = readStringParam(options, "output_mode");
    const mode: RipgrepMode = isValidMode(requestedMode)
      ? requestedMode
      : "files_with_matches";

    const showLineNumbersParam = readBoolParam(options, "show_line_numbers");
    const showLineNumbers = showLineNumbersParam ?? mode === "content";

    const rgOptions: RipgrepOptions = {
      pattern,
      path: resolved,
      showLineNumbers,
    };
    const glob = readStringParam(options, "glob");
    if (glob !== undefined) rgOptions.glob = glob;
    const type = readStringParam(options, "type");
    if (type !== undefined) rgOptions.type = type;

    const contextBefore = readNumberParam(options, "-B");
    if (contextBefore !== undefined)
      rgOptions.contextBefore = Math.max(0, Math.floor(contextBefore));
    const contextAfter = readNumberParam(options, "-A");
    if (contextAfter !== undefined)
      rgOptions.contextAfter = Math.max(0, Math.floor(contextAfter));
    const contextAround = readNumberParam(options, "-C");
    if (contextAround !== undefined)
      rgOptions.contextAround = Math.max(0, Math.floor(contextAround));

    if (readBoolParam(options, "case_insensitive") === true)
      rgOptions.caseInsensitive = true;
    if (readBoolParam(options, "multiline") === true)
      rgOptions.multiline = true;

    const result = await rg.search(rgOptions, mode);

    if (
      result.exitCode === 1 &&
      (mode === "content" || mode === "files_with_matches")
    ) {
      const text = "no matches";
      if (callback) await callback({ text, source: "coding-tools" });
      return successActionResult(text, {
        matches_count: 0,
        mode,
        truncated: false,
      });
    }

    if (result.exitCode !== 0) {
      return failureToActionResult({
        reason: "command_failed",
        message: `ripgrep exited ${result.exitCode}: ${result.output.slice(0, 500)}`,
      });
    }

    const headLimitRequested = readNumberParam(options, "head_limit");
    const headLimitDefault = readPositiveIntSetting(
      runtime,
      "CODING_TOOLS_GREP_HEAD_LIMIT",
      DEFAULT_HEAD_LIMIT,
    );
    const headLimit =
      headLimitRequested === undefined
        ? headLimitDefault
        : Math.max(0, Math.floor(headLimitRequested));

    const rawLines =
      result.output.length === 0
        ? []
        : result.output.replace(/\n$/, "").split("\n");

    let outputLines = rawLines;
    let headTruncated = false;
    if (headLimit > 0 && rawLines.length > headLimit) {
      outputLines = rawLines.slice(0, headLimit);
      headTruncated = true;
    }

    const truncated = headTruncated || result.truncated;
    const text =
      outputLines.length === 0 ? "no matches" : outputLines.join("\n");

    coreLogger.debug(
      `${CODING_TOOLS_LOG_PREFIX} GREP pattern=${JSON.stringify(pattern)} mode=${mode} matches=${outputLines.length} truncated=${truncated}`,
    );

    if (callback) await callback({ text, source: "coding-tools" });

    return successActionResult(text, {
      matches_count: outputLines.length,
      mode,
      truncated,
    });
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    return failureToActionResult({
      reason: "internal",
      message: `grep failed: ${messageText.slice(0, 500)}`,
    });
  }
}
