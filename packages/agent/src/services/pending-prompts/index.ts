/**
 * Runtime pending-prompts store: open scheduled-task prompts awaiting an
 * owner reply, surfaced through the registered {@link PendingPromptsService}.
 * Cache-backed (no SQL), keyed per room.
 */

export {
  PENDING_PROMPTS_SERVICE,
  PendingPromptsService,
  resolvePendingPromptsService,
} from "./service.ts";
export {
  createPendingPromptsStore,
  type ExpectedReplyKind,
  type PendingPrompt,
  type PendingPromptRecordInput,
  type PendingPromptsStore,
  type PendingPromptWithRoom,
  type RecordedPendingPrompt,
} from "./store.ts";
