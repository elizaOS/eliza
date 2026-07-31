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
  ImageAttachment,
  StreamEventEnvelope,
} from "../api";
import type { AutonomyEventStore, AutonomyRunHealthMap } from "./autonomy";
import type { ChatReplyTarget } from "./ChatComposerContext.hooks";
import { dedupeGreetings, isAgentGreetingMessage } from "./greeting-dedupe";
import {
  loadChatAvatarVisible,
  loadChatVoiceMuted,
  loadCompanionMessageCutoffTs,
  saveActiveConversationId,
  saveChatAvatarVisible,
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
  chatReplyTarget: ChatReplyTarget | null;
}

function createInitialChatState(): ChatState {
  return {
    chatInput: "",
    chatSending: false,
    chatFirstTokenReceived: false,
    chatLastUsage: null,
    chatAvatarVisible: loadChatAvatarVisible(),
    chatAgentVoiceMuted: loadChatVoiceMuted(),
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
    chatReplyTarget: null,
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
  | { type: "SET_AVATAR_SPEAKING"; value: boolean }
  | { type: "SET_CONVERSATIONS"; value: Conversation[] }
  | { type: "SET_ACTIVE_CONVERSATION_ID"; value: string | null }
  | { type: "SET_COMPANION_CUTOFF"; value: number }
  | { type: "SET_MESSAGES"; value: ConversationMessage[] }
  | { type: "PREPEND_MESSAGES"; value: ConversationMessage[] }
  | { type: "APPEND_MESSAGE"; message: ConversationMessage }
  | { type: "UPDATE_MESSAGE"; id: string; update: Partial<ConversationMessage> }
  | { type: "REMOVE_MESSAGE"; id: string }
  | { type: "SET_AUTONOMOUS_EVENTS"; value: StreamEventEnvelope[] }
  | { type: "SET_AUTONOMOUS_LATEST_EVENT_ID"; value: string | null }
  | { type: "SET_AUTONOMOUS_RUN_HEALTH"; value: AutonomyRunHealthMap }
  | { type: "SET_PTY_SESSIONS"; value: CodingAgentSession[] }
  | { type: "ADD_UNREAD"; conversationId: string }
  | { type: "REMOVE_UNREAD"; conversationId: string }
  | { type: "SET_PENDING_IMAGES"; value: ImageAttachment[] }
  | { type: "SET_REPLY_TARGET"; value: ChatReplyTarget | null }
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
    case "SET_AVATAR_SPEAKING":
      return { ...state, chatAvatarSpeaking: action.value };
    case "SET_CONVERSATIONS":
      return { ...state, conversations: action.value };
    case "SET_ACTIVE_CONVERSATION_ID": {
      const activeConversationId = action.value;
      // Opening a conversation marks it read: clear its unread badge here, at
      // the point it actually becomes active. The functional
      // `setUnreadConversations` updater path can't reach REMOVE_UNREAD (the
      // provider's wrapper only re-adds ids, never removes), so clear-on-open
      // has to happen on the active-id transition or unread badges never clear.
      if (
        !activeConversationId ||
        !state.unreadConversations.has(activeConversationId)
      ) {
        return { ...state, activeConversationId };
      }
      const unreadConversations = new Set(state.unreadConversations);
      unreadConversations.delete(activeConversationId);
      return { ...state, activeConversationId, unreadConversations };
    }
    case "SET_COMPANION_CUTOFF":
      return { ...state, companionMessageCutoffTs: action.value };
    case "SET_MESSAGES":
      return { ...state, conversationMessages: action.value };
    // Merge an older page in front for infinite upward scroll (#13532). Never
    // trims: the newest tail must survive so bottom-follow still
    // reach the true latest, and — critically — so the scroll-anchor restore in
    // useLoadOlderOnScroll (scrollTop += scrollHeight delta) sees ONLY the
    // upward growth. Dropping the bottom in the same commit would shrink that
    // delta by the removed height and yank the viewport downward past the cap.
    case "PREPEND_MESSAGES": {
      if (action.value.length === 0) return state;
      const existingIds = new Set(state.conversationMessages.map((m) => m.id));
      const olderToAdd = action.value.filter((m) => !existingIds.has(m.id));
      if (olderToAdd.length === 0) return state;
      return {
        ...state,
        conversationMessages: [...olderToAdd, ...state.conversationMessages],
      };
    }
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
    // Remove a single message by id (#13533). Backs the persistent per-message
    // delete: optimistic removal here, re-hydrate on server failure.
    case "REMOVE_MESSAGE":
      return {
        ...state,
        conversationMessages: state.conversationMessages.filter(
          (m) => m.id !== action.id,
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
    case "SET_REPLY_TARGET":
      return { ...state, chatReplyTarget: action.value };
    case "RESET_DRAFT":
      return {
        ...state,
        chatInput: "",
        chatPendingImages: [],
        chatReplyTarget: null,
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
  setChatAvatarSpeaking: (v: boolean) => void;
  setConversations: React.Dispatch<React.SetStateAction<Conversation[]>>;
  setActiveConversationId: (v: string | null) => void;
  setCompanionMessageCutoffTs: (v: number) => void;
  setConversationMessages: React.Dispatch<
    React.SetStateAction<ConversationMessage[]>
  >;
  /**
   * Merge an older page in front of the current thread for infinite upward
   * scroll (#13532). Dedupes by id and keeps the synchronous
   * `conversationMessagesRef` in step with the reducer. Never trims the newest
   * tail (see the PREPEND_MESSAGES reducer note).
   */
  prependConversationMessages: (older: ConversationMessage[]) => void;
  setAutonomousEvents: (v: StreamEventEnvelope[]) => void;
  setAutonomousLatestEventId: (v: string | null) => void;
  setAutonomousRunHealthByRunId: (v: AutonomyRunHealthMap) => void;
  setPtySessions: React.Dispatch<React.SetStateAction<CodingAgentSession[]>>;
  addUnread: (conversationId: string) => void;
  removeUnread: (conversationId: string) => void;
  setChatPendingImages: React.Dispatch<React.SetStateAction<ImageAttachment[]>>;
  setChatReplyTarget: (v: ChatReplyTarget | null) => void;
  resetDraftState: () => void;

  // Refs (for synchronous access in callbacks)
  activeConversationIdRef: React.RefObject<string | null>;
  chatInputRef: React.RefObject<string>;
  chatPendingImagesRef: React.RefObject<ImageAttachment[]>;
  chatReplyTargetRef: React.RefObject<ChatReplyTarget | null>;
  conversationMessagesRef: React.RefObject<ConversationMessage[]>;
  conversationsRef: React.RefObject<Conversation[]>;
  conversationHydrationEpochRef: React.MutableRefObject<number>;
  chatAbortRef: React.RefObject<AbortController | null>;
  chatSendBusyRef: React.RefObject<boolean>;
  chatSendNonceRef: React.MutableRefObject<number>;
  greetingFiredRef: React.RefObject<boolean>;
  greetingInFlightConversationRef: React.RefObject<string | null>;

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
  const chatReplyTargetRef = useRef<ChatReplyTarget | null>(null);
  const conversationMessagesRef = useRef<ConversationMessage[]>([]);
  const conversationsRef = useRef<Conversation[]>([]);
  const conversationHydrationEpochRef = useRef(0);
  const chatAbortRef = useRef<AbortController | null>(null);
  const chatSendBusyRef = useRef(false);
  const chatSendNonceRef = useRef(0);
  const greetingFiredRef = useRef(false);
  const greetingInFlightConversationRef = useRef<string | null>(null);

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
      const raw =
        typeof v === "function" ? v(conversationMessagesRef.current) : v;
      // Enforce the single-greeting-per-thread invariant at the one commit
      // point every seed path routes through. Multiple independent paths seed
      // an agent greeting (inline `createConversation({ bootstrapGreeting })`
      // SET, the `fetchGreeting` fallback APPEND, and the cloud agent-switch
      // reseed); a create/fetch race across an agent switch could otherwise
      // land two greeting-sourced bubbles with identical text, which the
      // per-seed `appendGreetingOnce` guard cannot catch once state resets
      // between the two seeds (the device-review duplicate-greeting defect).
      // `dedupeGreetings` returns the SAME reference when the invariant already
      // holds, so this is a no-op for every normal commit and only collapses a
      // would-be duplicate — keeping the earliest greeting so the visible
      // bubble never swaps under the user.
      const next = dedupeGreetings(raw);
      conversationMessagesRef.current = next;
      dispatch({ type: "SET_MESSAGES", value: next });
    },
    [],
  ) as React.Dispatch<React.SetStateAction<ConversationMessage[]>>;

  const prependConversationMessages = useCallback(
    (older: ConversationMessage[]) => {
      if (older.length === 0) return;
      const current = conversationMessagesRef.current;
      // Single-greeting invariant across pagination: on an already-poisoned
      // thread the duplicated greeting pair sits at the very HEAD, so both rows
      // arrive together in a load-older batch and would bypass the
      // setConversationMessages dedupe seam. Filter the batch before BOTH
      // commits (ref + dispatch) so the reducer's id-merge sees the same
      // survivors and stays in lockstep. Healthy threads are untouched: a window
      // that legitimately missed its single greeting still prepends it (current
      // has none → dedupeGreetings(older) is a same-ref no-op).
      const olderDeduped = current.some(isAgentGreetingMessage)
        ? older.filter((m) => !isAgentGreetingMessage(m))
        : dedupeGreetings(older);
      if (olderDeduped.length === 0) return;
      const existingIds = new Set(current.map((m) => m.id));
      const olderToAdd = olderDeduped.filter((m) => !existingIds.has(m.id));
      if (olderToAdd.length === 0) return;
      conversationMessagesRef.current = [...olderToAdd, ...current];
      dispatch({ type: "PREPEND_MESSAGES", value: olderDeduped });
    },
    [],
  );

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

  const setChatReplyTarget = useCallback((v: ChatReplyTarget | null) => {
    chatReplyTargetRef.current = v;
    dispatch({ type: "SET_REPLY_TARGET", value: v });
  }, []);

  const resetDraftState = useCallback(() => {
    conversationHydrationEpochRef.current += 1;
    greetingFiredRef.current = false;
    greetingInFlightConversationRef.current = null;
    chatInputRef.current = "";
    chatPendingImagesRef.current = [];
    chatReplyTargetRef.current = null;
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
    setChatAvatarSpeaking,
    setConversations,
    setActiveConversationId,
    setCompanionMessageCutoffTs,
    setConversationMessages,
    prependConversationMessages,
    setAutonomousEvents,
    setAutonomousLatestEventId,
    setAutonomousRunHealthByRunId,
    setPtySessions,
    addUnread,
    removeUnread,
    setChatPendingImages,
    setChatReplyTarget,
    resetDraftState,
    activeConversationIdRef,
    chatInputRef,
    chatPendingImagesRef,
    chatReplyTargetRef,
    conversationMessagesRef,
    conversationsRef,
    conversationHydrationEpochRef,
    chatAbortRef,
    chatSendBusyRef,
    chatSendNonceRef,
    greetingFiredRef,
    greetingInFlightConversationRef,
    autonomousStoreRef,
    autonomousEventsRef,
    autonomousLatestEventIdRef,
    autonomousRunHealthByRunIdRef,
    autonomousReplayInFlightRef,
  };
}

export type { ChatAction as ChatDispatchAction };
