/**
 * ChatComposerContext — isolated context for chat input state.
 *
 * chatInput, chatSending, and chatPendingImages change on every
 * keystroke / send cycle. Keeping them in AppContext would cascade
 * re-renders to every useApp() subscriber (CompanionViewOverlay,
 * sidebar panels, settings, etc.). This context lets only the
 * composer and its direct consumers re-render.
 */

import {
  createContext,
  type Dispatch,
  type RefObject,
  type SetStateAction,
  useContext,
  useEffect,
  useRef,
} from "react";
import type { ImageAttachment } from "../api";

export interface ChatComposerValue {
  chatInput: string;
  chatSending: boolean;
  chatPendingImages: ImageAttachment[];
  setChatInput: (v: string) => void;
  setChatPendingImages: Dispatch<SetStateAction<ImageAttachment[]>>;
}

const DEFAULT_COMPOSER: ChatComposerValue = {
  chatInput: "",
  chatSending: false,
  chatPendingImages: [],
  setChatInput: () => {},
  setChatPendingImages: () => {},
};

export const ChatComposerCtx =
  createContext<ChatComposerValue>(DEFAULT_COMPOSER);

/**
 * Stable ref to the current draft text (mirrors chat input state) so helpers
 * like useContextMenu can append quoted text without subscribing to every
 * keystroke re-render.
 */
export const ChatInputRefCtx = createContext<RefObject<string> | null>(null);

export function useChatComposer(): ChatComposerValue {
  return useContext(ChatComposerCtx);
}

export function useChatInputRef(): RefObject<string> | null {
  return useContext(ChatInputRefCtx);
}

// ── Draft persistence ───────────────────────────────────────────────────

/** Storage prefix for per-conversation draft text. */
export const CHAT_DRAFT_STORAGE_PREFIX = "eliza:chat:draft:";
const CHAT_DRAFT_DEBOUNCE_MS = 500;

/** Build the localStorage key for a given conversation's draft. */
export function chatDraftStorageKey(conversationId: string): string {
  return `${CHAT_DRAFT_STORAGE_PREFIX}${conversationId}`;
}

/** Read a saved draft for the given conversation, or `null` if absent. */
export function readChatDraft(conversationId: string | null): string | null {
  if (!conversationId) return null;
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(chatDraftStorageKey(conversationId));
  } catch {
    return null;
  }
}

/** Persist (or clear) the current draft for the given conversation. */
export function writeChatDraft(
  conversationId: string | null,
  draft: string,
): void {
  if (!conversationId) return;
  if (typeof window === "undefined") return;
  const key = chatDraftStorageKey(conversationId);
  try {
    if (draft.length > 0) {
      window.localStorage.setItem(key, draft);
    } else {
      window.localStorage.removeItem(key);
    }
  } catch {
    // Storage quota / sandbox errors are non-fatal — the draft is just
    // not persisted this cycle.
  }
}

/** Remove the saved draft for a single conversation. */
export function clearChatDraft(conversationId: string | null): void {
  if (!conversationId) return;
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(chatDraftStorageKey(conversationId));
  } catch {
    /* noop */
  }
}

/**
 * Remove every saved draft. Called when the user switches accounts —
 * drafts are per-conversation, and conversation ids are per-account.
 */
export function clearAllChatDrafts(): void {
  if (typeof window === "undefined") return;
  try {
    const toRemove: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (key?.startsWith(CHAT_DRAFT_STORAGE_PREFIX)) {
        toRemove.push(key);
      }
    }
    for (const key of toRemove) {
      window.localStorage.removeItem(key);
    }
  } catch {
    /* noop */
  }
}

/**
 * Persist the current draft on every change (debounced 500ms) and
 * restore it whenever the active conversation changes.
 *
 * Clearing happens through {@link clearChatDraft} (call from the chat
 * send success path) and {@link clearAllChatDrafts} (call on account
 * switch).
 */
export function useChatComposerDraftPersistence({
  activeConversationId,
  chatInput,
  setChatInput,
}: {
  activeConversationId: string | null;
  chatInput: string;
  setChatInput: (next: string) => void;
}): void {
  // Track the conversation we last restored from so we don't immediately
  // overwrite the restored draft with the previous conversation's input.
  const lastRestoredRef = useRef<string | null>(null);

  // Restore on mount / conversation change.
  useEffect(() => {
    lastRestoredRef.current = activeConversationId;
    if (!activeConversationId) return;
    const saved = readChatDraft(activeConversationId);
    if (saved !== null) {
      setChatInput(saved);
    }
  }, [activeConversationId, setChatInput]);

  // Persist on change (debounced).
  useEffect(() => {
    if (!activeConversationId) return;
    // Skip the very first effect run after a restore — chatInput is still
    // the value we just set, no need to write it back.
    if (lastRestoredRef.current !== activeConversationId) return;
    const timer = setTimeout(() => {
      writeChatDraft(activeConversationId, chatInput);
    }, CHAT_DRAFT_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [activeConversationId, chatInput]);
}
