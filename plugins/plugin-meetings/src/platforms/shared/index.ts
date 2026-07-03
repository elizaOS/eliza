/** Shared platform-flow surface. */
export { runMeetingFlow, type RunMeetingFlowArgs } from "./meeting-flow.js";
export {
  launchMeetingBrowser,
  type BrowserChannel,
  type LaunchMeetingBrowserOptions,
  type MeetingBrowser,
} from "./launch.js";
export {
  waitForAnySelector,
  anySelectorVisible,
  anySelectorPresent,
  type SelectorMatch,
} from "./selectors.js";
export type { AdmissionOutcome, PlatformStrategies } from "./strategy.js";
