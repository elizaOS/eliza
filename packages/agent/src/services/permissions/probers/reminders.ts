/**
 * Reminders prober.
 *
 * Native APIs (macOS):
 *   - check:   EKEventStore.authorizationStatus(for: .reminder)
 *   - request: EKEventStore.requestFullAccessToReminders (macOS 14+) or
 *              .requestAccess(to: .reminder) (older)
 *
 * We don't have an FFI binding for EventKit yet, so we use TCC.db reads
 * for the check path (service: kTCCServiceReminders) and an osascript
 * shellout to trigger the prompt for the request path. The osascript
 * targets Reminders.app — since macOS 14 split this into "reminders" and
 * "calendar" TCC services, we read kTCCServiceReminders explicitly.
 *
 * INTEGRATION TODO: ship a small Swift FFI that calls
 * `EKEventStore.authorizationStatus(for: .reminder)` directly. The osascript
 * approach can race with TCC.db caching. See `accessibility.ts` for the
 * pattern.
 */

import type { PermissionState, Prober } from "../contracts.js";
import {
  buildState,
  IS_DARWIN,
  platformUnsupportedState,
  queryTccStatus,
  resolveBundleId,
  runOsascript,
} from "./_bridge.js";

const ID = "reminders" as const;

export const remindersProber: Prober = {
  id: ID,

  async check(): Promise<PermissionState> {
    if (!IS_DARWIN) return platformUnsupportedState(ID);

    const tcc = await queryTccStatus("kTCCServiceReminders", resolveBundleId());
    if (tcc === "granted")
      return buildState(ID, "granted", { canRequest: false });
    if (tcc === "denied")
      return buildState(ID, "denied", { canRequest: false });
    return buildState(ID, "not-determined", { canRequest: true });
  },

  async request({ reason: _reason }): Promise<PermissionState> {
    if (!IS_DARWIN) return platformUnsupportedState(ID);
    // Trigger the OS prompt by issuing a benign read against Reminders.
    // `count of lists` is read-only; macOS will surface the consent
    // dialog the first time the runtime calls this.
    await runOsascript('tell application "Reminders" to count of lists');
    const state = await remindersProber.check();
    return { ...state, lastRequested: Date.now() };
  },
};
