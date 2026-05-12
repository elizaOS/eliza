// Canonical types and the runtime service loader live in @elizaos/agent.
// Re-export them from one place so route handlers, presenters, and any other
// consumers in this plugin don't drift from the agent-side definitions.
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
} from "@elizaos/agent";
