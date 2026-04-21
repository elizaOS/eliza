/**
 * Phone-companion surface — the iOS-paired-handset experience.
 *
 * Originally shipped as a standalone `apps/app-ios-companion` Capacitor app;
 * folded into the main Milady iOS bundle so one binary handles both the full
 * Milady UI and the pairing / chat-mirror / remote-session flow.
 */

export { agentUrl, apnsEnabled, isDev } from "./env";
export { forwardIntent } from "./intent-bridge";
export { logger } from "./logger";
export {
  MiladyIntent,
  MiladyIntentWeb,
  type MiladyIntentPlugin,
  type PairingStatus,
  type ReceiveIntentPayload,
  type ReceiveIntentResult,
  type ScheduleAlarmOptions,
  type ScheduleAlarmResult,
} from "./milady-intent";
export { useNavigation, type NavState, type ViewName } from "./navigation";
export {
  registerPush,
  type PushIntent,
  type RegisterPushHandle,
  type RegisterPushOptions,
  type SessionStartIntent,
} from "./push";
export {
  decodePairingPayload,
  SessionClient,
  touchToInput,
  type InputButton,
  type InputEvent,
  type PairingPayload,
  type SessionState,
  type TouchGesture,
  type TouchSample,
  type TouchToInputOptions,
} from "./session-client";
