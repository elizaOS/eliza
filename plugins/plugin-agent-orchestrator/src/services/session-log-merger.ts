/**
 * Trajectory writer for Claude Code session captures.
 *
 * Sister module to `session-log-reader.ts` — the reader is pure I/O and
 * normalization; this is the writer that lands the normalized steps onto
 * the runtime's trajectory store. CQRS, as per AGENTS.md commandment 6.
 *
 * Why two modules: the reader is trivially unit-testable against fixture
 * files without spinning up a runtime; the writer needs a real (or mocked)
 * `IAgentRuntime` with a trajectory logger service attached.
 *
 * The merger:
 *   1. Creates one **child trajectory** row per Claude Code session, with
 *      `source: "claude-code-session"` and metadata pointing back at the
 *      parent step id. This keeps the schema flat — no nested trajectories.
 *   2. Records each normalized reasoning / text / tool-call step as either
 *      an LLM call (for reasoning + text + tool_call, which carry model +
 *      usage) or a plain script step (for tool_result rows, which don't).
 *   3. Annotates the **parent** step's `childSteps[]` with the child
 *      trajectory id so trajectory viewers can drill down.
 *
 * Privacy:
 *   Per AGENTS.md §A2 and the W1-T1 brief, the trajectory DB stores the
 *   user's own data on their own machine. Privacy filtering happens on the
 *   *export* path (training format step + HF publish), not at write time.
 *
 * @module services/session-log-merger
 */

import {
  annotateActiveTrajectoryStep,
  type IAgentRuntime,
  resolveTrajectoryLogger,
} from "@elizaos/core";
import type {
  NormalizedTrajectoryStep,
  SessionLogReadResult,
} from "./session-log-reader.js";

interface MergerLogger {
  warn?: (message: string) => void;
  debug?: (message: string) => void;
  info?: (message: string) => void;
}

const NOOP_LOGGER: MergerLogger = {};

/**
 * Capture quality contract (per W1-T1 brief §7). The parent trajectory step
 * carries this marker so downstream training pipelines know whether the
 * captured trajectory is full-fidelity (`ok`) or degraded — i.e. we only
 * have ANSI-stripped stdout and no structured reasoning / tool calls /
 * usage. Trainers that demand reasoning capture should skip degraded rows.
 */
export type CaptureQuality = "ok" | "degraded";

export interface DegradedCaptureMarker {
  /** Always `"capture_quality"` — the discriminator field for readers. */
  marker: "capture_quality";
  /** Coarse quality bucket. */
  capture_quality: CaptureQuality;
  /** Sub-agent type (`"claude"`, etc.) for filtering. */
  subAgentType: string;
  /** Why the capture was downgraded. */
  reason: "session-log-missing" | "session-log-empty" | "session-log-error";
  /** Free-text detail for debugging — never user content. */
  detail?: string;
  /** Wall-clock ms when the marker was written. */
  recordedAt: number;
}

function buildDegradedScript(marker: DegradedCaptureMarker): string {
  return JSON.stringify(marker, null, 0);
}

export interface TagParentTrajectoryWithDegradedCaptureOptions {
  runtime: IAgentRuntime;
  parentStepId: string;
  subAgentType: string;
  reason: DegradedCaptureMarker["reason"];
  detail?: string;
  logger?: MergerLogger;
}

/**
 * Annotate the parent trajectory step with a degraded-capture marker. Used
 * when we can't merge a full structured session log (no log file, empty
 * file, or reader error). Returns true when the annotate landed, false
 * when no trajectory logger was available.
 */
export async function tagParentTrajectoryWithDegradedCapture(
  options: TagParentTrajectoryWithDegradedCaptureOptions,
): Promise<boolean> {
  const {
    runtime,
    parentStepId,
    subAgentType,
    reason,
    detail,
    logger = NOOP_LOGGER,
  } = options;
  const marker: DegradedCaptureMarker = {
    marker: "capture_quality",
    capture_quality: "degraded",
    subAgentType,
    reason,
    detail,
    recordedAt: Date.now(),
  };
  const landed = await annotateActiveTrajectoryStep(runtime, {
    stepId: parentStepId,
    script: buildDegradedScript(marker),
  });
  if (!landed) {
    logger.debug?.(
      `[session-log-merger] could not tag parent ${parentStepId} as degraded; no trajectory logger`,
    );
  } else {
    logger.warn?.(
      `[session-log-merger] tagged parent ${parentStepId} capture_quality=degraded (reason=${reason})`,
    );
  }
  return landed;
}

export interface MergeSessionLogIntoTrajectoryOptions {
  runtime: IAgentRuntime;
  parentStepId: string;
  capture: SessionLogReadResult;
  /** PTY session id, surfaced as metadata for cross-referencing. */
  ptySessionId?: string;
  /** Coding-agent type (`"claude"`); included on metadata for clarity. */
  agentType?: string;
  /** Working directory the captured session ran in. */
  workspaceDir?: string;
  logger?: MergerLogger;
}

export interface MergeSessionLogResult {
  /** ID of the child trajectory row created for this session. */
  childTrajectoryId?: string;
  /** Number of normalized steps persisted. */
  stepsWritten: number;
  /** Why the merger skipped, if it did. */
  skippedReason?:
    | "no-steps"
    | "no-trajectory-logger"
    | "logger-missing-start"
    | "annotate-failed";
  /**
   * Capture quality of this merge. `"ok"` when we landed at least one
   * structured step; `"degraded"` when we couldn't land any (no log file,
   * empty transcript, no trajectory logger to write to). Surfaced for the
   * pty-service hook so it can tag the parent step.
   */
  captureQuality: CaptureQuality;
}

