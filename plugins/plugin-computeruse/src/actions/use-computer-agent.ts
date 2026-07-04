/**
 * WS7 — COMPUTER_USE_AGENT action.
 *
 * High-level "give me a goal, I'll click my way there" entry point. The
 * planner emits one of these instead of the lower-level COMPUTER_USE_CLICK
 * etc. when the right action isn't obvious from the prompt.
 *
 * Loop:
 *   1. refresh scene (`agent-turn`)
 *   2. capture per-display PNGs
 *   3. Brain → Cascade → ProposedAction
 *   4. dispatch into ComputerInterface
 *   5. observe (auto-screenshot via the existing service flow happens for
 *      ProposedAction.kind=click/etc; explicit captureAllDisplays after
 *      every step)
 *   6. repeat until `finish` or `maxSteps`
 *
 * Trajectory events are emitted as structured `logger.info` lines with a
 * `evt: "computeruse.agent.step"` payload, which the trajectory-logger app
 * picks up via standard log capture. When `streamProgress` is enabled, the
 * same step boundary also emits a `HandlerCallback` status to the origin chat.
 * We don't take a hard dependency on the trajectory-logger plugin from here.
 */

import {
  type Action,
  type ActionResult,
  type Content,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  logger,
  type Memory,
  type State,
} from "@elizaos/core";
import {
  type AgentMiddleware,
  createBudgetCapMiddleware,
  createImageRetentionMiddleware,
  createOperatorNormalizerMiddleware,
  createTrajectoryMiddleware,
  runAfterStep,
  runBeforeStep,
  runOnCaptures,
  runOnRunEnd,
  runOnRunStart,
  runTransformProposed,
  type TrajectoryEntry,
} from "../actor/agent-callbacks.js";
import {
  AGENT_LOOP_SETTING,
  type AgentLoop,
  type AgentLoopStats,
  createAgentLoop,
  DEFAULT_AGENT_LOOP_MODEL,
} from "../actor/agent-loop.js";
import type { Brain } from "../actor/brain.js";
import {
  type ComputerInterface,
  makeComputerInterface,
} from "../actor/computer-interface.js";
import { dispatch } from "../actor/dispatch.js";
import {
  captureAllDisplays,
  type DisplayCapture,
} from "../platform/capture.js";
import { listDisplays } from "../platform/displays.js";
import type { Scene } from "../scene/scene-types.js";
import type { ComputerUseService } from "../services/computer-use-service.js";
import { resolveActionParams } from "./helpers.js";
import {
  buildStepProgressContent,
  isStreamProgressEnabled,
} from "./progress.js";

const DEFAULT_MAX_STEPS = 5;

export interface ComputerUseAgentParams {
  goal: string;
  maxSteps?: number;
  /**
   * When true, emit a chat message after each dispatched step so a long-running
   * goal does not leave the origin chat silent for minutes (#8912). The action
   * handler wires this to the runtime HandlerCallback; the loop itself calls
   * per-step progress hooks.
   */
  streamProgress?: boolean;
  /** Wall-clock budget (ms) — the loop aborts before a step that exceeds it. */
  maxDurationMs?: number;
  /**
   * Image-retention window (#9170 M11): keep only the N most-recent steps'
   * screenshots in the bounded history. Off (unbounded) when unset.
   */
  imageRetentionLast?: number;
}

/** One per-step progress event, surfaced when `streamProgress` is set. */
export interface ComputerUseAgentStepProgress {
  goal: string;
  step: number;
  maxSteps: number;
  sceneSummary: string;
  actionKind: string;
  rationale: string;
  rois: number;
  result: { success: boolean; error?: string };
}

