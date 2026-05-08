/**
 * Pure handler functions for the DESKTOP parent action — one per op group.
 *
 * Each handler takes the live `ComputerUseService` instance and the resolved
 * params object, executes the underlying service call, and returns an
 * `ActionResult`. Format/text helpers stay local to this file so the parent
 * action only does dispatch.
 *
 * Logic preserved verbatim from the original per-verb actions
 * (file-action.ts / manage-window.ts / terminal-action.ts).
 */

import type { ActionResult, HandlerCallback } from "@elizaos/core";
import type { ComputerUseService } from "../services/computer-use-service.js";
import type {
  FileActionParams,
  FileActionResult,
  TerminalActionParams,
  TerminalActionResult,
  WindowActionParams,
  WindowActionResult,
} from "../types.js";
import { toComputerUseActionResult } from "./helpers.js";

export const DESKTOP_OPS = ["file", "window", "terminal"] as const;
export type DesktopOp = (typeof DESKTOP_OPS)[number];

// ── file op ───────────────────────────────────────────────────────────────

const MAX_FILE_RESULT_BYTES = 4000;

function formatFileResultText(result: FileActionResult): string {
  if (!result.success) {
    return `File action failed: ${result.error}`;
  }
  return (
    result.content ??
    result.message ??
    (result.items
      ? `Listed ${result.count ?? result.items.length} filesystem entries.`
      : "File action completed.")
  );
}

export async function handleFileOp(
  service: ComputerUseService,
  params: FileActionParams,
  callback?: HandlerCallback,
): Promise<ActionResult> {
  if (!params.action) {
    if (callback) {
      await callback({ text: "File op requires an action." });
    }
    return { success: false, error: "Missing file action" };
  }

  const result = await service.executeFileAction(params);
  const text = formatFileResultText(result).slice(0, MAX_FILE_RESULT_BYTES);

  if (callback) {
    await callback({ text });
  }

  return toComputerUseActionResult({
    action: params.action,
    result,
    text,
  });
}

// ── window op ─────────────────────────────────────────────────────────────

const MAX_WINDOW_ROWS = 50;
const MAX_WINDOW_ROW_BYTES = 120;

function formatWindowResultText(
  params: WindowActionParams,
  result: WindowActionResult,
): string {
  if (result.windows) {
    const windowText =
      result.windows.length > 0
        ? result.windows
            .map((w) => `[${w.id}] ${w.app} - ${w.title}`)
            .join("\n")
        : "No visible windows found.";
    return `Open windows:\n${windowText}`;
  }

  return result.success
    ? (result.message ?? `Window ${params.action} completed.`)
    : result.approvalRequired
      ? `Window action is waiting for approval (${result.approvalId}).`
      : `Window action failed: ${result.error}`;
}

export async function handleWindowOp(
  service: ComputerUseService,
  params: WindowActionParams,
  callback?: HandlerCallback,
): Promise<ActionResult> {
  params.action ??= "list";

  const result = await service.executeWindowAction(params);
  const text = formatWindowResultText(params, result).slice(
    0,
    MAX_WINDOW_ROWS * MAX_WINDOW_ROW_BYTES,
  );

  if (callback) {
    await callback({ text });
  }

  return toComputerUseActionResult({
    action: params.action,
    result,
    text,
    suppressClipboard: true,
  });
}

// ── terminal op ───────────────────────────────────────────────────────────

const MAX_TERMINAL_RESULT_BYTES = 4000;
const MAX_TERMINAL_TIMEOUT_SECONDS = 120;
const DEFAULT_TERMINAL_TIMEOUT_SECONDS = 30;

function formatTerminalResultText(result: TerminalActionResult): string {
  return result.success
    ? (result.output ?? result.message ?? "Terminal action completed.")
    : `Terminal action failed: ${result.error}`;
}

export async function handleTerminalOp(
  service: ComputerUseService,
  params: TerminalActionParams,
  callback?: HandlerCallback,
): Promise<ActionResult> {
  if (!params.action && params.command) {
    params.action = "execute";
  }
  if (!params.action) {
    if (callback) {
      await callback({ text: "Terminal op requires an action." });
    }
    return { success: false, error: "Missing terminal action" };
  }

  const timeoutSeconds = Math.min(
    Number(
      params.timeout ?? params.timeoutSeconds ?? DEFAULT_TERMINAL_TIMEOUT_SECONDS,
    ),
    MAX_TERMINAL_TIMEOUT_SECONDS,
  );
  const result = await service.executeTerminalAction({
    ...params,
    timeout: timeoutSeconds,
  });
  const text = formatTerminalResultText(result).slice(
    0,
    MAX_TERMINAL_RESULT_BYTES,
  );

  if (callback) {
    await callback({ text });
  }

  return toComputerUseActionResult({
    action: params.action,
    result,
    text,
    suppressClipboard: true,
  });
}
