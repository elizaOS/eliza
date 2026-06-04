/**
 * Compatibility re-export. The chat composer context objects, hooks, and
 * draft-persistence helpers live in `./ChatComposerContext.hooks` so importers
 * stay React Fast Refresh-compatible. Kept so the `state` barrel resolves
 * unchanged.
 */
export {
  CHAT_DRAFT_STORAGE_PREFIX,
  ChatComposerCtx,
  type ChatComposerValue,
  ChatInputRefCtx,
  chatDraftStorageKey,
  clearAllChatDrafts,
  clearChatDraft,
  readChatDraft,
  useChatComposer,
  useChatComposerDraftPersistence,
  useChatInputRef,
  writeChatDraft,
} from "./ChatComposerContext.hooks";