interface AgentDeps {
  brain?: Brain;
  /** Pre-built loop override (tests). Supersedes model-string selection. */
  loop?: AgentLoop;
  /** Loop model-string override (tests / explicit selection). */
  loopModel?: string;
  /**
   * Callback middleware override (#9170 M11). When set, replaces the default
   * pipeline (operator-normalizer + trajectory, plus budget/image-retention
   * when configured via params).
   */
  middleware?: AgentMiddleware[];
  /** Clock override (tests) — defaults to `Date.now`. */
  now?: () => number;
  computerInterface?: ComputerInterface;
  captureAll?: () => Promise<DisplayCapture[]>;
  /** Called after each dispatched step when `params.streamProgress` is set. */
  onStepProgress?: (
    progress: ComputerUseAgentStepProgress,
  ) => Promise<void> | void;
  /** Called with compact Content after each dispatched step when enabled. */
  onCompactStepProgress?: (content: Content) => Promise<void> | void;
}

export interface ComputerUseAgentReport {
  goal: string;
  steps: Array<{
    step: number;
    sceneSummary: string;
    actionKind: string;
    rationale: string;
    rois: number;
    result: { success: boolean; error?: string };
  }>;
  finished: boolean;
  reason: "finish" | "max_steps" | "error" | "budget";
  error?: string;
  /** Per-step transcript recorded by the trajectory middleware (#9170 M11). */
  trajectory?: TrajectoryEntry[];
  /** Per-run model-call accounting, when the loop reports it (#9105). */
  modelStats?: AgentLoopStats;
}

export function formatComputerUseAgentProgress(
  progress: ComputerUseAgentStepProgress,
): string {
  const rationale = truncateForStatus(progress.rationale || "no rationale");
  const failure = progress.result.success
    ? ""
    : ` (failed: ${truncateForStatus(progress.result.error ?? "unknown")})`;
  return `Step ${progress.step}/${progress.maxSteps}: ${progress.actionKind} - ${rationale}${failure}`;
}

function getService(runtime: IAgentRuntime): ComputerUseService | null {
  return (runtime.getService("computeruse") as ComputerUseService) ?? null;
}

/** Read the configured agent-loop model string (setting → env → null). */
function resolveLoopModel(runtime: IAgentRuntime | null): string | null {
  const fromSetting = runtime?.getSetting?.(AGENT_LOOP_SETTING);
  if (typeof fromSetting === "string" && fromSetting.trim().length > 0) {
    return fromSetting.trim();
  }
  const fromEnv = process.env[AGENT_LOOP_SETTING];
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) {
    return fromEnv.trim();
  }
  return null;
}

/**
 * Run one Brain/Cascade/Dispatch loop. Exported so tests can drive it
 * without exercising the full Action plumbing.
 */
