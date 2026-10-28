/** Records canonical host decisions without fabricating model calls, provider usage, or delivery receipts. */
import type {
  EvaluatorOutput,
  PlannerRuntime,
  RecordedStage,
  TrajectoryRecorder,
} from "@elizaos/core";

export async function recordGatedEvaluationStage(args: {
  runtime?: Pick<PlannerRuntime, "reportError">;
  recorder?: TrajectoryRecorder;
  trajectoryId?: string;
  parentStageId?: string;
  iteration: number;
  startedAt: number;
  endedAt: number;
  output: EvaluatorOutput;
  reason?: string;
  evaluationSnapshot?: string;
  logger?: PlannerRuntime["logger"];
}): Promise<void> {
  if (!args.recorder || !args.trajectoryId) return;
  try {
    const stage: RecordedStage = {
      stageId: `stage-eval-iter-${args.iteration}-${args.startedAt}-gated${args.evaluationSnapshot ? `-read-${args.evaluationSnapshot}` : ""}`,
      kind: "evaluation",
      iteration: args.iteration,
      parentStageId: args.parentStageId,
      startedAt: args.startedAt,
      endedAt: args.endedAt,
      latencyMs: args.endedAt - args.startedAt,
      evaluation: {
        success: args.output.success,
        decision: args.output.decision,
        thought: args.output.thought,
        messageToUser: args.output.messageToUser,
        recommendedToolCallId: args.output.recommendedToolCallId,
        typedReadAwaitingEvidence: args.output.typedReadAwaitingEvidence,
        typedReadSnapshot: args.output.typedReadSnapshot,
        typedReadFinal: args.output.typedReadFinal,
        typedReadRendered: args.output.typedReadRendered,
        gated: true,
        llmCallSkipped: true,
        reason: args.reason ?? "explicit_terminal_reply",
        ...(args.output.effectReceiptIds?.length
          ? { effectReceiptIds: [...args.output.effectReceiptIds] }
          : {}),
        ...(typeof args.output.raw?.source === "string"
          ? { source: args.output.raw.source }
          : {}),
      },
    };
    await args.recorder.recordStage(args.trajectoryId, stage);
  } catch (err) {
    // error-policy:J7 Trajectory persistence is diagnostic and cannot alter
    // the planner decision it records.
    args.logger?.warn?.(
      { err: (err as Error).message, trajectoryId: args.trajectoryId },
      "[TrajectoryRecorder] failed to record gated evaluation stage",
    );
    args.runtime?.reportError?.("PlannerLoop.recordGatedEvaluation", err, {
      trajectoryId: args.trajectoryId,
    });
  }
}
