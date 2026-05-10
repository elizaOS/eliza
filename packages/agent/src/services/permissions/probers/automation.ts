/**
 * Automation prober.
 *
 * "Automation" on macOS = TCC's Apple Events service: the right to send
 * scripted commands to another application. Granted per (sender, target)
 * pair. We probe a known-stable target (System Events) because that's
 * what most of our internal AppleScript shellouts use.
 *
 * Native API:
 *   - AEDeterminePermissionToAutomateTarget(target, typeWildCard, typeWildCard, askUserIfNeeded)
 *
 * Without an FFI for AE we shell out to osascript and inspect the error
 * code, same pattern as `notes.ts`.
 */

import type { PermissionState, Prober } from "../contracts.js";
import {
  buildState,
  IS_DARWIN,
  platformUnsupportedState,
  runOsascript,
} from "./_bridge.js";

const ID = "automation" as const;

async function probeAutomationAccess(): Promise<
  "granted" | "denied" | "not-determined"
> {
  const result = await runOsascript(
    'try\n  tell application "System Events" to get name of current user\non error errMsg number errNum\n  return "ERR:" & errNum\nend try',
  );
  if (result === null) return "not-determined";
  if (result.startsWith("ERR:")) {
    const num = parseInt(result.slice(4), 10);
    if (num === -1743 || num === -10004) return "denied";
    return "not-determined";
  }
  return "granted";
}

export const automationProber: Prober = {
  id: ID,

  async check(): Promise<PermissionState> {
    if (!IS_DARWIN) return platformUnsupportedState(ID);
    const status = await probeAutomationAccess();
    return buildState(ID, status, { canRequest: status === "not-determined" });
  },

  async request({ reason: _reason }): Promise<PermissionState> {
    if (!IS_DARWIN) return platformUnsupportedState(ID);
    const status = await probeAutomationAccess();
    return buildState(ID, status, {
      canRequest: status === "not-determined",
      lastRequested: Date.now(),
    });
  },
};
