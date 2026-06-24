/**
 * Runtime handoff store: per-room handoff state gating agent contributions,
 * surfaced through the registered {@link HandoffService}. Cache-backed (no SQL),
 * keyed per room.
 */

export {
  HANDOFF_SERVICE,
  HandoffService,
  resolveHandoffService,
} from "./service.ts";
export {
  createHandoffStore,
  describeResumeCondition,
  evaluateResume,
  type HandoffEnterOpts,
  type HandoffStatus,
  type HandoffStore,
  type ResumeCondition,
  type ResumeEvaluation,
  type ResumeEvaluationInput,
} from "./store.ts";
