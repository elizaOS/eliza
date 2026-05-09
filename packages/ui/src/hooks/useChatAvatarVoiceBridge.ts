import { useEffect, useRef } from "react";
import {
  CHAT_AVATAR_VOICE_EVENT,
  type ChatAvatarVoiceEventDetail,
} from "../events";

export interface UseChatAvatarVoiceBridgeOptions {
  mouthOpen: number;
  isSpeaking: boolean;
  usingAudioAnalysis: boolean;
  onSpeakingChange: (isSpeaking: boolean) => void;
}

/**
 * Pushes voice analysis from {@link useVoiceChat} to the companion avatar via
 * {@link CHAT_AVATAR_VOICE_EVENT} and syncs speaking state into chat shell state.
 */
export function useChatAvatarVoiceBridge({
  mouthOpen,
  isSpeaking,
  onSpeakingChange,
}: UseChatAvatarVoiceBridgeOptions): void {
  const prevSpeakingRef = useRef(isSpeaking);

  useEffect(() => {
    if (prevSpeakingRef.current !== isSpeaking) {
      prevSpeakingRef.current = isSpeaking;
      onSpeakingChange(isSpeaking);
    }
  }, [isSpeaking, onSpeakingChange]);

  useEffect(() => {
    const detail: ChatAvatarVoiceEventDetail = { mouthOpen, isSpeaking };
    window.dispatchEvent(
      new CustomEvent<ChatAvatarVoiceEventDetail>(CHAT_AVATAR_VOICE_EVENT, {
        detail,
      }),
    );
  }, [mouthOpen, isSpeaking]);
}
