/**
 * Calendar prober.
 */

import { createNativePrivacyProber } from "./_bridge.js";

export const calendarProber = createNativePrivacyProber({
  id: "calendar",
  service: "kTCCServiceCalendar",
  pane: "Calendars",
  check: (native) => native.checkCalendarPermission(),
  request: (native) => native.requestCalendarPermission(),
  requestFullAccess: true,
});
