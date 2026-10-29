import type { Logger, LoggerBindings } from "@elizaos/core/logging";
import { ElizaError, sanitizeSpeechText } from "@elizaos/core/speech";
import { parseVoiceUiContext } from "@elizaos/host/voice/ui-context";
import {
  editTextControl,
  isEditableTextControl,
} from "@elizaos/ui/text-control-editing";
import {
  type BatchVoiceAwaitingUserInput,
  BatchVoiceConversation,
  type BatchVoicePorts,
  type BatchVoiceReply,
} from "@elizaos/ui/voice/batch-conversation";
import {
  DraftTranscriptGuard,
  type DraftTranscriptResult,
} from "@elizaos/ui/voice/draft-transcript-guard";
import {
  observeMicrophonePause,
  startCumulativeMicrophoneCapture,
} from "@elizaos/ui/voice/microphone-capture";
import { encodeMonoPcm16Wav } from "@elizaos/ui/voice/pcm-wave";
import { attachProgressiveSpeech } from "@elizaos/ui/voice/progressive-speech-playback";
import {
  RecordedTranscriptionController,
  RecordedTranscriptionError,
} from "@elizaos/ui/voice/recorded-transcription-controller";
import {
  SegmentedSpeechPlayback,
  SpeechPlaybackError,
} from "@elizaos/ui/voice/segmented-speech-playback";
import {
  createVoiceSessionClient,
  type VoiceSessionClientOptions,
} from "@elizaos/ui/voice/voice-session-client";
import {
  buildVoiceTurnSignal,
  type VoiceTurnSignal,
} from "@elizaos/voice/turn";

export function createConversation(ports: BatchVoicePorts<Blob>) {
  const signal: VoiceTurnSignal = buildVoiceTurnSignal("Hello.", {});
  const text: string = sanitizeSpeechText("Hello.");
  const error: Error = new ElizaError(text, { code: "CONSUMER_CHECK" });
  return { conversation: new BatchVoiceConversation(ports), signal, error };
}

export function finishPausedTurn(
  conversation: BatchVoiceConversation<Blob>,
  pause: BatchVoiceAwaitingUserInput,
  reply: BatchVoiceReply,
): boolean {
  return conversation.resume({ pause, reply });
}

export function leafEntries(field: EventTarget | null, stream: MediaStream) {
  const guard = new DraftTranscriptGuard();
  const apply: (text: string, final: boolean) => DraftTranscriptResult =
    guard.begin((original, transcript) => original + transcript);
  const wav: Uint8Array = encodeMonoPcm16Wav(new Float32Array(1), 16000);
  const editable: boolean =
    isEditableTextControl(field, ["text"]) &&
    editTextControl(field, { kind: "insert", text: "a" });
  const stopPause: () => void = observeMicrophonePause(stream, () => {}, {
    silenceMs: 800,
    speechThreshold: 0.02,
    speechFrames: 2,
    pollMs: 50,
    fftSize: 512,
  });
  const attach: typeof attachProgressiveSpeech = attachProgressiveSpeech;
  const recordingError: RecordedTranscriptionError =
    new RecordedTranscriptionError("empty-audio");
  const playbackError: SpeechPlaybackError = new SpeechPlaybackError(
    "playback",
  );
  const controller: typeof RecordedTranscriptionController =
    RecordedTranscriptionController;
  const playback: typeof SegmentedSpeechPlayback = SegmentedSpeechPlayback;
  const capture: typeof startCumulativeMicrophoneCapture =
    startCumulativeMicrophoneCapture;
  return {
    apply,
    wav,
    editable,
    stopPause,
    attach,
    recordingError,
    playbackError,
    controller,
    playback,
    capture,
  };
}

export function createRealtimeConversation(options: VoiceSessionClientOptions) {
  return createVoiceSessionClient(options);
}

export function scopedLogger(logger: Logger, bindings: LoggerBindings) {
  return logger.child(bindings);
}

export const voiceUiContext = parseVoiceUiContext({ uiViewPath: "/chat" });

// @ts-expect-error A non-dashboard host must provide its authenticated fetch.
const withoutTransport: VoiceSessionClientOptions = {
  agentId: "agent",
  conversationId: "conversation",
  getConsentNonce: async () => "consent",
};
void withoutTransport;