export async function runComputerUseAgentLoop(
  runtime: IAgentRuntime | null,
  params: ComputerUseAgentParams,
  service: ComputerUseService,
  deps: AgentDeps = {},
): Promise<ComputerUseAgentReport> {
  const maxSteps = Math.max(
    1,
    Math.min(params.maxSteps ?? DEFAULT_MAX_STEPS, 20),
  );
  const goal = params.goal;
  // Agent-loop registry (#9170 M10): a model string selects the loop. Defaults
  // to the local OCR/AX grounder (Brain → Cascade); provider plugins can
  // register Anthropic / OpenAI computer-use loops keyed by model family.
  const loopModel =
    deps.loopModel ?? resolveLoopModel(runtime) ?? DEFAULT_AGENT_LOOP_MODEL;
  const loop =
    deps.loop ??
    createAgentLoop(loopModel, {
      runtime,
      getScene: () => service.getCurrentScene(),
      brain: deps.brain,
    });
  const computer =
    deps.computerInterface ??
    makeComputerInterface({ getScene: () => service.getCurrentScene() });
  const captureAll = deps.captureAll ?? captureAllDisplays;
  const now = deps.now ?? Date.now;
  const runStart = now();

  // Callback middleware pipeline (#9170 M11). Default = operator-normalizer
  // (clean the planned action) + trajectory (in-memory transcript), plus
  // budget-cap / image-retention when configured via params.
  const trajectoryMw = createTrajectoryMiddleware();
  const middlewares: AgentMiddleware[] =
    deps.middleware ??
    (() => {
      const list: AgentMiddleware[] = [createOperatorNormalizerMiddleware()];
      if (params.maxDurationMs !== undefined) {
        list.unshift(
          createBudgetCapMiddleware({ maxDurationMs: params.maxDurationMs }),
        );
      }
      if (params.imageRetentionLast !== undefined) {
        list.push(
          createImageRetentionMiddleware({
            keepLast: params.imageRetentionLast,
          }),
        );
      }
      list.push(trajectoryMw);
      return list;
    })();

  const report: ComputerUseAgentReport = {
    goal,
    steps: [],
    finished: false,
    reason: "max_steps",
  };

  const finalize = async (): Promise<ComputerUseAgentReport> => {
    if (!deps.middleware) report.trajectory = trajectoryMw.entries();
    const stats = loop.getStats?.();
    if (stats) {
      report.modelStats = stats;
      logger.info(
        {
          evt: "computeruse.agent.tokens",
          goal,
          loop: loop.name,
          invocations: stats.invocations,
          cacheHits: stats.cacheHits,
          imagelessCalls: stats.imagelessCalls,
          estImageTokensSaved: stats.estImageTokensSaved,
          steps: report.steps.length,
        },
        `[computeruse/agent] ${stats.invocations} model call(s), ${stats.cacheHits} cache hit(s), ${stats.imagelessCalls} imageless (~${stats.estImageTokensSaved} image tokens saved) over ${report.steps.length} step(s)`,
      );
    }
    await runOnRunEnd(middlewares, {
      goal,
      steps: report.steps.length,
      finished: report.finished,
      reason: report.reason,
    });
    return report;
  };

  await runOnRunStart(middlewares, { goal, maxSteps });

  for (let step = 1; step <= maxSteps; step += 1) {
    const stepCtx = { step, maxSteps, goal, elapsedMs: now() - runStart };
    const decision = await runBeforeStep(middlewares, stepCtx);
    if (decision.abort) {
      report.reason = "budget";
      report.error = decision.reason;
      return finalize();
    }
    let scene: Scene;
    try {
      scene = await service.refreshScene("agent-turn");
    } catch (err) {
      // error-policy:J1 loop boundary — the failure ends the run as a
      // structured report (reason="error" + error) the model sees via the
      // action result; never rethrown into the action plumbing half-run.
      report.reason = "error";
      report.error = `scene refresh failed: ${errorMessage(err)}`;
      return finalize();
    }
    const captures = await safeCapture(captureAll);
    if (captures.size === 0) {
      report.reason = "error";
      report.error = "no displays captured";
      return finalize();
    }
    await runOnCaptures(middlewares, captures, stepCtx);
    let proposed: Awaited<ReturnType<typeof loop.predictStep>>;
    try {
      proposed = await loop.predictStep({ scene, goal, captures });
    } catch (err) {
      // error-policy:J1 loop boundary — planner failure ends the run as a
      // structured report (reason="error" + error); the model sees it in the
      // action result instead of a fabricated partial success.
      report.reason = "error";
      report.error = `agent loop "${loop.name}" failed: ${errorMessage(err)}`;
      return finalize();
    }
    // Operator-normalizer + any other transform middleware clean the planned
    // action before it is dispatched.
    proposed = await runTransformProposed(middlewares, proposed, stepCtx);
    // Persist the Brain's understanding onto the scene (#9105 M3) so the next
    // turn's `scene` provider carries `vlm_scene` instead of re-describing.
    service.setSceneVlmAnnotations(proposed.scene_summary, null);
    const dispatchResult = await dispatch(proposed.proposed, {
      interface: computer,
      listDisplays: () => service.getDisplays(),
    });
    await runAfterStep(middlewares, {
      step,
      goal,
      proposed,
      dispatchSuccess: dispatchResult.success,
      error: dispatchResult.error?.message,
    });
    logger.info(
      {
        evt: "computeruse.agent.step",
        step,
        goal,
        actionKind: proposed.proposed.kind,
        displayId: proposed.proposed.displayId,
        rois: proposed.rois.length,
        success: dispatchResult.success,
        error: dispatchResult.error?.code,
        rationale: proposed.proposed.rationale,
      },
      `[computeruse/agent] step ${step}: ${proposed.proposed.kind}`,
    );
    const reportStep = {
      step,
      sceneSummary: proposed.scene_summary,
      actionKind: proposed.proposed.kind,
      rationale: proposed.proposed.rationale,
      rois: proposed.rois.length,
      result: {
        success: dispatchResult.success,
        error: dispatchResult.error?.message,
      },
    };
    report.steps.push(reportStep);
    if (isStreamProgressEnabled(params.streamProgress)) {
      const progress: ComputerUseAgentStepProgress = {
        goal,
        maxSteps,
        ...reportStep,
      };
      await emitStepProgress(runtime, deps.onStepProgress, progress);
      await emitCompactStepProgress(
        runtime,
        deps.onCompactStepProgress,
        progress,
      );
    }
    if (!dispatchResult.success) {
      report.reason = "error";
      report.error = dispatchResult.error?.message;
      return finalize();
    }
    if (proposed.proposed.kind === "finish") {
      report.finished = true;
      report.reason = "finish";
      return finalize();
    }
    if (proposed.proposed.kind === "wait") {
    }
  }
  return finalize();
}

