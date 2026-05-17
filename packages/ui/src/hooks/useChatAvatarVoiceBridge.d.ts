export interface UseChatAvatarVoiceBridgeOptions {
  mouthOpen: number;
  isSpeaking: boolean;
  onSpeakingChange: (isSpeaking: boolean) => void;
}
/**
 * Pushes voice analysis from {@link useVoiceChat} to the companion avatar via
 * {@link CHAT_AVATAR_VOICE_EVENT} and syncs speaking state into chat shell state.
 */
export declare function useChatAvatarVoiceBridge({
  mouthOpen,
  isSpeaking,
  onSpeakingChange,
}: UseChatAvatarVoiceBridgeOptions): void;
//# sourceMappingURL=useChatAvatarVoiceBridge.d.ts.map
