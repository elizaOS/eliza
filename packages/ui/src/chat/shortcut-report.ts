/** Reports keyboard and palette interactions and defines settings navigation events. */
import { logger } from "@elizaos/shared/logger";
import { getElizaApiBase, getElizaApiToken } from "../utils/eliza-globals";
export const NAVIGATE_SETTINGS_EVENT = "eliza:navigate:settings";
/** Shortcut report POST — independent hop, own 15s deadline. */
const SHORTCUT_FETCH_TIMEOUT_MS = 15_000;

async function postShortcutReport(args: {
  base: string;
  token?: string | null;
  shortcutId: string;
  context?: string;
}): Promise<void> {
  const res = await fetch(`${args.base}/api/interactions/shortcut`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(args.token ? { Authorization: `Bearer ${args.token}` } : {}),
    },
    body: JSON.stringify({
      shortcutId: args.shortcutId,
      ...(args.context ? { context: args.context } : {}),
    }),
    signal: AbortSignal.timeout(SHORTCUT_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(
      `POST /api/interactions/shortcut returned HTTP ${res.status}`,
    );
  }
  await res.arrayBuffer();
}

/**
 * Report a user-fired keyboard / command-palette shortcut to the agent (#8792).
 * Fire-and-forget, fully guarded: a failure here must never break the shortcut.
 * The server emits SHORTCUT_FIRED for the proactive decider, which decides
 * (governed) whether a scoped comment helps. Only meaningful, intent-bearing
 * shortcuts should report — not every keystroke — to keep the judge cheap.
 */
export function reportShortcutFired(
  shortcutId: string,
  context?: string,
): void {
  try {
    const base = getElizaApiBase();
    if (!base || typeof fetch === "undefined") return;
    const token = getElizaApiToken();
    void postShortcutReport({ base, token, shortcutId, context }).catch(
      (err) => {
        // error-policy:J7 telemetry write must not break the shortcut; warn keeps
        // a dead reporting endpoint observable in the console.
        logger.warn(
          `[ShortcutReporter] shortcut report failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      },
    );
  } catch (error) {
    // error-policy:J7 telemetry setup must not interrupt a keyboard shortcut.
    logger.warn(`[ShortcutReporter] setup failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export interface NavigateSettingsDetail {
  section?: string;
}
