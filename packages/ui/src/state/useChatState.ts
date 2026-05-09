/**
 * Chat state — consolidated via useReducer.
 *
 * Replaces 18+ individual useState hooks and 10 sync-to-ref/persistence
 * effects with a single reducer + inline persistence in setters.
 */

import { useCallback, useReducer, useRef } from "react";
import type {
  CodingAgentSession,
  Conversation,
  ConversationMessage,
  ConversationMode,
  ImageAttachment,
  StreamEventEnvelope,
} from "../api";
import type { AutonomyEventStore, AutonomyRunHealthMap } from "./autonomy";
import {
  loadChatAvatarVisible,
  loadChatMode,
  loadChatVoiceMuted,
  loadCompanionMessageCutoffTs,
  saveActiveConversationId,
  saveChatAvatarVisible,
  saveChatMode,
  saveChatVoiceMuted,
  saveCompanionMessageCutoffTs,
} from "./persistence";
import type { ChatTurnUsage } from "./types";

// ── State shape ────────────────────────────────────────────────────────

export interface ChatState {
  chatInput: string;
  chatSending: boolean;
  chatFirstTokenReceived: boolean;
  chatLastUsage: ChatTurnUsage | null;
  chatAvatarVisible: boolean;
  chatAgentVoiceMuted: boolean;
  chatMode: ConversationMode;
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

function createInitialChatState(): ChatState {
  return {
    chatInput: "",
    chatSending: false,
    chatFirstTokenReceived: false,
    chatLastUsage: null,
    chatAvatarVisible: loadChatAvatarVisible(),
    chatAgentVoiceMuted: loadChatVoiceMuted(),
    chatMode: loadChatMode(),
    chatAvatarSpeaking: false,
    conversations: [],
    activeConversationId: null,
    companionMessageCutoffTs: loadCompanionMessageCutoffTs(),
    conversationMessages: [],
    autonomousEvents: [],
    autonomousLatestEventId: null,
    autonomousRunHealthByRunId: {},
    ptySessions: [],
    unreadConversations: new Set(),
    chatPendingImages: [],
  };
}

// ── Actions ────────────────────────────────────────────────────────────

type ChatAction =
  | { type: "SET_FIELD"; field: keyof ChatState; value: unknown }
  | { type: "SET_CHAT_INPUT"; value: string }
  | { type: "SET_CHAT_SENDING"; value: boolean }
  | { type: "SET_FIRST_TOKEN_RECEIVED"; value: boolean }
  | { type: "SET_LAST_USAGE"; value: ChatTurnUsage | null }
  | { type: "SET_AVATAR_VISIBLE"; value: boolean }
  | { type: "SET_VOICE_MUTED"; value: boolean }
  | { type: "SET_CHAT_MODE"; value: ConversationMode }
  | { type: "SET_AVATAR_SPEAKING"; value: boolean }
  | { type: "SET_CONVERSATIONS"; value: Conversation[] }
  | { type: "SET_ACTIVE_CONVERSATION_ID"; value: string | null }
  | { type: "SET_COMPANION_CUTOFF"; value: number }
  | { type: "SET_MESSAGES"; value: ConversationMessage[] }
  | { type: "APPEND_MESSAGE"; message: ConversationMessage }
  | { type: "UPDATE_MESSAGE"; id: string; update: Partial<ConversationMessage> }
  | { type: "SET_AUTONOMOUS_EVENTS"; value: StreamEventEnvelope[] }
  | { type: "SET_AUTONOMOUS_LATEST_EVENT_ID"; value: string | null }
  | { type: "SET_AUTONOMOUS_RUN_HEALTH"; value: AutonomyRunHealthMap }
  | { type: "SET_PTY_SESSIONS"; value: CodingAgentSession[] }
  | { type: "ADD_UNREAD"; conversationId: string }
  | { type: "REMOVE_UNREAD"; conversationId: string }
  | { type: "SET_PENDING_IMAGES"; value: ImageAttachment[] }
  | { type: "RESET_DRAFT" };

function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "SET_FIELD":
      return { ...state, [action.field]: action.value };
    case "SET_CHAT_INPUT":
      return { ...state, chatInput: action.value };
    case "SET_CHAT_SENDING":
      return { ...state, chatSending: action.value };
    case "SET_FIRST_TOKEN_RECEIVED":
      return { ...state, chatFirstTokenReceived: action.value };
    case "SET_LAST_USAGE":
      return { ...state, chatLastUsage: action.value };
    case "SET_AVATAR_VISIBLE":
      return { ...state, chatAvatarVisible: action.value };
    case "SET_VOICE_MUTED":
      return { ...state, chatAgentVoiceMuted: action.value };
    case "SET_CHAT_MODE":
      return { ...state, chatMode: action.value };
    case "SET_AVATAR_SPEAKING":
      return { ...state, chatAvatarSpeaking: action.value };
    case "SET_CONVERSATIONS":
      return { ...state, conversations: action.value };
    case "SET_ACTIVE_CONVERSATION_ID":
      return { ...state, activeConversationId: action.value };
    case "SET_COMPANION_CUTOFF":
      return { ...state, companionMessageCutoffTs: action.value };
    case "SET_MESSAGES":
      return { ...state, conversationMessages: action.value };
    case "APPEND_MESSAGE":
      return {
        ...state,
        conversationMessages: [...state.conversationMessages, action.message],
      };
    case "UPDATE_MESSAGE":
      return {
        ...state,
        conversationMessages: state.conversationMessages.map((m) =>
          m.id === action.id ? { ...m, ...action.update } : m,
        ),
      };
    case "SET_AUTONOMOUS_EVENTS":
      return { ...state, autonomousEvents: action.value };
    case "SET_AUTONOMOUS_LATEST_EVENT_ID":
      return { ...state, autonomousLatestEventId: action.value };
    case "SET_AUTONOMOUS_RUN_HEALTH":
      return { ...state, autonomousRunHealthByRunId: action.value };
    case "SET_PTY_SESSIONS":
      return { ...state, ptySessions: action.value };
    case "ADD_UNREAD": {
      const next = new Set(state.unreadConversations);
      next.add(action.conversationId);
      return { ...state, unreadConversations: next };
    }
    case "REMOVE_UNREAD": {
      if (!state.unreadConversations.has(action.conversationId)) return state;
      const next = new Set(state.unreadConversations);
      next.delete(action.conversationId);
      return { ...state, unreadConversations: next };
    }
    case "SET_PENDING_IMAGES":
      return { ...state, chatPendingImages: action.value };
    case "RESET_DRAFT":
      return {
        ...state,
        chatInput: "",
        chatPendingImages: [],
        chatSending: false,
        chatFirstTokenReceived: false,
        conversationMessages: [],
        activeConversationId: null,
        companionMessageCutoffTs: Date.now(),
      };
    default:
      return state;
  }
}

