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
  type MiladyIntentPlugin,
  MiladyIntentWeb,
  type PairingStatus,
  type ReceiveIntentPayload,
  type ReceiveIntentResult,
  type ScheduleAlarmOptions,
  type ScheduleAlarmResult,
  type SetPairingStatusOptions,
} from "./milady-intent";
export { type NavState, useNavigation, type ViewName } from "./navigation";
export {
  type PushIntent,
  type RegisterPushHandle,
  type RegisterPushOptions,
  registerPush,
  type SessionStartIntent,
} from "./push";
export {
  decodePairingPayload,
  type InputButton,
  type InputEvent,
  type PairingPayload,
  SessionClient,
  type SessionState,
  type TouchGesture,
  type TouchSample,
  type TouchToInputOptions,
  touchToInput,
} from "./session-client";