function buildChildTrajectoryId(parentStepId: string): string {
  // Salt with the timestamp so re-running the merger generates a fresh
  // child row rather than colliding with the previous one. The parent
  // step id stays the anchor.
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${parentStepId}-cc-${ts}-${rand}`;
}

function isLlmStep(step: NormalizedTrajectoryStep): boolean {
  return (
    step.kind === "reasoning" ||
    step.kind === "text" ||
    step.kind === "tool_call"
  );
}

function buildLlmDetails(
  step: NormalizedTrajectoryStep,
): Record<string, unknown> {
  const usage = step.usage ?? {};
  const responseParts: string[] = [];
  if (step.reasoning) responseParts.push(step.reasoning);
  if (step.text) responseParts.push(step.text);
  const toolCalls =
    step.kind === "tool_call" && step.toolName
      ? [
          {
            id: step.toolUseId,
            name: step.toolName,
            args: step.toolInput ?? {},
          },
        ]
      : undefined;

  return {
    provider: "anthropic",
    model: step.model,
    purpose: "subagent",
    actionType: `claude-code.${step.kind}`,
    response: responseParts.join("\n\n"),
    toolCalls,
    promptTokens: usage.input_tokens,
    completionTokens: usage.output_tokens,
    cacheReadInputTokens: usage.cache_read_input_tokens,
    cacheCreationInputTokens: usage.cache_creation_input_tokens,
    tags: ["claude-code", `kind:${step.kind}`],
  };
}

function buildToolResultScript(step: NormalizedTrajectoryStep): string {
  // The trajectory step `script` field is the natural place to land tool
  // result payloads — it's already used elsewhere for action exec output.
  // Cap is enforced inside the storage layer; we hand the full string
  // here and let the writer truncate with its structured marker.
  return JSON.stringify(
    {
      tool_use_id: step.toolUseId,
      is_error: step.toolError ?? false,
      content: step.toolResult ?? "",
    },
    null,
    0,
  );
}

/**
 * Persist the normalized capture as a child trajectory and link it to the
 * parent step. Returns the child trajectory id on success.
 *
 * Safe to call when the runtime has no trajectory logger registered (slim
 * installs / tests without DB): the merger logs and returns
 * `skippedReason: "no-trajectory-logger"`.
 */
export async function mergeSessionLogIntoTrajectory(
  options: MergeSessionLogIntoTrajectoryOptions,
): Promise<MergeSessionLogResult> {
  const {
    runtime,
    parentStepId,
    capture,
    ptySessionId,
    agentType = "claude",
    workspaceDir,
    logger = NOOP_LOGGER,
  } = options;

  if (capture.steps.length === 0) {
    return {
      stepsWritten: 0,
      skippedReason: "no-steps",
      captureQuality: "degraded",
    };
  }

  const trajectoryLogger = resolveTrajectoryLogger(runtime);
  if (!trajectoryLogger) {
    logger.debug?.(
      `[session-log-merger] no trajectory logger registered; skipping merge for parent ${parentStepId}`,
    );
    return {
      stepsWritten: 0,
      skippedReason: "no-trajectory-logger",
      captureQuality: "degraded",
    };
  }
  if (typeof trajectoryLogger.startTrajectory !== "function") {
    return {
      stepsWritten: 0,
      skippedReason: "logger-missing-start",
      captureQuality: "degraded",
    };
  }

  const childTrajectoryId = buildChildTrajectoryId(parentStepId);
  const startOptions = {
    agentId: runtime.agentId,
    source: "claude-code-session",
    metadata: {
      parentTrajectoryStepId: parentStepId,
      subAgentType: agentType,
      ptySessionId,
      workspaceDir,
      claudeCodeSessionId: capture.sessionId,
      sourcePath: capture.sourcePath,
      totalUsage: capture.totalUsage,
      models: capture.models,
    },
  };
  await trajectoryLogger.startTrajectory(childTrajectoryId, startOptions);

  let stepsWritten = 0;
  for (const step of capture.steps) {
    if (isLlmStep(step) && typeof trajectoryLogger.logLlmCall === "function") {
      const details = buildLlmDetails(step);
      // The logger casts its `details` parameter shape internally; we hand
      // the well-known fields and trust the schema-derived consumer.
      trajectoryLogger.logLlmCall({
        stepId: step.stepId,
        ...details,
      } as Parameters<NonNullable<typeof trajectoryLogger.logLlmCall>>[0]);
      stepsWritten += 1;
      continue;
    }

    if (
      step.kind === "tool_result" &&
      typeof trajectoryLogger.annotateStep === "function"
    ) {
      await trajectoryLogger.annotateStep({
        stepId: step.stepId,
        kind: "action",
        script: buildToolResultScript(step),
      });
      stepsWritten += 1;
    }
  }

  if (typeof trajectoryLogger.endTrajectory === "function") {
    await trajectoryLogger.endTrajectory(childTrajectoryId, "completed");
  }

  // Link the new child trajectory id back to the parent step. We don't
  // care if the parent step is no longer the active one — the underlying
  // annotateStep targets by stepId.
  const linked = await annotateActiveTrajectoryStep(runtime, {
    stepId: parentStepId,
    appendChildSteps: [childTrajectoryId],
  });
  if (!linked) {
    logger.warn?.(
      `[session-log-merger] failed to append child ${childTrajectoryId} to parent ${parentStepId}`,
    );
    return {
      childTrajectoryId,
      stepsWritten,
      skippedReason: "annotate-failed",
      captureQuality: stepsWritten > 0 ? "ok" : "degraded",
    };
  }

  logger.info?.(
    `[session-log-merger] merged ${stepsWritten} Claude Code steps into child ${childTrajectoryId} (parent ${parentStepId})`,
  );

  return {
    childTrajectoryId,
    stepsWritten,
    captureQuality: stepsWritten > 0 ? "ok" : "degraded",
  };
}
