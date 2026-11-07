/**
 * Reminders prober.
 *
 * LifeOps creates/updates/deletes Apple Reminders through EventKit, so the
 * canonical permission is the native Reminders privacy grant, not Automation.
 */

import { createNativePrivacyProber } from "./_bridge.js";

export const remindersProber = createNativePrivacyProber({
  id: "reminders",
  service: "kTCCServiceReminders",
  pane: "Reminders",
  check: (native) => native.checkRemindersPermission(),
  request: (native) => native.requestRemindersPermission(),
  requestFullAccess: true,
});
