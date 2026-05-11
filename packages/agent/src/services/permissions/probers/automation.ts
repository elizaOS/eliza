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
 * Without an FFI for AE we read TCC.db for check() and reserve osascript
 * for request(), where a prompt is expected.
 */

import type { PermissionState, Prober } from "../contracts.js";
import {
  buildState,
  IS_DARWIN,
  platformUnsupportedState,
  queryAppleEventsTccStatus,
  runOsascript,
} from "./_bridge.js";

const ID = "automation" as const;
const SYSTEM_EVENTS_BUNDLE_ID = "com.apple.systemevents";

async function checkAutomationAccess(): Promise<
  "granted" | "denied" | "not-determined"
> {
  return (
    (await queryAppleEventsTccStatus(SYSTEM_EVENTS_BUNDLE_ID)) ??
    "not-determined"
  );
}

export const automationProber: Prober = {
  id: ID,

  async check(): Promise<PermissionState> {
    if (!IS_DARWIN) return platformUnsupportedState(ID);
    const status = await checkAutomationAccess();
    return buildState(ID, status, { canRequest: status === "not-determined" });
  },

  async request({ reason: _reason }): Promise<PermissionState> {
    if (!IS_DARWIN) return platformUnsupportedState(ID);
    await runOsascript(
      'tell application "System Events" to get name of current user',
    );
    const status = await checkAutomationAccess();
    return buildState(ID, status, {
      canRequest: status === "not-determined",
      lastRequested: Date.now(),
    });
  },
};