async function emitStepProgress(
  runtime: IAgentRuntime | null,
  onStepProgress: AgentDeps["onStepProgress"],
  progress: ComputerUseAgentStepProgress,
): Promise<void> {
  if (!onStepProgress) {
    return;
  }
  try {
    await onStepProgress(progress);
  } catch (err) {
    // error-policy:J7 progress relay is telemetry; it must not kill the run,
    // but the failure is warned AND reported so a broken progress channel is
    // agent/owner-visible, not silent.
    logger.warn(
      {
        evt: "computeruse.agent.progress_callback_failed",
        step: progress.step,
        goal: progress.goal,
        error: errorMessage(err),
      },
      "[computeruse/agent] progress callback failed",
    );
    runtime?.reportError("Computeruse.agentProgress", err, {
      step: progress.step,
      goal: progress.goal,
      channel: "onStepProgress",
    });
  }
}

async function emitCompactStepProgress(
  runtime: IAgentRuntime | null,
  onCompactStepProgress: AgentDeps["onCompactStepProgress"],
  progress: ComputerUseAgentStepProgress,
): Promise<void> {
  if (!onCompactStepProgress) {
    return;
  }
  try {
    await onCompactStepProgress(
      buildStepProgressContent({
        actionName: "COMPUTER_USE_AGENT",
        step: progress.step,
        kind: progress.actionKind,
        rationale: progress.rationale,
        success: progress.result.success,
        error: progress.result.error,
      }),
    );
  } catch (err) {
    // error-policy:J7 compact progress relay is telemetry; it must not kill
    // the run, but the failure is warned AND reported so a broken progress
    // channel is agent/owner-visible, not silent.
    logger.warn(
      {
        evt: "computeruse.agent.compact_progress_callback_failed",
        step: progress.step,
        goal: progress.goal,
        error: errorMessage(err),
      },
      "[computeruse/agent] compact progress callback failed",
    );
    runtime?.reportError("Computeruse.agentProgress", err, {
      step: progress.step,
      goal: progress.goal,
      channel: "onCompactStepProgress",
    });
  }
}

async function safeCapture(
  captureAll: () => Promise<DisplayCapture[]>,
): Promise<Map<number, DisplayCapture>> {
  const out = new Map<number, DisplayCapture>();
  try {
    const caps = await captureAll();
    for (const c of caps) out.set(c.display.id, c);
  } catch (err) {
    // error-policy:J4 the empty map is the explicit failure signal — the run
    // loop aborts with reason="error" ("no displays captured"), so capture
    // failure surfaces in the action result rather than reading as a blank
    // desktop.
    logger.warn(
      `[computeruse/agent] captureAll failed: ${errorMessage(err)} — falling back to per-display lookup`,
    );
    // listDisplays() is sync; we don't iterate here because the per-display
    // capture would also have failed. The empty map signals the caller.
    void listDisplays();
  }
  return out;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function truncateForStatus(value: string, maxLength = 180): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) {
    return compact;
  }
  return `${compact.slice(0, maxLength - 3)}...`;
}

