/**
 * Speaks the current tour frame aloud through the app's REAL voice pipeline
 * (the same {@link useVoiceChat} engine that voices assistant replies — cloud /
 * local TTS, with the browser voice as its fallback), not a separate browser
 * hack. Mounted only while the tour is active, so the engine isn't spun up when
 * idle. Renders nothing; `utteranceId` changing (re)speaks `text`.
 */
import * as React from "react";
import { useVoiceChat } from "../../../hooks/useVoiceChat";
import { useAppSelector } from "../../../state";
import { useVoiceConfig } from "../../../voice/useVoiceConfig";

export function TutorialNarrator({
  utteranceId,
  text,
  muted,
}: {
  utteranceId: string;
  text: string;
  muted: boolean;
}): null {
  const uiLanguage = useAppSelector((s) => s.uiLanguage);
  const elizaCloudVoiceProxyAvailable = useAppSelector(
    (s) => s.elizaCloudVoiceProxyAvailable,
  );
  const { voiceConfig, voiceBootstrapTick } = useVoiceConfig(uiLanguage);
  const { queueAssistantSpeech, stopSpeaking, unlockAudio } = useVoiceChat({
    voiceConfig,
    cloudConnected: elizaCloudVoiceProxyAvailable,
    // Output-only: the chat overlay's own capture owns the mic.
    interruptOnSpeech: false,
    onTranscript: () => {},
  });

  React.useEffect(() => {
    if (muted || !text) {
      stopSpeaking();
      return;
    }
    if (voiceBootstrapTick === 0) return; // voice config not loaded yet
    unlockAudio?.();
    queueAssistantSpeech(utteranceId, text, true, { replace: true });
    return () => stopSpeaking();
  }, [
    utteranceId,
    text,
    muted,
    voiceBootstrapTick,
    queueAssistantSpeech,
    stopSpeaking,
    unlockAudio,
  ]);

  return null;
}
