/**
 * ChatComposerContext — isolated context for chat input state.
 *
 * chatInput, chatSending, and chatPendingImages change on every
 * keystroke / send cycle. Keeping them in AppContext would cascade
 * re-renders to every useApp() subscriber (CompanionViewOverlay,
 * sidebar panels, settings, etc.). This context lets only the
 * composer and its direct consumers re-render.
 *
 * The context objects, hooks, and draft-persistence helpers live here (not in
 * the sibling .tsx) so the Provider file stays React Fast Refresh-compatible.
 */

import {
  createContext,
  type Dispatch,
  type RefObject,
  type SetStateAction,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ImageAttachment } from "../api/client-types-chat";
import { shellLocalStorage } from "../surface-realm-channel";
import {
  clearPendingChatTurn,
  listPendingChatTurns,
  markPendingChatTurnRestored,
  PENDING_CHAT_TURN_SETTLE_TIMEOUT_MS,
  PENDING_CHAT_TURN_SETTLED_EVENT,
  releasePendingChatTurnDraft,
} from "./pending-chat-turns";

/**
 * The message the composer is currently replying to. Set by the per-row Reply
 * affordance, rendered as the "Replying to …" pill above the composer, and read
 * on send to stamp `metadata.replyToMessageId` on the outgoing turn (the API
 * boundary lifts that onto `content.inReplyTo`, which the REPLY_CONTEXT provider
 * reads to pull the surrounding exchange into model context). `senderName` and
 * `snippet` are display-only — the server resolves the real target from the id.
 */
export interface ChatReplyTarget {
  messageId: string;
  senderName: string;
  snippet: string;
}

export interface ChatComposerValue {
  chatInput: string;
  chatSending: boolean;
  chatPendingImages: ImageAttachment[];
  chatReplyTarget: ChatReplyTarget | null;
  setChatInput: (v: string) => void;
  setChatPendingImages: Dispatch<SetStateAction<ImageAttachment[]>>;
  setChatReplyTarget: (target: ChatReplyTarget | null) => void;
}

