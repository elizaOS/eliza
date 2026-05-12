/**
 * Notes prober.
 *
 * Notes.app is automation-only — there's no NotesKit framework. We probe
 * via TCC's automation service: kTCCServiceAppleEvents with the Notes
 * bundle id (`com.apple.Notes`) as the indirect_object_identifier.
 *
 * The TCC.db row for Apple Events lives in the `access` table with a
 * composite key, so we use `_bridge.queryAppleEventsTccStatus` for read-only
 * checks and reserve AppleScript for explicit request() calls.
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
  queryAppleEventsTccStatus,
  runOsascript,
} from "./_bridge.js";

const ID = "notes" as const;
const NOTES_BUNDLE_ID = "com.apple.Notes";

async function checkNotesAccess(): Promise<
  "granted" | "denied" | "not-determined"
> {
  return (await queryAppleEventsTccStatus(NOTES_BUNDLE_ID)) ?? "not-determined";
}

export const notesProber: Prober = {
  id: ID,

  async check(): Promise<PermissionState> {
    if (!IS_DARWIN) return platformUnsupportedState(ID);
    const status = await checkNotesAccess();
    return buildState(ID, status, { canRequest: status === "not-determined" });
  },

  async request({ reason: _reason }): Promise<PermissionState> {
    if (!IS_DARWIN) return platformUnsupportedState(ID);
    await runOsascript('tell application "Notes" to count of folders');
    const status = await checkNotesAccess();
    return buildState(ID, status, {
      canRequest: status === "not-determined",
      lastRequested: Date.now(),
    });
  },
};
