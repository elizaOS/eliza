/**
 * `eliza.native-transcript/v1` — the typed event and projection contract shared
 * by the iOS, Android, desktop, and web hosts, plus the product renderer that
 * displays each validated host projection in the common React chat surface.
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
  hasLiveNativeTranscriptContent,
  LiveNativeTranscript,
  type LiveNativeTranscriptProps,
  LiveNativeTranscriptView,
  type LiveNativeTranscriptViewProps,
  useLiveNativeTranscript,
} from "./LiveNativeTranscript";
export {
  acceptNativeTranscriptViewModel,
  applyRendererTranscriptEvents,
  getNativeTranscriptSnapshot,
  type NativeTranscriptSnapshot,
  type NativeTranscriptViewAcceptanceResult,
  type NativeTranscriptViewSource,
  resetNativeTranscriptStoreForTests,
  subscribeNativeTranscript,
} from "./live-store";
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
  TranscriptView,
  type TranscriptViewProps,
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
  decodeTranscriptViewModel,
  type TranscriptViewModelDecodeError,
  type TranscriptViewModelDecodeResult,
} from "./view-model-decode";
export {
  nativeTranscriptInputFromVoiceServerEvent,
  publishVoiceServerTranscriptEvent,
} from "./voice-event-adapter";