// ── Hook ───────────────────────────────────────────────────────────────

export interface ChatStateHook {
  state: ChatState;
  dispatch: React.Dispatch<ChatAction>;

  // Persistence-aware setters (inline save, no useEffect needed)
  setChatInput: (v: string | ((prev: string) => string)) => void;
  setChatSending: (v: boolean) => void;
  setChatFirstTokenReceived: (v: boolean) => void;
  setChatLastUsage: (v: ChatTurnUsage | null) => void;
  setChatAvatarVisible: (v: boolean) => void;
  setChatAgentVoiceMuted: (v: boolean) => void;
  setChatMode: (v: ConversationMode) => void;
  setChatAvatarSpeaking: (v: boolean) => void;
  setConversations: React.Dispatch<React.SetStateAction<Conversation[]>>;
  setActiveConversationId: (v: string | null) => void;
  setCompanionMessageCutoffTs: (v: number) => void;
  setConversationMessages: React.Dispatch<
    React.SetStateAction<ConversationMessage[]>
  >;
  setAutonomousEvents: (v: StreamEventEnvelope[]) => void;
  setAutonomousLatestEventId: (v: string | null) => void;
  setAutonomousRunHealthByRunId: (v: AutonomyRunHealthMap) => void;
  setPtySessions: React.Dispatch<React.SetStateAction<CodingAgentSession[]>>;
  addUnread: (conversationId: string) => void;
  removeUnread: (conversationId: string) => void;
  setChatPendingImages: React.Dispatch<React.SetStateAction<ImageAttachment[]>>;
  resetDraftState: () => void;

  // Refs (for synchronous access in callbacks)
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

