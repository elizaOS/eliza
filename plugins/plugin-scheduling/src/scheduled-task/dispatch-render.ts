/**
 * Model-mediated rendering for scheduled-task dispatches. A task's
 * `promptInstructions` is instruction-voice model input ("Remind the owner to
 * take their medication and ask how they slept"), never user-facing copy —
 * hosts author it explicitly as a model prompt (see PA's
 * `default-packs/persona-packs.ts`). Every dispatcher that emits to a
 * user-visible surface (assistant stream, notification body/title, connector
 * channel send) must render through the model first so the owner receives the
 * model's composed copy, not instruction text or a generic system label.
 * Consumers: the spine's default notification dispatcher (`runner-service.ts`)
 * and PA's production dispatcher (`plugin-personal-assistant` runtime-wiring).
 *
 * Model-free fallback (#14874): a runtime without a working model surface
 * receives deterministic composed copy — not a retryable failure — so stock
 * mobile boots keep their scheduled notifications. The fallback extracts the
 * first action-oriented sentence from `promptInstructions` and wraps it in
 * owner-facing voice, never quoting the instruction verbatim.
 *
 * Prompt templates are resolved through `resolveOptimizedPromptForRuntime`
 * with the `scheduled_task_dispatch` and `scheduled_task_title` task slots so
 * GEPA artifacts can tune each voice independently. An absent artifact is a
 * no-op (the inline baseline is returned).
 */

