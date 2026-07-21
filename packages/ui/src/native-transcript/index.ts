/**
 * `eliza.native-transcript/v1` — the one typed transcript-event contract shared
 * by the iOS, Android, desktop, and web shells. Types + schema (`contract`),
 * boundary decoder (`decode`), pure reducer (`reduce`), and the web/DOM renderer
 * (`TranscriptEventView`).
 */

export {
  publishNativeAgentText,
  publishNativeToolState,
} from "./chat-event-adapter";
export {
  type AgentTextEvent,
  type AgentTranscriptItem,
  type AgentTurnStatus,
  type AudioPhase,
  type CancelEvent,
  type CancelScope,
  type ConnectionState,
  type ErrorTranscriptItem,
  NATIVE_TRANSCRIPT_SCHEMA,
  type NativeTranscriptSchema,
  type ReconnectEvent,
  type ReconnectPhase,
  type ReconnectTranscriptItem,
  type SpeakingState,
  type SttFinalEvent,
  type SttPartialEvent,
  type ToolItemStatus,
  type ToolPhase,
  type ToolStateEvent,
  type ToolTranscriptItem,
  TRANSCRIPT_EVENT_TYPES,
  type TranscriptErrorEvent,
  type TranscriptEvent,
  type TranscriptEventStream,
  type TranscriptEventType,
  type TranscriptEventWord,
  type TranscriptItem,
  type TranscriptItemKind,
  type TranscriptViewModel,
  type TtsAudioEvent,
  type UserTranscriptItem,
  type UserTurnStatus,
} from "./contract";
export {
  decodeTranscriptEvent,
  decodeTranscriptStream,
  type TranscriptDecodeError,
  type TranscriptDecodeErrorCode,
  type TranscriptDecodeResult,
  type TranscriptStreamDecodeResult,
} from "./decode";
export {
  applyTranscriptEvent,
  initialReducerState,
  reduceTranscriptEvents,
  type TranscriptReducerState,
  toViewModel,
} from "./reduce";
export {
  TranscriptEventView,
  type TranscriptEventViewProps,
  useTranscriptEvents,
} from "./TranscriptEventView";
export {
  NATIVE_TRANSCRIPT_RENDERER_EVENT,
  type NativeTranscriptEventInput,
  publishNativeTranscriptEvent,
  publishNativeTranscriptEvents,
  resetNativeTranscriptSequenceForTests,
} from "./transport";
export {
  nativeTranscriptInputFromVoiceServerEvent,
  publishVoiceServerTranscriptEvent,
} from "./voice-event-adapter";
