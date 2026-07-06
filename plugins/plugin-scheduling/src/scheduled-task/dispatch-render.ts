/**
 * Model-mediated rendering for scheduled-task dispatches. A task's
 * `promptInstructions` is instruction-voice model input ("Remind the owner to
 * take their medication and ask how they slept"), never user-facing copy —
 * hosts author it explicitly as a model prompt (see PA's
 * `default-packs/persona-packs.ts`). Every dispatcher that emits to a
 * user-visible surface (assistant stream, notification body, connector channel
 * send) must call {@link renderScheduledDispatchMessage} first so the owner
 * receives the model's composed message, not the instruction itself. Consumers:
 * the spine's default notification dispatcher (`runner-service.ts`) and PA's
 * production dispatcher (`plugin-personal-assistant` runtime-wiring).
 *
 * Same model seam as PA's `CheckinService.renderSummary`:
 * `runWithTrajectoryPurpose` + `runtime.useModel(TEXT_LARGE)`. Fail-fast by
 * design: a missing model surface, a thrown model call, or blank output throws
 * `ElizaError` — dispatchers translate that via
 * {@link renderFailureDispatchResult} into a typed, retryable `DispatchResult`.
 * There is deliberately no raw-instruction fallback; delivering the
 * instruction text verbatim was the bug this module fixes. Rendering consumes
 * `promptInstructions` as an opaque prompt payload and keys only on structural
 * fields (`intensity`, `firedAtIso`), per the frozen scheduled-task contract.
 */

import {
  ElizaError,
  type IAgentRuntime,
  ModelType,
  runWithTrajectoryPurpose,
} from "@elizaos/core";
import type { DispatchResult } from "../dispatch-types.js";
import type { ScheduledTaskDispatchRecord } from "./runner.js";

/**
 * Backoff for a failed model render: the failure is host-local (the model
 * surface is down or misbehaving), so escalating to another channel cannot
 * help — every channel renders through the same model. An explicit
 * `retryAfterMinutes` makes `decideDispatchPolicy` retry the same ladder step
 * instead of advancing/failing. Mirrors the policy's own rate-limit default.
 */
export const RENDER_FAILURE_RETRY_MINUTES = 5;

/**
 * Build the delivery prompt for one dispatch. Exported for direct unit testing
 * of prompt content. The instruction is embedded as opaque payload — nothing
 * here branches on its text.
 */
export function buildScheduledDispatchRenderPrompt(
  record: Pick<
    ScheduledTaskDispatchRecord,
    "promptInstructions" | "intensity" | "firedAtIso"
  >,
): string {
  const lines: string[] = [
    "You are the owner's personal assistant. A scheduled task just fired and you must now write the message to send to the owner.",
    "The instruction below tells you what to communicate. It is an instruction to you, not the message itself — never repeat or quote it verbatim.",
    "Write only the message body, speaking directly to the owner in a natural assistant voice.",
    "Do not mention scheduled tasks, instructions, or that this message was automated. No preamble, no markdown fences, no meta commentary.",
  ];
  if (record.intensity === "urgent") {
    lines.push(
      "This is urgent: be direct and make clear that action is needed now.",
    );
  } else if (record.intensity === "soft") {
    lines.push("Keep it light and gentle — a nudge, not a demand.");
  }
  lines.push(
    "",
    "Instruction:",
    record.promptInstructions,
    "",
    `Fired at: ${record.firedAtIso}`,
    "",
    "Message:",
  );
  return lines.join("\n");
}

/**
 * Render the user-facing message for a dispatch through the runtime's model.
 * Throws `ElizaError` (ephemeral) when the model surface is missing, the model
 * call fails, or the model returns blank output — callers must translate the
 * failure into a typed dispatch failure, never substitute the raw instruction.
 */
export async function renderScheduledDispatchMessage(
  runtime: IAgentRuntime,
  record: ScheduledTaskDispatchRecord,
): Promise<string> {
  if (typeof runtime.useModel !== "function") {
    throw new ElizaError(
      "Runtime has no model surface; cannot render the scheduled dispatch message.",
      {
        code: "SCHEDULED_DISPATCH_MODEL_UNAVAILABLE",
        context: { taskId: record.taskId, channelKey: record.channelKey },
        severity: "ephemeral",
      },
    );
  }
  const prompt = buildScheduledDispatchRenderPrompt(record);
  let response: unknown;
  try {
    response = await runWithTrajectoryPurpose("scheduled-dispatch-render", () =>
      runtime.useModel(ModelType.TEXT_LARGE, { prompt }),
    );
  } catch (error) {
    // error-policy:J2 context-adding rethrow
    throw new ElizaError("Scheduled dispatch message rendering failed.", {
      code: "SCHEDULED_DISPATCH_RENDER_FAILED",
      cause: error,
      context: { taskId: record.taskId, channelKey: record.channelKey },
      severity: "ephemeral",
    });
  }
  const text = typeof response === "string" ? response.trim() : "";
  if (text.length === 0) {
    throw new ElizaError(
      "Model returned empty output for the scheduled dispatch message.",
      {
        code: "SCHEDULED_DISPATCH_RENDER_EMPTY",
        context: { taskId: record.taskId, channelKey: record.channelKey },
        severity: "ephemeral",
      },
    );
  }
  return text;
}

/**
 * Translate a render failure into the typed, retryable dispatch failure the
 * runner's dispatch policy understands. Shared by every dispatcher so the
 * boundary behavior (retry same step after {@link RENDER_FAILURE_RETRY_MINUTES})
 * is uniform.
 */
export function renderFailureDispatchResult(error: unknown): DispatchResult {
  return {
    ok: false,
    reason: "transport_error",
    userActionable: false,
    retryAfterMinutes: RENDER_FAILURE_RETRY_MINUTES,
    message: `Scheduled dispatch render failed: ${
      error instanceof Error ? error.message : String(error)
    }`,
  };
}