import {
  ElizaError,
  type IAgentRuntime,
  ModelType,
  resolveOptimizedPromptForRuntime,
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

/** Baseline prompt template for the dispatch body render task slot. */
const SCHEDULED_TASK_DISPATCH_BASELINE = [
  "You are the owner's personal assistant. A scheduled task just fired and you must now write the message to send to the owner.",
  "The instruction below tells you what to communicate. It is an instruction to you, not the message itself — never repeat or quote it verbatim.",
  "Write only the message body, speaking directly to the owner in a natural assistant voice.",
  "Do not mention scheduled tasks, instructions, or that this message was automated. No preamble, no markdown fences, no meta commentary.",
].join("\n");

/** Baseline prompt template for the dispatch title render task slot. */
const SCHEDULED_TASK_TITLE_BASELINE = [
  "You are the owner's personal assistant. Write a concise notification title for the scheduled message below.",
  "Write only the title. Do not mention scheduled tasks, automation, instructions, or reminders as system concepts.",
  "Use natural assistant voice and keep it under 8 words.",
].join("\n");

/**
 * Build a deterministic owner-facing message from the dispatch record when no
 * model is available. voice-policy:V1 — the fallback extracts the action
 * clause from the instruction (everything after the first verb-phrase lead)
 * and wraps it as a direct statement to the owner, never quoting the raw
 * instruction-voice verbatim.
 */
export function buildDeterministicDispatchBody(
  record: Pick<ScheduledTaskDispatchRecord, "promptInstructions" | "intensity">,
): string {
  const instruction = record.promptInstructions.trim();
  // Strip common instruction-voice prefixes ("Send a ...", "Remind the owner
  // to ...", "Check in with ...") to extract the action clause. This is
  // intentionally simple — the deterministic path is the lowest-quality
  // fallback, not a replacement for the model.
  const stripped = instruction
    .replace(/^(send|deliver|notify|remind|check in with|tell|ask|give|share)\s+(the owner\s+)?(to\s+)?/i, "")
    .replace(/^(a|an)\s+/i, "")
    .trim();
  const clause = stripped.length > 0 ? stripped : instruction;
  const prefix =
    record.intensity === "urgent"
      ? "Action needed: "
      : "";
  return `${prefix}${clause.charAt(0).toUpperCase()}${clause.slice(1)}`;
}

/**
 * Build a deterministic notification title from the dispatch record when no
 * model is available. voice-policy:V1 — falls back to a category literal
 * derived from intensity, never the raw instruction.
 */
export function buildDeterministicDispatchTitle(
  record: Pick<ScheduledTaskDispatchRecord, "intensity">,
): string {
  return record.intensity === "urgent" ? "Action needed" : "Update";
}

/**
 * Build the delivery prompt for one dispatch. Exported for direct unit testing
 * of prompt content. The instruction is embedded as opaque payload — nothing
 * here branches on its text. The framing template is resolved through the
 * `scheduled_task_dispatch` optimized-prompt task slot so GEPA artifacts can
 * tune the voice independently.
 */
export function buildScheduledDispatchRenderPrompt(
  runtime: IAgentRuntime,
  record: Pick<
    ScheduledTaskDispatchRecord,
    "promptInstructions" | "intensity" | "firedAtIso"
  >,
): string {
  const template = resolveOptimizedPromptForRuntime(
    runtime,
    "scheduled_task_dispatch",
    SCHEDULED_TASK_DISPATCH_BASELINE,
  );
  const lines: string[] = [template];
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
 * Build the notification-title prompt from the already-rendered body. The title
 * is a visible owner-facing surface too, so it must preserve the same assistant
 * voice instead of collapsing scheduled output to generic chrome such as
 * "Reminder" or "Approval needed". The framing template is resolved through
 * the `scheduled_task_title` optimized-prompt task slot.
 */
export function buildScheduledDispatchTitlePrompt(
  runtime: IAgentRuntime,
  record: Pick<ScheduledTaskDispatchRecord, "intensity" | "firedAtIso">,
  body: string,
): string {
  const template = resolveOptimizedPromptForRuntime(
    runtime,
    "scheduled_task_title",
    SCHEDULED_TASK_TITLE_BASELINE,
  );
  const lines: string[] = [template];
  if (record.intensity === "urgent") {
    lines.push("This is urgent: make the title direct and action-oriented.");
  } else if (record.intensity === "soft") {
    lines.push("Keep the title gentle.");
  }
  lines.push(
    "",
    "Message body:",
    body,
    "",
    `Fired at: ${record.firedAtIso}`,
    "",
    "Title:",
  );
  return lines.join("\n");
}

/**
 * Render the user-facing message for a dispatch through the runtime's model.
 * On a model-free runtime (no `useModel`) returns the deterministic fallback so
 * stock mobile boots keep their scheduled notifications. Throws `ElizaError`
 * (ephemeral) only when the model surface is present but the call fails or
 * returns blank — callers translate that into a typed dispatch failure.
 */
export async function renderScheduledDispatchMessage(
  runtime: IAgentRuntime,
  record: ScheduledTaskDispatchRecord,
): Promise<string> {
  if (typeof runtime.useModel !== "function") {
    // voice-policy:V1 — deterministic fallback preserves model-free hosts.
    return buildDeterministicDispatchBody(record);
  }
  const prompt = buildScheduledDispatchRenderPrompt(runtime, record);
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
 * Render the user-facing notification title for a dispatch through the model.
 * The body is rendered first by the caller so the title follows the final
 * owner-facing wording, not the task instruction payload. On a model-free
 * runtime returns the deterministic fallback.
 */
export async function renderScheduledDispatchTitle(
  runtime: IAgentRuntime,
  record: ScheduledTaskDispatchRecord,
  body: string,
): Promise<string> {
  if (typeof runtime.useModel !== "function") {
    // voice-policy:V1 — deterministic fallback preserves model-free hosts.
    return buildDeterministicDispatchTitle(record);
  }
  const prompt = buildScheduledDispatchTitlePrompt(runtime, record, body);
  let response: unknown;
  try {
    response = await runWithTrajectoryPurpose(
      "scheduled-dispatch-title-render",
      () => runtime.useModel(ModelType.TEXT_LARGE, { prompt }),
    );
  } catch (error) {
    // error-policy:J2 context-adding rethrow
    throw new ElizaError("Scheduled dispatch title rendering failed.", {
      code: "SCHEDULED_DISPATCH_TITLE_RENDER_FAILED",
      cause: error,
      context: { taskId: record.taskId, channelKey: record.channelKey },
      severity: "ephemeral",
    });
  }
  const text = typeof response === "string" ? response.trim() : "";
  if (text.length === 0) {
    throw new ElizaError(
      "Model returned empty output for the scheduled dispatch title.",
      {
        code: "SCHEDULED_DISPATCH_TITLE_RENDER_EMPTY",
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
