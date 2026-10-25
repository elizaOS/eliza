/** Shared platform-flow surface. */

export {
  type BrowserChannel,
  type LaunchMeetingBrowserOptions,
  launchMeetingBrowser,
  type MeetingBrowser,
} from "./launch.js";
export { type RunMeetingFlowArgs, runMeetingFlow } from "./meeting-flow.js";
export {
  anySelectorPresent,
  anySelectorVisible,
  type SelectorMatch,
  waitForAnySelector,
} from "./selectors.js";
export type { AdmissionOutcome, PlatformStrategies } from "./strategy.js";
