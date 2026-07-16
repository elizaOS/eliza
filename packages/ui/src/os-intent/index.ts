/**
 * `eliza.os-intent/v1` — the one structural intent vocabulary + routing authority
 * that unifies chat, voice, and transcription launches across iOS/Android/desktop
 * entry points. Types + constants (`contract`), boundary decoder + native-launch
 * adapters (`decode`), stable-id dedupe store (`dedupe`), the structural routing
 * authority (`router`), and the executor that applies routed commands to the one
 * shell controller (`apply-command`).
 */

export {
  applyOsIntentCommand,
  applyOsIntentCommands,
  type IntentControllerTarget,
} from "./apply-command";
export {
  AUTO_START_INTENT_TYPES,
  type ContinueConversationIntent,
  INTENT_PREREQUISITES,
  INTENT_SOURCES,
  INTENT_TARGET,
  type IntentBlockReason,
  type IntentControllerCommand,
  type IntentControllerCommandKind,
  type IntentDegradeReason,
  type IntentOutcome,
  type IntentOutcomeStatus,
  type IntentPrerequisite,
  type IntentSource,
  type IntentTarget,
  type OpenChatIntent,
  OS_INTENT_SCHEMA,
  OS_INTENT_TYPES,
  type OsIntent,
  type OsIntentSchema,
  type OsIntentType,
  type SendIntent,
  type StartTranscriptionIntent,
  type StartVoiceIntent,
  type StopTranscriptionIntent,
  type StopVoiceIntent,
} from "./contract";
export {
  decodeDeepLinkIntent,
  decodeOsIntent,
  fromAssistantLaunchPayload,
  type IntentDecodeError,
  type IntentDecodeErrorCode,
  type IntentDecodeResult,
} from "./decode";
export {
  type AppliedIntentRecord,
  IntentDedupeStore,
  type IntentDedupeStoreOptions,
} from "./dedupe";
export {
  type AuthState,
  intentTarget,
  type MicPermissionState,
  type RoutingContext,
  routeIntent,
} from "./router";
