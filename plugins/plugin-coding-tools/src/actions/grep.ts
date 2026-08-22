/**
 * FILE `grep` handler: content search over the workspace via RipgrepService,
 * rooted at an explicit path or the conversation's SessionCwdService cwd.
 */
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
  // Read-only query: deliberately no visible callback. Raw listings/matches
  // reach the model via the ActionResult and the user via the planner's final
  // message; posting each mid-turn dump spammed chat channels (one message per
  // exploratory call).
  _callback?: HandlerCallback,
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
    const targetPath =
      requestedPath ?? (await session.getExistingCwd(conversationId)).cwd;

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
      return successActionResult(text, {
        matches_count: 0,
        mode,
        truncated: false,
      });
    }

    if (result.exitCode !== 0) {
      return failureToActionResult({
        reason: "command_failed",
        message: `ripgrep exited ${result.exitCode}: ${result.output}`,
      });
    }

    if (result.truncated) {
      return failureToActionResult({
        reason: "io_error",
        message:
          "ripgrep returned incomplete output; narrow the query instead of using a partial result",
      });
    }

    const headLimitRequested = readNumberParam(options, "head_limit");
    const headLimit = Math.max(0, Math.floor(headLimitRequested ?? 0));

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

    const truncated = headTruncated;
    const text =
      outputLines.length === 0 ? "no matches" : outputLines.join("\n");
    coreLogger.debug(
      `${CODING_TOOLS_LOG_PREFIX} GREP pattern=${JSON.stringify(pattern)} mode=${mode} matches=${outputLines.length} truncated=${truncated}`,
    );

    return successActionResult(text, {
      matches_count: outputLines.length,
      mode,
      truncated,
    });
  } catch (error) {
    // error-policy:J1 action boundary; any grep failure becomes a success:false
    // ActionResult carrying the real message, surfaced to the model.
    const messageText = error instanceof Error ? error.message : String(error);
    return failureToActionResult({
      reason: "internal",
      message: `grep failed: ${messageText}`,
    });
  }
}
