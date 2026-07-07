/**
 * Coordinates shell-level voice output state so chat, overlays, and voice
 * controls share one playback signal.
 */
import * as React from "react";

import type { AsrProvider } from "../../api/client-types-config";
import type { ConversationMessage } from "../../api/client-types-chat";
import { useVoiceChat } from "../../hooks/useVoiceChat";
import { useVoiceConfig } from "../../voice/useVoiceConfig";

/** `useVoiceChat` requires a transcript sink; the overlay owns input elsewhere. */
const NOOP_TRANSCRIPT = (): void => {};

function findLatestAssistantText(
  messages: readonly ConversationMessage[],
): { id: string; text: string; source?: string } | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && message.role === "assistant" && message.text.trim()) {
      return { id: message.id, text: message.text, source: message.source };
    }
  }
  return null;
}

export interface ShellVoiceOutput {
  /** True while an assistant reply is being spoken aloud. */
  speaking: boolean;
  /**
   * Speak an arbitrary message aloud on demand — backs the per-message
   * "Play audio" control (#10713). Distinct from the automatic voice-reply
   * playback: this is user-initiated, so it ignores the voice-turn gate.
   */
  speak: (text: string) => void;
  /** Immediately stop any in-flight assistant speech (e.g. on hands-free exit). */
  stopSpeaking: () => void;
  /** True while assistant voice output is muted by the user. */
  agentVoiceMuted: boolean;
  /** Mute/unmute assistant voice output. Muting stops any in-flight speech. */
  toggleAgentVoiceMute: () => void;
  /** True when autoplay policy blocked playback and a user gesture is needed. */
  needsAudioUnlock: boolean;
  /** Resume the audio context in response to a user gesture (enable sound). */
  unlockAudio: () => void;
  /**
   * The resolved speech-to-text provider from the loaded voice config, or
   * `undefined` while the config has not loaded yet. Surfaced so the overlay's
   * mic capture ({@link useShellController} → {@link createVoiceCapture}) can
   * route to the SAME backend the config selects — without it the factory only
   * ever saw `undefined` and could never reach the `eliza-cloud` / `openai`
   * cloud STT path, silently degrading to local-inference-or-browser instead.
   */
  asrProvider: AsrProvider | undefined;
}

export interface ShellVoiceOutputOptions {
  conversationMessages: readonly ConversationMessage[];
  chatSending: boolean;
  /** True while the mic is capturing — barges in on (stops) assistant speech. */
  recording: boolean;
  /** True when the latest user turn was voice-originated (`VOICE_DM`). */
  lastTurnVoice: boolean;
  uiLanguage: string;
  cloudConnected: boolean;
}

/**
 * Voice OUTPUT for the ambient `/chat` overlay — speaks assistant replies aloud
 * so the overlay is bidirectional. Input (mic → ASR) stays in
 * {@link useShellController} via the capture factory; this hook only drives TTS.
 *
 * It reuses the single TTS engine ({@link useVoiceChat}) output-only: it never
 * calls `startListening`, so it never opens the microphone (the overlay's own
 * capture owns that). Replies are spoken only after a voice turn — so a
 * typed-only chat stays silent and a stale greeting is not read on mount — and
 * only while not muted. A new mic capture barges in and stops playback.
 */
export function useShellVoiceOutput(
  options: ShellVoiceOutputOptions,
): ShellVoiceOutput {
  const {
    conversationMessages,
    chatSending,
    recording,
    lastTurnVoice,
    uiLanguage,
    cloudConnected,
  } = options;

  const { voiceConfig, voiceBootstrapTick } = useVoiceConfig(uiLanguage);
  const [agentVoiceMuted, setAgentVoiceMuted] = React.useState(false);

  const {
    queueAssistantSpeech,
    speak,
    stopSpeaking,
    isSpeaking,
    needsAudioUnlock,
    unlockAudio,
  } = useVoiceChat({
    voiceConfig,
    cloudConnected,
    // Output-only here: the overlay's capture owns the mic, so `useVoiceChat`'s
    // own speech-interrupt path is unused — barge-in is driven by `recording`.
    interruptOnSpeech: false,
    onTranscript: NOOP_TRANSCRIPT,
  });

  const spokenRef = React.useRef<{ id: string; text: string } | null>(null);
  // Voice-ness is decided PER assistant message at the moment it first appears,
  // not re-checked on every render. `lastTurnVoice` is a single boolean that any
  // later send (a typed turn, a hands-free re-arm) flips — reading it at speak
  // time would silence an in-flight voice reply the instant the user typed.
  // Instead, when a brand-new assistant message arrives we capture its id IFF
  // the user's most recent turn was voice; from then on that reply is spoken
  // regardless of subsequent turns. Replies to typed turns are never captured.
  const voiceReplyIdsRef = React.useRef<Set<string>>(new Set());
  const lastTurnVoiceRef = React.useRef(lastTurnVoice);
  lastTurnVoiceRef.current = lastTurnVoice;

  // Speak the latest assistant message as it streams and completes. Never speaks
  // a reply to a typed message, nor a pre-existing message on first mount.
  React.useEffect(() => {
    if (agentVoiceMuted) return;
    if (voiceBootstrapTick === 0) return; // voice config not loaded yet
    const latest = findLatestAssistantText(conversationMessages);
    if (!latest) return;

    // Proactive interaction comments (#8792) are text-only by default: they must
    // never be read aloud unless the user is actively hands-free (the latest turn
    // was voice). The general voice-turn gate below also enforces this for new
    // messages, but make it explicit so a proactive comment is never spoken just
    // because an earlier turn happened to be voice.
    if (
      latest.source === "proactive-interaction" &&
      !lastTurnVoiceRef.current
    ) {
      return;
    }

    if (!voiceReplyIdsRef.current.has(latest.id)) {
      // First sighting of this assistant message: it's a voice reply only if the
      // turn that prompted it was voice. A typed-turn reply stays silent forever.
      if (!lastTurnVoiceRef.current) return;
      voiceReplyIdsRef.current.add(latest.id);
    }

    const previous = spokenRef.current;
    if (
      previous &&
      previous.id === latest.id &&
      previous.text === latest.text
    ) {
      return;
    }
    // A new assistant message replaces prior playback; a streaming continuation
    // of the same message appends. `queueAssistantSpeech` dedupes the prefix.
    const replace = previous?.id !== latest.id;
    spokenRef.current = latest;
    queueAssistantSpeech(latest.id, latest.text, !chatSending, { replace });
  }, [
    agentVoiceMuted,
    voiceBootstrapTick,
    conversationMessages,
    chatSending,
    queueAssistantSpeech,
  ]);

  // Barge-in: the instant the mic opens, stop talking so the user is heard.
  React.useEffect(() => {
    if (recording) stopSpeaking();
  }, [recording, stopSpeaking]);

  // Muting silences any in-flight reply immediately.
  React.useEffect(() => {
    if (agentVoiceMuted) stopSpeaking();
  }, [agentVoiceMuted, stopSpeaking]);

  const toggleAgentVoiceMute = React.useCallback(() => {
    setAgentVoiceMuted((muted) => !muted);
  }, []);

  return {
    speaking: isSpeaking,
    speak,
    stopSpeaking,
    agentVoiceMuted,
    toggleAgentVoiceMute,
    // useVoiceChat always returns these; VoiceChatState types them optional, so
    // coalesce to keep this hook's (and ShellController's) non-optional contract.
    needsAudioUnlock: needsAudioUnlock ?? false,
    unlockAudio: unlockAudio ?? (() => {}),
    asrProvider: voiceConfig.asr?.provider,
  };
}
