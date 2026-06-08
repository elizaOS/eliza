import * as React from "react";

import type { ConversationMessage } from "../../api/client-types-chat";
import { useVoiceChat } from "../../hooks/useVoiceChat";
import { sanitizeAssistantDisplayText } from "../../utils/chat-display-text";
import { useVoiceConfig } from "../../voice/useVoiceConfig";

/** `useVoiceChat` requires a transcript sink; the overlay owns input elsewhere. */
const NOOP_TRANSCRIPT = (): void => {};

function findLatestAssistantText(
  messages: readonly ConversationMessage[],
): { id: string; text: string } | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && message.role === "assistant" && message.text.trim()) {
      const text = sanitizeAssistantDisplayText(message.text);
      if (text) return { id: message.id, text };
    }
  }
  return null;
}

export interface ShellVoiceOutput {
  /** True while an assistant reply is being spoken aloud. */
  speaking: boolean;
  /** True while assistant voice output is muted by the user. */
  agentVoiceMuted: boolean;
  /** Mute/unmute assistant voice output. Muting stops any in-flight speech. */
  toggleAgentVoiceMute: () => void;
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

  const { queueAssistantSpeech, stopSpeaking, isSpeaking } = useVoiceChat({
    voiceConfig,
    cloudConnected,
    // Output-only here: the overlay's capture owns the mic, so `useVoiceChat`'s
    // own speech-interrupt path is unused — barge-in is driven by `recording`.
    interruptOnSpeech: false,
    onTranscript: NOOP_TRANSCRIPT,
  });

  const spokenRef = React.useRef<{ id: string; text: string } | null>(null);

  // Speak the latest assistant message as it streams and completes. Gated so we
  // only speak replies the user asked for by voice — never a reply to a typed
  // message, and never a pre-existing message on first mount.
  React.useEffect(() => {
    if (agentVoiceMuted || !lastTurnVoice) return;
    if (voiceBootstrapTick === 0) return; // voice config not loaded yet
    const latest = findLatestAssistantText(conversationMessages);
    if (!latest) return;
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
    lastTurnVoice,
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

  return { speaking: isSpeaking, agentVoiceMuted, toggleAgentVoiceMute };
}
