/**
 * Chat state — consolidated via useReducer.
 *
 * Replaces 18+ individual useState hooks and 10 sync-to-ref/persistence
 * effects with a single reducer + inline persistence in setters.
 */
import type { CodingAgentSession, Conversation, ConversationMessage, ImageAttachment, StreamEventEnvelope } from "../api";
import type { AutonomyEventStore, AutonomyRunHealthMap } from "./autonomy";
import type { ChatTurnUsage } from "./types";
export interface ChatState {
    chatInput: string;
    chatSending: boolean;
    chatFirstTokenReceived: boolean;
    chatLastUsage: ChatTurnUsage | null;
    chatAvatarVisible: boolean;
    chatAgentVoiceMuted: boolean;
    chatAvatarSpeaking: boolean;
    conversations: Conversation[];
    activeConversationId: string | null;
    companionMessageCutoffTs: number;
    conversationMessages: ConversationMessage[];
    autonomousEvents: StreamEventEnvelope[];
    autonomousLatestEventId: string | null;
    autonomousRunHealthByRunId: import("./autonomy").AutonomyRunHealthMap;
    ptySessions: CodingAgentSession[];
    unreadConversations: Set<string>;
    chatPendingImages: ImageAttachment[];
}
type ChatAction = {
    type: "SET_FIELD";
    field: keyof ChatState;
    value: unknown;
} | {
    type: "SET_CHAT_INPUT";
    value: string;
} | {
    type: "SET_CHAT_SENDING";
    value: boolean;
} | {
    type: "SET_FIRST_TOKEN_RECEIVED";
    value: boolean;
} | {
    type: "SET_LAST_USAGE";
    value: ChatTurnUsage | null;
} | {
    type: "SET_AVATAR_VISIBLE";
    value: boolean;
} | {
    type: "SET_VOICE_MUTED";
    value: boolean;
} | {
    type: "SET_AVATAR_SPEAKING";
    value: boolean;
} | {
    type: "SET_CONVERSATIONS";
    value: Conversation[];
} | {
    type: "SET_ACTIVE_CONVERSATION_ID";
    value: string | null;
} | {
    type: "SET_COMPANION_CUTOFF";
    value: number;
} | {
    type: "SET_MESSAGES";
    value: ConversationMessage[];
} | {
    type: "APPEND_MESSAGE";
    message: ConversationMessage;
} | {
    type: "UPDATE_MESSAGE";
    id: string;
    update: Partial<ConversationMessage>;
} | {
    type: "SET_AUTONOMOUS_EVENTS";
    value: StreamEventEnvelope[];
} | {
    type: "SET_AUTONOMOUS_LATEST_EVENT_ID";
    value: string | null;
} | {
    type: "SET_AUTONOMOUS_RUN_HEALTH";
    value: AutonomyRunHealthMap;
} | {
    type: "SET_PTY_SESSIONS";
    value: CodingAgentSession[];
} | {
    type: "ADD_UNREAD";
    conversationId: string;
} | {
    type: "REMOVE_UNREAD";
    conversationId: string;
} | {
    type: "SET_PENDING_IMAGES";
    value: ImageAttachment[];
} | {
    type: "RESET_DRAFT";
};
export interface ChatStateHook {
    state: ChatState;
    dispatch: React.Dispatch<ChatAction>;
    setChatInput: (v: string | ((prev: string) => string)) => void;
    setChatSending: (v: boolean) => void;
    setChatFirstTokenReceived: (v: boolean) => void;
    setChatLastUsage: (v: ChatTurnUsage | null) => void;
    setChatAvatarVisible: (v: boolean) => void;
    setChatAgentVoiceMuted: (v: boolean) => void;
    setChatAvatarSpeaking: (v: boolean) => void;
    setConversations: React.Dispatch<React.SetStateAction<Conversation[]>>;
    setActiveConversationId: (v: string | null) => void;
    setCompanionMessageCutoffTs: (v: number) => void;
    setConversationMessages: React.Dispatch<React.SetStateAction<ConversationMessage[]>>;
    setAutonomousEvents: (v: StreamEventEnvelope[]) => void;
    setAutonomousLatestEventId: (v: string | null) => void;
    setAutonomousRunHealthByRunId: (v: AutonomyRunHealthMap) => void;
    setPtySessions: React.Dispatch<React.SetStateAction<CodingAgentSession[]>>;
    addUnread: (conversationId: string) => void;
    removeUnread: (conversationId: string) => void;
    setChatPendingImages: React.Dispatch<React.SetStateAction<ImageAttachment[]>>;
    resetDraftState: () => void;
    activeConversationIdRef: React.RefObject<string | null>;
    chatInputRef: React.RefObject<string>;
    chatPendingImagesRef: React.RefObject<ImageAttachment[]>;
    conversationMessagesRef: React.RefObject<ConversationMessage[]>;
    conversationsRef: React.RefObject<Conversation[]>;
    conversationHydrationEpochRef: React.MutableRefObject<number>;
    chatAbortRef: React.RefObject<AbortController | null>;
    chatSendBusyRef: React.RefObject<boolean>;
    chatSendNonceRef: React.MutableRefObject<number>;
    greetingFiredRef: React.RefObject<boolean>;
    greetingInFlightConversationRef: React.RefObject<string | null>;
    companionStaleConversationRefreshRef: React.RefObject<string | null>;
    autonomousStoreRef: React.MutableRefObject<AutonomyEventStore>;
    autonomousEventsRef: React.MutableRefObject<StreamEventEnvelope[]>;
    autonomousLatestEventIdRef: React.MutableRefObject<string | null>;
    autonomousRunHealthByRunIdRef: React.MutableRefObject<AutonomyRunHealthMap>;
    autonomousReplayInFlightRef: React.RefObject<boolean>;
}
export declare function useChatState(): ChatStateHook;
export type { ChatAction as ChatDispatchAction };
//# sourceMappingURL=useChatState.d.ts.map