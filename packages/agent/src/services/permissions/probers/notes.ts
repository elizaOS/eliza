/**
 * Notes prober.
 *
 * Notes.app is automation-only — there's no NotesKit framework. We probe
 * via TCC's automation service: kTCCServiceAppleEvents with the Notes
 * bundle id (`com.apple.Notes`) as the indirect_object_identifier.
 *
 * The TCC.db row for Apple Events lives in the `access` table with a
 * composite key, so the simple bundle-id query in `_bridge.queryTccStatus`
 * doesn't quite fit. We fall back to AppleScript and treat a successful
 * round-trip as "granted".
 *
 * NOTE: This prober is scoped to Notes.app specifically. The general
 * `automation` prober probes a different target (System Events). We keep
 * them separate because the user can grant one without the other.
 */

import type { PermissionState, Prober } from "../contracts.js";
import {
  buildState,
  IS_DARWIN,
  platformUnsupportedState,
  runOsascript,
} from "./_bridge.js";

const ID = "notes" as const;

async function probeNotesAccess(): Promise<
  "granted" | "denied" | "not-determined"
> {
  // Read-only probe: count notes folders. AppleScript returns:
  //   - a number on success (granted)
  //   - errors with code -1743 (not-allowed by user) when denied
  //   - errors with code -600 / launch failures when not-determined
  const result = await runOsascript(
    'try\n  tell application "Notes" to count of folders\non error errMsg number errNum\n  return "ERR:" & errNum\nend try',
  );
  if (result === null) return "not-determined";
  if (result.startsWith("ERR:")) {
    const num = parseInt(result.slice(4), 10);
    // -1743 = "Not authorized to send Apple events"
    // -10004 = "Privilege violation"
    if (num === -1743 || num === -10004) return "denied";
    return "not-determined";
  }
  return "granted";
}

export const notesProber: Prober = {
  id: ID,

  async check(): Promise<PermissionState> {
    if (!IS_DARWIN) return platformUnsupportedState(ID);
    const status = await probeNotesAccess();
    return buildState(ID, status, { canRequest: status === "not-determined" });
  },

  async request({ reason: _reason }): Promise<PermissionState> {
    if (!IS_DARWIN) return platformUnsupportedState(ID);
    // Same shellout — the act of running it triggers the TCC prompt.
    const status = await probeNotesAccess();
    return buildState(ID, status, {
      canRequest: status === "not-determined",
      lastRequested: Date.now(),
    });
  },
};