const DEFAULT_COMPOSER: ChatComposerValue = {
  chatInput: "",
  chatSending: false,
  chatPendingImages: [],
  chatReplyTarget: null,
  setChatInput: () => {},
  setChatPendingImages: () => {},
  setChatReplyTarget: () => {},
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

/**
 * The composer draft for chat input SURFACES (overlay, ChatSurface): the
 * shared ChatComposerContext slot when a provider is mounted — so every
 * surface targeting the app's active conversation edits ONE draft, and
 * AppContext-level draft persistence/handoff repaints them all — with a
 * local-state fallback when none is (stories, e2e fixtures, standalone
 * mounts), where the default context's no-op setters would make typing dead.
 */
export function useChatComposerOrLocal(): ChatComposerValue {
  const ctx = useContext(ChatComposerCtx);
  const [localInput, setLocalInput] = useState("");
  const [localImages, setLocalImages] = useState<ImageAttachment[]>([]);
  const [localReplyTarget, setLocalReplyTarget] =
    useState<ChatReplyTarget | null>(null);
  const local = useMemo<ChatComposerValue>(
    () => ({
      chatInput: localInput,
      chatSending: false,
      chatPendingImages: localImages,
      chatReplyTarget: localReplyTarget,
      setChatInput: setLocalInput,
      setChatPendingImages: setLocalImages,
      setChatReplyTarget: setLocalReplyTarget,
    }),
    [localInput, localImages, localReplyTarget],
  );
  return ctx === DEFAULT_COMPOSER ? local : ctx;
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
  for (const receipt of listPendingChatTurns(conversationId)) {
    if (receipt.restoredToDraft && receipt.text !== draft)
      releasePendingChatTurnDraft(conversationId, receipt.clientMessageId);
  }
  try {
    if (draft.length > 0) {
      shellLocalStorage.setItem(key, draft);
    } else {
      shellLocalStorage.removeItem(key);
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
    shellLocalStorage.removeItem(chatDraftStorageKey(conversationId));
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
      shellLocalStorage.removeItem(key);
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
  const chatInputRef = useRef(chatInput);
  chatInputRef.current = chatInput;
  const draftOwnerRef = useRef<{
    conversationId: string;
    clientMessageId: string;
    text: string;
  } | null>(null);
  const previousInputRef = useRef({
    conversationId: activeConversationId,
    text: chatInput,
  });

  useEffect(() => {
    if (!activeConversationId) return;
    const onSettled = (event: Event) => {
      const detail = (event as CustomEvent).detail as
        | { conversationId?: string; clientMessageId?: string; text?: string }
        | undefined;
      if (
        detail?.conversationId !== activeConversationId ||
        draftOwnerRef.current?.conversationId !== activeConversationId ||
        draftOwnerRef.current.clientMessageId !== detail.clientMessageId ||
        typeof detail.text !== "string" ||
        draftOwnerRef.current.text !== detail.text ||
        chatInputRef.current !== detail.text ||
        readChatDraft(activeConversationId) !== detail.text
      ) {
        return;
      }
      draftOwnerRef.current = null;
      clearChatDraft(activeConversationId);
      setChatInput("");
    };
    window.addEventListener(PENDING_CHAT_TURN_SETTLED_EVENT, onSettled);
    return () =>
      window.removeEventListener(PENDING_CHAT_TURN_SETTLED_EVENT, onSettled);
  }, [activeConversationId, setChatInput]);

  // Restore on mount / conversation change.
  useEffect(() => {
    lastRestoredRef.current = activeConversationId;
    draftOwnerRef.current = null;
    if (!activeConversationId) return;
    const saved = readChatDraft(activeConversationId);
    if (saved !== null) {
      const owners = listPendingChatTurns(activeConversationId).filter(
        (receipt) => receipt.restoredToDraft === true && receipt.text === saved,
      );
      if (owners.length === 1) draftOwnerRef.current = owners[0];
      setChatInput(saved);
    }
  }, [activeConversationId, setChatInput]);

  useEffect(() => {
    const previous = previousInputRef.current;
    previousInputRef.current = {
      conversationId: activeConversationId,
      text: chatInput,
    };
    const owner = draftOwnerRef.current;
    if (
      owner &&
      owner.conversationId === activeConversationId &&
      previous.conversationId === activeConversationId &&
      previous.text !== chatInput &&
      owner.text !== chatInput
    ) {
      // Revoke before the debounce, so editing away and back cannot reclaim an
      // old receipt by text equality. Sending still snapshots its retry id first.
      draftOwnerRef.current = null;
      releasePendingChatTurnDraft(owner.conversationId, owner.clientMessageId);
    }
  }, [activeConversationId, chatInput]);

  useEffect(() => {
    if (!activeConversationId) return;
    const receipts = listPendingChatTurns(activeConversationId);
    if (receipts.length === 0) return;
    const receipt = receipts[0];
    if (!receipt) return;
    const restore = (): void => {
      const stillPending = listPendingChatTurns(activeConversationId).some(
        (pending) => pending.clientMessageId === receipt.clientMessageId,
      );
      if (!stillPending) return;
      const existingDraft = readChatDraft(activeConversationId);
      if (existingDraft !== null) {
        // A prior cold launch may have restored this same uncertain send. Keep
        // its id across subsequent launches; only a different edited draft
        // supersedes it.
        if (existingDraft !== receipt.text) {
          clearPendingChatTurn(activeConversationId, receipt.clientMessageId);
        }
        return;
      }
      if (
        !markPendingChatTurnRestored(
          activeConversationId,
          receipt.clientMessageId,
        )
      )
        return;
      draftOwnerRef.current = receipt;
      writeChatDraft(activeConversationId, receipt.text);
      setChatInput(receipt.text);
      // Keep the original id until canonical history settles this send. If the
      // user submits this recovered draft while offline, the server can dedupe
      // the same logical turn instead of running it twice.
    };
    // A cold launch may happen long after restoreAt. Give canonical history a
    // fresh window to arrive and clear this receipt before restoring a prompt
    // the host already accepted; restoring immediately duplicates its draft.
    const delay = Math.max(
      PENDING_CHAT_TURN_SETTLE_TIMEOUT_MS,
      receipt.restoreAt - Date.now(),
    );
    const timer = window.setTimeout(restore, delay);
    return () => window.clearTimeout(timer);
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
