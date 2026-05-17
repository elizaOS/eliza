import type {
  ConversationChannelType,
  ConversationMessage,
} from "../../api/client-types-chat";
import { type ContinuousChatState } from "../../hooks/useContinuousChat";
import type { useApp } from "../../state/useApp";
import {
  type VoiceCaptureMode,
  type VoiceContinuousMode,
  type VoiceSpeakerMetadata,
} from "../../voice/voice-chat-types";
export declare function mapUiLanguageToSpeechLocale(uiLanguage: string): string;
type VoiceLatencyState = {
  assistantFirstMessageId: string | null;
  firstSegmentCached: boolean | null;
  speechEndToFirstTokenMs: number | null;
  speechEndToVoiceStartMs: number | null;
  assistantStreamToVoiceStartMs: number | null;
};
export declare function __resetCompanionSpeechMemoryForTests(): void;
/**
 * Chat assistant TTS pipeline — order matters for cloud-backed voice:
 * 1. Server exposes Eliza Cloud via `GET /api/cloud/status` (`hasApiKey`, `enabled`, `connected`).
 * 2. `AppContext.pollCloudCredits` persists React state and dispatches {@link ELIZA_CLOUD_STATUS_UPDATED_EVENT}.
 * 3. This hook stores `detail.cloudVoiceProxyAvailable` in a ref for same-turn
 *    `true` before React state commits; `cloudConnected` is `context || ref===true`
 *    so an early `false` snapshot cannot block TTS after auth loads. Then reloads
 *    `messages.tts` from `getConfig`.
 * 4. `useVoiceChat` resolves cloud vs own-key mode and speaks via `/api/tts/cloud`
 *    only when cloud inference is actually selected, not merely linked.
 */
export declare function useChatVoiceController(options: {
  agentVoiceMuted: boolean;
  chatFirstTokenReceived: boolean;
  chatInput: string;
  chatSending: boolean;
  elizaCloudConnected: boolean;
  elizaCloudVoiceProxyAvailable: boolean;
  elizaCloudHasPersistedKey: boolean;
  conversationMessages: ConversationMessage[];
  activeConversationId: string | null;
  handleChatEdit: (messageId: string, text: string) => Promise<boolean>;
  handleChatSend: (
    channelType?: ConversationChannelType,
    options?: {
      metadata?: Record<string, unknown>;
    },
  ) => Promise<void>;
  isComposerLocked: boolean;
  isGameModal: boolean;
  setState: ReturnType<typeof useApp>["setState"];
  uiLanguage: string;
  /** Caller owns continuous-chat mode (persistence + UI toggle). Defaults to off. */
  continuousMode?: VoiceContinuousMode;
}): {
  beginVoiceCapture: (mode?: Exclude<VoiceCaptureMode, "idle">) => void;
  endVoiceCapture: (captureOptions?: { submit?: boolean }) => void;
  continuous: ContinuousChatState;
  handleEditMessage: (messageId: string, text: string) => Promise<boolean>;
  handleSpeakMessage: (messageId: string, text: string) => void;
  stopSpeaking: () => void;
  voice: import("../..").VoiceChatState;
  voiceLatency: VoiceLatencyState | null;
  voiceSpeaker: VoiceSpeakerMetadata | null;
};
export type UseChatVoiceControllerReturn = ReturnType<
  typeof useChatVoiceController
>;
export type { ContinuousChatState };
export interface CompanionCarryoverState {
  expiresAtMs: number;
  fadeStartsAtMs: number;
  messages: ConversationMessage[];
}
export declare function useGameModalMessages(options: {
  activeConversationId: string | null;
  companionMessageCutoffTs: number;
  isGameModal: boolean;
  visibleMsgs: ConversationMessage[];
}): {
  companionCarryover: CompanionCarryoverState | null;
  gameModalCarryoverOpacity: number;
  gameModalVisibleMsgs: ConversationMessage[];
};
//# sourceMappingURL=chat-view-hooks.d.ts.map
