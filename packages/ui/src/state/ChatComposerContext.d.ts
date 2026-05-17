/**
 * ChatComposerContext — isolated context for chat input state.
 *
 * chatInput, chatSending, and chatPendingImages change on every
 * keystroke / send cycle. Keeping them in AppContext would cascade
 * re-renders to every useApp() subscriber (CompanionViewOverlay,
 * sidebar panels, settings, etc.). This context lets only the
 * composer and its direct consumers re-render.
 */
import { type Dispatch, type RefObject, type SetStateAction } from "react";
import type { ImageAttachment } from "../api";
export interface ChatComposerValue {
  chatInput: string;
  chatSending: boolean;
  chatPendingImages: ImageAttachment[];
  setChatInput: (v: string) => void;
  setChatPendingImages: Dispatch<SetStateAction<ImageAttachment[]>>;
}
export declare const ChatComposerCtx: import("react").Context<ChatComposerValue>;
/**
 * Stable ref to the current draft text (mirrors chat input state) so helpers
 * like useContextMenu can append quoted text without subscribing to every
 * keystroke re-render.
 */
export declare const ChatInputRefCtx: import("react").Context<RefObject<string> | null>;
export declare function useChatComposer(): ChatComposerValue;
export declare function useChatInputRef(): RefObject<string> | null;
/** Storage prefix for per-conversation draft text. */
export declare const CHAT_DRAFT_STORAGE_PREFIX = "eliza:chat:draft:";
/** Build the localStorage key for a given conversation's draft. */
export declare function chatDraftStorageKey(conversationId: string): string;
/** Read a saved draft for the given conversation, or `null` if absent. */
export declare function readChatDraft(
  conversationId: string | null,
): string | null;
/** Persist (or clear) the current draft for the given conversation. */
export declare function writeChatDraft(
  conversationId: string | null,
  draft: string,
): void;
/** Remove the saved draft for a single conversation. */
export declare function clearChatDraft(conversationId: string | null): void;
/**
 * Remove every saved draft. Called when the user switches accounts —
 * drafts are per-conversation, and conversation ids are per-account.
 */
export declare function clearAllChatDrafts(): void;
/**
 * Persist the current draft on every change (debounced 500ms) and
 * restore it whenever the active conversation changes.
 *
 * Clearing happens through {@link clearChatDraft} (call from the chat
 * send success path) and {@link clearAllChatDrafts} (call on account
 * switch).
 */
export declare function useChatComposerDraftPersistence({
  activeConversationId,
  chatInput,
  setChatInput,
}: {
  activeConversationId: string | null;
  chatInput: string;
  setChatInput: (next: string) => void;
}): void;
//# sourceMappingURL=ChatComposerContext.d.ts.map
