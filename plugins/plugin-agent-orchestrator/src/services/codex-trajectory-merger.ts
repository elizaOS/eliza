/**
 * Trajectory writer for Codex `codex exec` session captures.
 *
 * Sister to `codex-trajectory-reader.ts` — the reader is pure I/O and
 * normalization; this is the writer that lands the normalized steps onto
 * the runtime's trajectory store. CQRS, as per AGENTS.md commandment 6.
 *
 * Why two modules: the reader is trivially unit-testable against fixture
 * rollouts without spinning up a runtime; the writer needs a real (or
 * mocked) `IAgentRuntime` with a trajectory logger service attached.
 *
 * The merger:
 *   1. Creates one **child trajectory** row per Codex session, with
 *      `source: "codex-session"` and metadata pointing back at the parent
 *      step id. Keeps the schema flat — no nested trajectories.
 *   2. Records each normalized reasoning / text / tool-call step as either
 *      an LLM call (for reasoning + text + tool_call, which carry model +
 *      usage) or a plain annotated step (for tool_result rows, which
 *      don't).
 *   3. Annotates the **parent** step's `childSteps[]` with the child
 *      trajectory id so trajectory viewers can drill down.
 *   4. Surfaces the `captureQuality` flag so downstream training filters
 *      can downweight degraded captures.
 *
 * Privacy:
 *   Per AGENTS.md §A2 and the W1-T2 brief, the trajectory DB stores the
 *   user's own data on their own machine. Privacy filtering happens on the
 *   *export* path (training format step + HF publish), not at write time.
 *
 * @module services/codex-trajectory-merger
 */

import {
  annotateActiveTrajectoryStep,
  type IAgentRuntime,
  resolveTrajectoryLogger,
} from "@elizaos/core";
import type {
  CodexSessionReadResult,
  NormalizedCodexTrajectoryStep,
} from "./codex-trajectory-reader.js";

interface MergerLogger {
  warn?: (message: string) => void;
  debug?: (message: string) => void;
  info?: (message: string) => void;
}

const NOOP_LOGGER: MergerLogger = {};

/**
 * Capture quality contract (mirrors W1-T1 / session-log-merger). The parent
 * trajectory step carries this marker so downstream training pipelines know
 * whether the captured trajectory is full-fidelity (`ok`) or degraded — i.e.
 * we only have ANSI-stripped stdout and no structured reasoning / tool calls
 * / usage. Trainers that demand reasoning capture should skip degraded rows.
 */
export type CodexCaptureQualityMarker = "ok" | "degraded";

export interface CodexDegradedCaptureMarker {
  /** Always `"capture_quality"` — the discriminator field for readers. */
  marker: "capture_quality";
  /** Coarse quality bucket. */
  capture_quality: CodexCaptureQualityMarker;
  /** Sub-agent type — always `"codex"` from this helper. */
  subAgentType: "codex";
  /** Why the capture was downgraded. */
  reason:
    | "codex-rollout-missing"
    | "codex-rollout-empty"
    | "codex-rollout-error"
    | "codex-interactive-skipped"
    | "codex-no-home";
  /** Free-text detail for debugging — never user content. */
  detail?: string;
  /** Wall-clock ms when the marker was written. */
  recordedAt: number;
}

function buildDegradedScript(marker: CodexDegradedCaptureMarker): string {
  return JSON.stringify(marker, null, 0);
}

export interface TagParentTrajectoryWithDegradedCodexCaptureOptions {
  runtime: IAgentRuntime;
  parentStepId: string;
  reason: CodexDegradedCaptureMarker["reason"];
  detail?: string;
  logger?: MergerLogger;
}

/**
 * Annotate the parent trajectory step with a degraded-capture marker for
 * Codex-side captures. Used when we can't merge a full structured rollout
 * (no rollout file, empty rollout, reader error, interactive session that
 * we deliberately skipped). Returns true when the annotate landed, false
 * when no trajectory logger was available.
 */
export async function tagParentTrajectoryWithDegradedCodexCapture(
  options: TagParentTrajectoryWithDegradedCodexCaptureOptions,
): Promise<boolean> {
  const {
    runtime,
    parentStepId,
    reason,
    detail,
    logger = NOOP_LOGGER,
  } = options;
  const marker: CodexDegradedCaptureMarker = {
    marker: "capture_quality",
    capture_quality: "degraded",
    subAgentType: "codex",
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
      `[codex-trajectory-merger] could not tag parent ${parentStepId} as degraded; no trajectory logger`,
    );
  } else {
    logger.warn?.(
      `[codex-trajectory-merger] tagged parent ${parentStepId} capture_quality=degraded (reason=${reason})`,
    );
  }
  return landed;
}

export interface MergeCodexSessionIntoTrajectoryOptions {
  runtime: IAgentRuntime;
  parentStepId: string;
  capture: CodexSessionReadResult;
  /** PTY session id, surfaced as metadata for cross-referencing. */
  ptySessionId?: string;
  /** Working directory the captured session ran in. */
  workspaceDir?: string;
  /** Codex home (per-session temp dir) the session used. */
  codexHome?: string;
  logger?: MergerLogger;
}

export interface MergeCodexSessionResult {
  /** ID of the child trajectory row created for this session. */
  childTrajectoryId?: string;
  /** Number of normalized steps persisted. */
  stepsWritten: number;
  /** Capture quality propagated from the reader, recorded on metadata. */
  captureQuality: CodexSessionReadResult["captureQuality"];
  /** Why the merger skipped, if it did. */
  skippedReason?:
    | "no-steps"
    | "no-trajectory-logger"
    | "logger-missing-start"
    | "annotate-failed";
}

