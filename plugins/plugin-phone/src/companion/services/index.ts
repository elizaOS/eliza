/**
 * Phone-companion surface — the iOS-paired-handset experience.
 *
 * Originally shipped as a standalone top-level app Capacitor project;
 * folded into the main Eliza iOS bundle so one binary handles both the full
 * Eliza UI and the pairing / chat-mirror / remote-session flow.
 */

export {
  ElizaIntent,
  type ElizaIntentPlugin,
  ElizaIntentWeb,
  type PairingStatus,
  type ReceiveIntentPayload,
  type ReceiveIntentResult,
  type ScheduleAlarmOptions,
  type ScheduleAlarmResult,
  type SetPairingStatusOptions,
} from "./eliza-intent";
export { agentUrl, apnsEnabled, isDev } from "./env";
export { logger } from "./logger";
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
