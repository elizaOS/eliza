/**
 * Platform host detection for LifeOps features that depend on macOS-only
 * native bridges (osascript, native-activity-tracker, iMessage chat.db).
 *
 * Centralized so plugin registration, action handlers, and connector
 * dispatchers all read the same predicate.
 */

import type { ActionResult } from "@elizaos/core";

export function isDarwin(): boolean {
  return process.platform === "darwin";
}

export function darwinUnavailableActionResult(args: {
  actionName: string;
  connector?: string;
  subaction?: string;
  feature: string;
}): ActionResult {
  const detail = `${args.feature} is macOS-only and unavailable on ${process.platform}.`;
  return {
    success: false,
    text: `[${args.actionName}] ${detail}`,
    data: {
      actionName: args.actionName,
      ...(args.connector ? { connector: args.connector } : {}),
      ...(args.subaction ? { subaction: args.subaction } : {}),
      error: "PLATFORM_UNSUPPORTED",
      platform: process.platform,
    },
  };
}
