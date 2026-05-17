/**
 * Bidirectional voice hook for chat + avatar lip sync.
 *
 * TTS providers (in priority order):
 *  1. ElevenLabs  — streaming endpoint; assistant replies enqueue text deltas as
 *     the stream grows (no sentence-boundary wait — lower time-to-first-audio).
 *  2. Browser SpeechSynthesis — fallback when ElevenLabs isn't configured.
 *
 * STT: local-inference ASR on local desktop, then native TalkMode or browser
 * SpeechRecognition fallback.
 */
import type { VoiceConfig } from "../api/client";
import { queueableSpeechPrefix, remainderAfter, splitFirstSentence, toSpeakableText } from "../voice/voice-chat-playback";
import { mergeTranscriptWindows } from "../voice/voice-chat-recording";
import { resolveEffectiveVoiceConfig, resolveVoiceMode, resolveVoiceProxyEndpoint, type VoiceChatOptions, type VoiceChatState, webSpeechVoiceDebugFields } from "../voice/voice-chat-types";
export { nextIdleMouthOpen } from "../voice/voice-chat-playback";
export type { QueueAssistantSpeechOptions, VoiceAssistantSpeechTelemetry, VoiceCaptureMode, VoiceChatOptions, VoiceChatState, VoicePlaybackStartEvent, VoiceSessionMode, VoiceSpeakerMetadata, VoiceTranscriptEvent, VoiceTranscriptPreviewEvent, VoiceTurn, } from "../voice/voice-chat-types";
declare function resumeAudioContextForPlayback(ctx: AudioContext, timeoutMs?: number): Promise<boolean>;
declare function shouldPreferNativeTalkMode(): boolean;
declare function shouldUseNativeAndroidLocalInferenceTts(): boolean;
declare function isWindowsElectrobunRenderer(): boolean;
declare function shouldAutoRestartBrowserRecognition(): boolean;
declare function shouldUseLocalInferenceAsr(config: VoiceConfig | null): boolean;
export declare const __voiceChatInternals: {
    isWindowsElectrobunRenderer: typeof isWindowsElectrobunRenderer;
    shouldPreferNativeTalkMode: typeof shouldPreferNativeTalkMode;
    shouldUseNativeAndroidLocalInferenceTts: typeof shouldUseNativeAndroidLocalInferenceTts;
    shouldAutoRestartBrowserRecognition: typeof shouldAutoRestartBrowserRecognition;
    shouldUseLocalInferenceAsr: typeof shouldUseLocalInferenceAsr;
    resumeAudioContextForPlayback: typeof resumeAudioContextForPlayback;
    splitFirstSentence: typeof splitFirstSentence;
    remainderAfter: typeof remainderAfter;
    queueableSpeechPrefix: typeof queueableSpeechPrefix;
    resolveEffectiveVoiceConfig: typeof resolveEffectiveVoiceConfig;
    resolveVoiceMode: typeof resolveVoiceMode;
    resolveVoiceProxyEndpoint: typeof resolveVoiceProxyEndpoint;
    toSpeakableText: typeof toSpeakableText;
    mergeTranscriptWindows: typeof mergeTranscriptWindows;
    webSpeechVoiceDebugFields: typeof webSpeechVoiceDebugFields;
    ASSISTANT_TTS_FINAL_ONLY: boolean;
    ASSISTANT_TTS_FIRST_FLUSH_CHARS: number;
    ASSISTANT_TTS_MIN_CHUNK_CHARS: number;
};
export declare function useVoiceChat(options: VoiceChatOptions): VoiceChatState;
//# sourceMappingURL=useVoiceChat.d.ts.map