export const computerUseAgentAction: Action = {
  name: "COMPUTER_USE_AGENT",
  contexts: ["automation", "admin"],
  contextGate: { anyOf: ["automation", "admin"] },
  roleGate: { minRole: "OWNER" },
  similes: ["AUTOMATE_SCREEN", "RUN_COMPUTER_AGENT", "SCREEN_AGENT"],
  description:
    "computer_use_agent: autonomous desktop loop for a goal until done or maxSteps. Uses WS6 scene-builder, WS7 Brain+Actor cascade, WS5 multi-monitor coords. Prefer COMPUTER_USE for named single steps; use COMPUTER_USE_AGENT for goal-level screen tasks. Set streamProgress=true to send per-step progress updates to the originating chat.",
  descriptionCompressed:
    "Autonomous desktop loop: scene -> Brain -> cascade -> click. Pass {goal, maxSteps?, streamProgress?}.",
  routingHint:
    "free-form 'do X on screen' goal -> COMPUTER_USE_AGENT; single explicit step -> COMPUTER_USE",
  parameters: [
    {
      name: "goal",
      description: "Natural-language goal, e.g. click save button in dialog.",
      required: true,
      schema: { type: "string" },
    },
    {
      name: "maxSteps",
      description: "Max Brain->dispatch cycles before giving up. Default 5.",
      required: false,
      schema: {
        type: "number",
        minimum: 1,
        maximum: 20,
        default: DEFAULT_MAX_STEPS,
      },
    },
    {
      name: "streamProgress",
      description:
        "When true, emit a chat callback after each dispatched step with compact progress and the step kind/rationale.",
      required: false,
      schema: { type: "boolean", default: false },
    },
    {
      name: "maxDurationMs",
      description:
        "Wall-clock budget in ms; the loop aborts before a step that exceeds it.",
      required: false,
      schema: { type: "number", minimum: 0 },
    },
    {
      name: "imageRetentionLast",
      description:
        "Keep only the N most-recent steps' screenshots in the bounded history (token control).",
      required: false,
      schema: { type: "number", minimum: 1 },
    },
  ],
  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    return getService(runtime) !== null;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const params = resolveActionParams<ComputerUseAgentParams>(
      message,
      options,
    );
    if (!params.goal || typeof params.goal !== "string") {
      return {
        success: false,
        error: "COMPUTER_USE_AGENT requires a goal string",
      };
    }
    const service = getService(runtime);
    if (!service) {
      return {
        success: false,
        error: "ComputerUseService not available",
      };
    }
    const report = await runComputerUseAgentLoop(runtime, params, service, {
      onCompactStepProgress: callback
        ? async (content) => {
            await callback(content, "COMPUTER_USE_AGENT");
          }
        : undefined,
    });
    const text =
      report.reason === "finish"
        ? `Computer-use agent finished after ${report.steps.length} step(s): goal="${report.goal}"`
        : report.reason === "max_steps"
          ? `Computer-use agent hit max steps (${report.steps.length})`
          : report.reason === "budget"
            ? `Computer-use agent stopped on budget after ${report.steps.length} step(s): ${report.error ?? "budget exhausted"}`
            : `Computer-use agent failed: ${report.error ?? "unknown"}`;
    if (callback) {
      await callback({ text });
    }
    return {
      success: report.reason === "finish",
      // A non-finish run carries result.error so the planner loop shows the
      // failure to the model (#12273) instead of a success-shaped text blob.
      error: report.reason === "finish" ? undefined : (report.error ?? text),
      text,
      data: {
        source: "computeruse",
        computerUseAction: "COMPUTER_USE_AGENT",
        report,
      },
    };
  },
  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "Click the save button in the dialog",
          source: "chat",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Running the screen agent loop.",
          actions: ["COMPUTER_USE_AGENT"],
          thought:
            "Goal is described in free-form ('click the save button'); the agent loop will refresh the scene, reason over the captured frame, and dispatch a click on the matched OCR/AX target.",
        },
      },
    ],
  ],
};