function buildChildTrajectoryId(parentStepId: string): string {
  // Salt with the timestamp so re-running the merger generates a fresh
  // child row rather than colliding with the previous one. The parent
  // step id stays the anchor.
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${parentStepId}-codex-${ts}-${rand}`;
}

function isLlmStep(step: NormalizedCodexTrajectoryStep): boolean {
  return (
    step.kind === "reasoning" ||
    step.kind === "text" ||
    step.kind === "tool_call"
  );
}

function buildLlmDetails(
  step: NormalizedCodexTrajectoryStep,
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
            args:
              step.toolInput ??
              (step.toolInputRaw ? { raw: step.toolInputRaw } : {}),
          },
        ]
      : undefined;

  return {
    provider: "openai",
    model: step.model,
    purpose: "subagent",
    actionType: `codex.${step.kind}`,
    response: responseParts.join("\n\n"),
    toolCalls,
    promptTokens: usage.input_tokens,
    completionTokens: usage.output_tokens,
    cacheReadInputTokens: usage.cached_input_tokens,
    // Codex emits reasoning tokens separately; surface as cache_creation so
    // the existing downstream rollups continue to work without a schema bump.
    cacheCreationInputTokens: usage.reasoning_output_tokens,
    tags: [
      "codex",
      `kind:${step.kind}`,
      ...(step.phase ? [`phase:${step.phase}`] : []),
      ...(step.reasoningEncrypted ? ["reasoning:encrypted"] : []),
      ...(step.toolCustom ? ["tool:custom"] : []),
    ],
  };
}

function buildToolResultScript(step: NormalizedCodexTrajectoryStep): string {
  // The trajectory step `script` field is the natural place to land tool
  // result payloads — already used elsewhere for action exec output. Cap is
  // enforced inside the storage layer; we hand the full string and let the
  // writer truncate with its structured marker.
  return JSON.stringify(
    {
      tool_use_id: step.toolUseId,
      tool_custom: step.toolCustom ?? false,
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
export async function mergeCodexSessionIntoTrajectory(
  options: MergeCodexSessionIntoTrajectoryOptions,
): Promise<MergeCodexSessionResult> {
  const {
    runtime,
    parentStepId,
    capture,
    ptySessionId,
    workspaceDir,
    codexHome,
    logger = NOOP_LOGGER,
  } = options;

  if (capture.steps.length === 0) {
    return {
      stepsWritten: 0,
      // No structured rows landed → degraded regardless of what the reader
      // reported (matches W1-T1 session-log-merger semantics).
      captureQuality: "degraded",
      skippedReason: "no-steps",
    };
  }

  const trajectoryLogger = resolveTrajectoryLogger(runtime);
  if (!trajectoryLogger) {
    logger.debug?.(
      `[codex-trajectory-merger] no trajectory logger registered; skipping merge for parent ${parentStepId}`,
    );
    return {
      stepsWritten: 0,
      captureQuality: "degraded",
      skippedReason: "no-trajectory-logger",
    };
  }
  if (typeof trajectoryLogger.startTrajectory !== "function") {
    return {
      stepsWritten: 0,
      captureQuality: "degraded",
      skippedReason: "logger-missing-start",
    };
  }

  const childTrajectoryId = buildChildTrajectoryId(parentStepId);
  const startOptions = {
    agentId: runtime.agentId,
    source: "codex-session",
    metadata: {
      parentTrajectoryStepId: parentStepId,
      subAgentType: "codex",
      ptySessionId,
      workspaceDir,
      codexHome,
      codexSessionId: capture.sessionId,
      rolloutPath: capture.rolloutPath,
      lastMessagePath: capture.lastMessagePath,
      totalUsage: capture.totalUsage,
      models: capture.models,
      finalMessage: capture.finalMessage,
      captureQuality: capture.captureQuality,
    },
  };
  await trajectoryLogger.startTrajectory(childTrajectoryId, startOptions);

  let stepsWritten = 0;
  for (const step of capture.steps) {
    if (isLlmStep(step) && typeof trajectoryLogger.logLlmCall === "function") {
      const details = buildLlmDetails(step);
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

  // Link the new child trajectory id back to the parent step. We don't care
  // whether the parent step is still the active one — the underlying
  // annotateStep targets by stepId.
  const linked = await annotateActiveTrajectoryStep(runtime, {
    stepId: parentStepId,
    appendChildSteps: [childTrajectoryId],
  });
  // Final quality = reader quality unless no rows actually landed. Rolling
  // the reader's `degraded` through preserves the synthetic-last-message
  // case (one fallback step) so downstream consumers can downweight it.
  const finalQuality: MergeCodexSessionResult["captureQuality"] =
    stepsWritten > 0 ? capture.captureQuality : "degraded";

  if (!linked) {
    logger.warn?.(
      `[codex-trajectory-merger] failed to append child ${childTrajectoryId} to parent ${parentStepId}`,
    );
    return {
      childTrajectoryId,
      stepsWritten,
      captureQuality: stepsWritten > 0 ? capture.captureQuality : "degraded",
      skippedReason: "annotate-failed",
    };
  }

  logger.info?.(
    `[codex-trajectory-merger] merged ${stepsWritten} Codex steps into child ${childTrajectoryId} (parent ${parentStepId}, quality=${finalQuality})`,
  );

  return {
    childTrajectoryId,
    stepsWritten,
    captureQuality: finalQuality,
  };
}
