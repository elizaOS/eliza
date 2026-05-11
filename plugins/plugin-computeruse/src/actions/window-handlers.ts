/**
 * Pure handler for the WINDOW parent action. Takes the live
 * `ComputerUseService` and resolved params, executes the underlying
 * window-management call, and returns an `ActionResult`.
 */

import type { ActionResult, HandlerCallback } from "@elizaos/core";
import type { ComputerUseService } from "../services/computer-use-service.js";
import type {
  WindowActionParams,
  WindowActionResult,
} from "../types.js";
import { toComputerUseActionResult } from "./helpers.js";

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