  // Autonomy refs
  autonomousStoreRef: React.MutableRefObject<AutonomyEventStore>;
  autonomousEventsRef: React.MutableRefObject<StreamEventEnvelope[]>;
  autonomousLatestEventIdRef: React.MutableRefObject<string | null>;
  autonomousRunHealthByRunIdRef: React.MutableRefObject<AutonomyRunHealthMap>;
  autonomousReplayInFlightRef: React.RefObject<boolean>;
}

export function useChatState(): ChatStateHook {
  const [state, dispatch] = useReducer(
    chatReducer,
    undefined,
    createInitialChatState,
  );

  // ── Refs for synchronous access ──
  const activeConversationIdRef = useRef<string | null>(null);
  const chatInputRef = useRef("");
  const chatPendingImagesRef = useRef<ImageAttachment[]>([]);
  const conversationMessagesRef = useRef<ConversationMessage[]>([]);
  const conversationsRef = useRef<Conversation[]>([]);
  const conversationHydrationEpochRef = useRef(0);
  const chatAbortRef = useRef<AbortController | null>(null);
  const chatSendBusyRef = useRef(false);
  const chatSendNonceRef = useRef(0);
  const greetingFiredRef = useRef(false);
  const greetingInFlightConversationRef = useRef<string | null>(null);
  const companionStaleConversationRefreshRef = useRef<string | null>(null);

  // Autonomy refs
  const autonomousStoreRef = useRef<AutonomyEventStore>({
    eventsById: {},
    eventOrder: [],
    runIndex: {},
    watermark: null,
  });
  const autonomousEventsRef = useRef<StreamEventEnvelope[]>([]);
  const autonomousLatestEventIdRef = useRef<string | null>(null);
  const autonomousRunHealthByRunIdRef = useRef<AutonomyRunHealthMap>({});
  const autonomousReplayInFlightRef = useRef(false);

  // ── Persistence-aware setters ──

  const setChatInput = useCallback((v: string | ((prev: string) => string)) => {
    const next = typeof v === "function" ? v(chatInputRef.current) : v;
    chatInputRef.current = next;
    dispatch({ type: "SET_CHAT_INPUT", value: next });
  }, []);
  const setChatSending = useCallback(
    (v: boolean) => dispatch({ type: "SET_CHAT_SENDING", value: v }),
    [],
  );
  const setChatFirstTokenReceived = useCallback(
    (v: boolean) => dispatch({ type: "SET_FIRST_TOKEN_RECEIVED", value: v }),
    [],
  );
  const setChatLastUsage = useCallback(
    (v: ChatTurnUsage | null) => dispatch({ type: "SET_LAST_USAGE", value: v }),
    [],
  );

  const setChatAvatarVisible = useCallback((v: boolean) => {
    saveChatAvatarVisible(v);
    dispatch({ type: "SET_AVATAR_VISIBLE", value: v });
  }, []);

  const setChatAgentVoiceMuted = useCallback((v: boolean) => {
    saveChatVoiceMuted(v);
    dispatch({ type: "SET_VOICE_MUTED", value: v });
  }, []);

  const setChatMode = useCallback((v: ConversationMode) => {
    saveChatMode(v);
    dispatch({ type: "SET_CHAT_MODE", value: v });
  }, []);

  const setChatAvatarSpeaking = useCallback(
    (v: boolean) => dispatch({ type: "SET_AVATAR_SPEAKING", value: v }),
    [],
  );

  const setConversations = useCallback(
    (v: Conversation[] | ((prev: Conversation[]) => Conversation[])) => {
      const next = typeof v === "function" ? v(conversationsRef.current) : v;
      conversationsRef.current = next;
      dispatch({ type: "SET_CONVERSATIONS", value: next });
    },
    [],
  ) as React.Dispatch<React.SetStateAction<Conversation[]>>;

  const setActiveConversationId = useCallback((v: string | null) => {
    activeConversationIdRef.current = v;
    saveActiveConversationId(v);
    dispatch({ type: "SET_ACTIVE_CONVERSATION_ID", value: v });
  }, []);

  const setCompanionMessageCutoffTs = useCallback((v: number) => {
    saveCompanionMessageCutoffTs(v);
    dispatch({ type: "SET_COMPANION_CUTOFF", value: v });
  }, []);

  const setConversationMessages = useCallback(
    (
      v:
        | ConversationMessage[]
        | ((prev: ConversationMessage[]) => ConversationMessage[]),
    ) => {
      const next =
        typeof v === "function" ? v(conversationMessagesRef.current) : v;
      conversationMessagesRef.current = next;
      dispatch({ type: "SET_MESSAGES", value: next });
    },
    [],
  ) as React.Dispatch<React.SetStateAction<ConversationMessage[]>>;

  const setAutonomousEvents = useCallback((v: StreamEventEnvelope[]) => {
    autonomousEventsRef.current = v;
    dispatch({ type: "SET_AUTONOMOUS_EVENTS", value: v });
  }, []);

  const setAutonomousLatestEventId = useCallback((v: string | null) => {
    autonomousLatestEventIdRef.current = v;
    dispatch({ type: "SET_AUTONOMOUS_LATEST_EVENT_ID", value: v });
  }, []);

  const setAutonomousRunHealthByRunId = useCallback(
    (v: AutonomyRunHealthMap) => {
      autonomousRunHealthByRunIdRef.current = v;
      dispatch({ type: "SET_AUTONOMOUS_RUN_HEALTH", value: v });
    },
    [],
  );

  // Use a ref to support functional updaters since reducer dispatch doesn't have prev state
  const ptySessionsRef = useRef<CodingAgentSession[]>([]);
  const setPtySessions = useCallback(
    (
      v:
        | CodingAgentSession[]
        | ((prev: CodingAgentSession[]) => CodingAgentSession[]),
    ) => {
      const next = typeof v === "function" ? v(ptySessionsRef.current) : v;
      ptySessionsRef.current = next;
      dispatch({ type: "SET_PTY_SESSIONS", value: next });
    },
    [],
  ) as React.Dispatch<React.SetStateAction<CodingAgentSession[]>>;
  const addUnread = useCallback(
    (id: string) => dispatch({ type: "ADD_UNREAD", conversationId: id }),
    [],
  );
  const removeUnread = useCallback(
    (id: string) => dispatch({ type: "REMOVE_UNREAD", conversationId: id }),
    [],
  );

  // For setChatPendingImages, support both direct value and updater function
  const setChatPendingImages = useCallback(
    (
      v: ImageAttachment[] | ((prev: ImageAttachment[]) => ImageAttachment[]),
    ) => {
      const next =
        typeof v === "function" ? v(chatPendingImagesRef.current) : v;
      chatPendingImagesRef.current = next;
      dispatch({ type: "SET_PENDING_IMAGES", value: next });
    },
    [],
  ) as React.Dispatch<React.SetStateAction<ImageAttachment[]>>;

  const resetDraftState = useCallback(() => {
    conversationHydrationEpochRef.current += 1;
    greetingFiredRef.current = false;
    greetingInFlightConversationRef.current = null;
    chatInputRef.current = "";
    chatPendingImagesRef.current = [];
    conversationMessagesRef.current = [];
    activeConversationIdRef.current = null;
    dispatch({ type: "RESET_DRAFT" });
  }, []);

  return {
    state,
    dispatch,
    setChatInput,
    setChatSending,
    setChatFirstTokenReceived,
    setChatLastUsage,
    setChatAvatarVisible,
    setChatAgentVoiceMuted,
    setChatMode,
    setChatAvatarSpeaking,
    setConversations,
    setActiveConversationId,
    setCompanionMessageCutoffTs,
    setConversationMessages,
    setAutonomousEvents,
    setAutonomousLatestEventId,
    setAutonomousRunHealthByRunId,
    setPtySessions,
    addUnread,
    removeUnread,
    setChatPendingImages,
    resetDraftState,
    activeConversationIdRef,
    chatInputRef,
    chatPendingImagesRef,
    conversationMessagesRef,
    conversationsRef,
    conversationHydrationEpochRef,
    chatAbortRef,
    chatSendBusyRef,
    chatSendNonceRef,
    greetingFiredRef,
    greetingInFlightConversationRef,
    companionStaleConversationRefreshRef,
    autonomousStoreRef,
    autonomousEventsRef,
    autonomousLatestEventIdRef,
    autonomousRunHealthByRunIdRef,
    autonomousReplayInFlightRef,
  };
}

export type { ChatAction as ChatDispatchAction };
