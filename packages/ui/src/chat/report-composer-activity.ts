/**
 * Fire-and-forget composer activity reporter for chat surfaces. It reports
 * draft lifecycle metadata to the agent while keeping unsent text entirely
 * client-side.
 */
import { logger } from "@elizaos/core";
import { supportsFullAppShellRoutes } from "../api/app-shell-capabilities";
import { getElizaApiBase, getElizaApiToken } from "../utils/eliza-globals";

export type ComposerActivityKind =
  | "typing_started"
  | "typing_paused"
  | "draft_abandoned";

export interface ComposerActivityReport {
  activity: ComposerActivityKind;
  surface: string;
  conversationId?: string | null;
  draftLength: number;
  idleForMs?: number;
  reason?: "cleared" | "blurred" | "conversation_switched" | "unknown";
  occurredAt?: string;
}

/** Report composer lifecycle metadata to the agent without blocking input. */
export function reportComposerActivity(report: ComposerActivityReport): void {
  try {
    const base = getElizaApiBase();
    if (!base || typeof fetch === "undefined") return;
    if (!supportsFullAppShellRoutes(base)) return;
    const token = getElizaApiToken();
    void fetch(`${base}/api/interactions/composer`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        activity: report.activity,
        surface: report.surface,
        ...(report.conversationId
          ? { conversationId: report.conversationId }
          : {}),
        draftLength: report.draftLength,
        ...(report.idleForMs !== undefined
          ? { idleForMs: report.idleForMs }
          : {}),
        ...(report.reason ? { reason: report.reason } : {}),
        occurredAt: report.occurredAt ?? new Date().toISOString(),
      }),
    }).catch((err) => {
      // error-policy:J7 telemetry write must not break typing; warn keeps a dead
      // reporting endpoint observable in the browser console.
      logger.warn(
        `[reportComposerActivity] composer report failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  } catch (err) {
    // error-policy:J7 same guard for synchronous setup failures — telemetry
    // must never break composer input.
    logger.warn(
      `[reportComposerActivity] composer report setup failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
