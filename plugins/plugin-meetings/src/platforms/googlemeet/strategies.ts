/**
 * Google Meet `PlatformStrategies` — binds the modular join/admission/
 * recording/removal/leave ports to the shared flow contract. No platform
 * branching lives here; the flow calls these in order.
 */

import type { Page } from "playwright-core";
import type { MeetingBotSession } from "../../types.js";
import type { InputDriver } from "../humanized/index.js";
import type {
  AdmissionOutcome,
  PlatformStrategies,
} from "../shared/strategy.js";
import { checkAdmissionSilent, waitForAdmission } from "./admission.js";
import { joinGoogleMeeting } from "./join.js";
import { leaveGoogleMeet } from "./leave.js";
import { startGoogleRecording } from "./recording.js";
import { startRemovalMonitor } from "./removal.js";

export function createGoogleMeetStrategies(
  input: InputDriver,
): PlatformStrategies {
  return {
    join: (page: Page, session: MeetingBotSession) =>
      joinGoogleMeeting(page, session, input),
    waitForAdmission: (
      page: Page,
      session: MeetingBotSession,
      timeoutMs: number,
    ): Promise<AdmissionOutcome> =>
      waitForAdmission(page, session.signal, timeoutMs),
    checkAdmissionSilent: (page: Page) => checkAdmissionSilent(page),
    // Meet needs no pre-recording browser setup: audio capture installs its own
    // binding at startRecording time, and the leave control is queried live.
    prepare: async () => {},
    startRecording: (page: Page, session: MeetingBotSession) =>
      startGoogleRecording(page, session),
    startRemovalMonitor: (page: Page, session: MeetingBotSession) =>
      startRemovalMonitor(page, session.signal),
    leave: (page: Page) => leaveGoogleMeet(page),
  };
}
