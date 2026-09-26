/** Re-exports the canonical document service contract from its feature owner. */
export {
  type DocumentAddedByRole,
  type DocumentAddedFrom,
  type DocumentSearchMode,
  type DocumentsLoadFailReason,
  type DocumentsServiceLike,
  type DocumentsServiceResult,
  type DocumentVisibilityScope,
  getDocumentsService,
  getDocumentsServiceTimeoutMs,
} from "@elizaos/plugin-assistant";
