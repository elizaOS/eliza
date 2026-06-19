export type ChatVariant = "default" | "game-modal";

export interface ChatLabelSet {
  actions?: string;
  agentStarting?: string;
  agentVoiceOff?: string;
  agentVoiceOn?: string;
  attachImage?: string;
  cancel?: string;
  clearSearch?: string;
  chatIconLabel?: string;
  chats?: string;
  closePanel?: string;
  copied?: string;
  copiedAria?: string;
  copy?: string;
  delete?: string;
  deleteConfirm?: string;
  deleteNo?: string;
  deleteYes?: string;
  edit?: string;
  expandChatsPanel?: string;
  inputPlaceholder?: string;
  inputPlaceholderNarrow?: string;
  listening?: string;
  micTitleIdleEnhanced?: string;
  micTitleIdleStandard?: string;
  newChat?: string;
  none?: string;
  noMatchingChats?: string;
  play?: string;
  releaseToSend?: string;
  rename?: string;
  responseInterrupted?: string;
  saveAndResend?: string;
  searchChats?: string;
  saving?: string;
  send?: string;
  sendMessageTo?: string;
  startConversation?: string;
  stopGeneration?: string;
  stopListening?: string;
  stopSpeaking?: string;
  toBeginChatting?: string;
  voiceInput?: string;
}

export interface ChatAttachmentItem {
  alt: string;
  id: string;
  name: string;
  src: string;
}

export interface ChatMessageReaction {
  emoji: string;
  count: number;
  users?: string[];
}

/**
 * Voice speaker attribution metadata attached to a chat message. Populated
 * when the user message was captured via voice and R2's speaker-id pipeline
 * tagged the turn with an identified speaker.
 */
export interface ChatVoiceSpeaker {
  /** Stable entity id for the speaker. */
  entityId?: string;
  /** Human-friendly display name shown in the bubble header. */
  name?: string;
  /** Connector username/handle (fallback when `name` is missing). */
  userName?: string;
  /** True when this speaker has the OWNER role on the device. */
  isOwner?: boolean;
}

export interface ChatMessageData {
  avatarUrl?: string;
  from?: string;
  fromUserName?: string;
  id: string;
  interrupted?: boolean;
  reactions?: ChatMessageReaction[];
  replyToMessageId?: string;
  replyToSenderName?: string;
  replyToSenderUserName?: string;
  role: string;
  source?: string;
  text: string;
  /** Voice speaker attribution when this message arrived via voice (R10 §4.1). */
  voiceSpeaker?: ChatVoiceSpeaker;
}

export interface ChatMessageLabels extends ChatLabelSet {}

export interface ChatConversationSummary {
  avatarUrl?: string;
  id: string;
  title: string;
  updatedAtLabel?: string;
  /**
   * Optional connector source tag (e.g. "imessage", "telegram",
   * "discord", "whatsapp"). When set, the conversation item renders
   * a brand-colored channel pill next to the title so cross-channel
   * threads in a combined sidebar are visually distinct from the
   * agent's own dashboard conversations. Unknown sources fall back
   * to a neutral accent pill; dashboard conversations leave this
   * unset and get no pill at all.
   */
  source?: string;
}

export interface ChatConversationLabels extends ChatLabelSet {}
