import { useEffect, useEffectEvent, useRef, useState } from "react";
import {
  CHAT_AVATAR_VOICE_EVENT,
  type ChatAvatarVoiceEventDetail,
  dispatchWindowEvent,
} from "../events";

const CHAT_AVATAR_MOUTH_STEP = 0.02;
const CHAT_AVATAR_SILENCE: ChatAvatarVoiceEventDetail = {
  mouthOpen: 0,
  isSpeaking: false,
};

function normalizeMouthOpen(value: number | undefined): number {
  const clamped = Math.max(0, Math.min(1, value ?? 0));
  const stepped =
    Math.round(clamped / CHAT_AVATAR_MOUTH_STEP) * CHAT_AVATAR_MOUTH_STEP;
  return stepped < CHAT_AVATAR_MOUTH_STEP ? 0 : Math.min(1, stepped);
}

function normalizeChatAvatarVoice(
  value: Partial<ChatAvatarVoiceEventDetail> | null | undefined,
): ChatAvatarVoiceEventDetail {
  return {
    mouthOpen: normalizeMouthOpen(value?.mouthOpen),
    isSpeaking: value?.isSpeaking === true,
  };
}

function isSameChatAvatarVoice(
  left: ChatAvatarVoiceEventDetail,
  right: ChatAvatarVoiceEventDetail,
): boolean {
  return (
    left.isSpeaking === right.isSpeaking && left.mouthOpen === right.mouthOpen
  );
}

export interface ChatAvatarVoiceBridgeOptions {
  mouthOpen: number;
  isSpeaking: boolean;
  usingAudioAnalysis?: boolean;
  onSpeakingChange?: (isSpeaking: boolean) => void;
}

export function useChatAvatarVoiceBridge({
  mouthOpen,
  isSpeaking,
  usingAudioAnalysis = false,
  onSpeakingChange,
}: ChatAvatarVoiceBridgeOptions): void {
  const voice = normalizeChatAvatarVoice({
    mouthOpen,
    isSpeaking: isSpeaking && !usingAudioAnalysis,
  });
  const lastVoiceRef = useRef<ChatAvatarVoiceEventDetail>(CHAT_AVATAR_SILENCE);
  const emitSpeakingChange = useEffectEvent((nextIsSpeaking: boolean) => {
    onSpeakingChange?.(nextIsSpeaking);
  });

  useEffect(() => {
    if (lastVoiceRef.current.isSpeaking !== voice.isSpeaking) {
      emitSpeakingChange(voice.isSpeaking);
    }
    if (isSameChatAvatarVoice(lastVoiceRef.current, voice)) {
      return;
    }
    lastVoiceRef.current = voice;
    dispatchWindowEvent(CHAT_AVATAR_VOICE_EVENT, voice);
  }, [voice]);

  useEffect(() => {
    return () => {
      if (lastVoiceRef.current.isSpeaking) {
        emitSpeakingChange(false);
      }
      if (isSameChatAvatarVoice(lastVoiceRef.current, CHAT_AVATAR_SILENCE)) {
        return;
      }
      lastVoiceRef.current = CHAT_AVATAR_SILENCE;
      dispatchWindowEvent(CHAT_AVATAR_VOICE_EVENT, CHAT_AVATAR_SILENCE);
    };
  }, []);
}

export function useChatAvatarVoiceState(): ChatAvatarVoiceEventDetail {
  const [voice, setVoice] =
    useState<ChatAvatarVoiceEventDetail>(CHAT_AVATAR_SILENCE);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const handleVoiceEvent = (event: Event) => {
      const detail = (event as CustomEvent<ChatAvatarVoiceEventDetail>).detail;
      const nextVoice = normalizeChatAvatarVoice(detail);
      setVoice((previousVoice) =>
        isSameChatAvatarVoice(previousVoice, nextVoice)
          ? previousVoice
          : nextVoice,
      );
    };

    window.addEventListener(CHAT_AVATAR_VOICE_EVENT, handleVoiceEvent);
    return () =>
      window.removeEventListener(CHAT_AVATAR_VOICE_EVENT, handleVoiceEvent);
  }, []);

  return voice;
}
