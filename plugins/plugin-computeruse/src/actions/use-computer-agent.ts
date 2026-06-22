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
import { Brain } from "../actor/brain.js";
import { Cascade } from "../actor/cascade.js";
import {
  type ComputerInterface,
  makeComputerInterface,
} from "../actor/computer-interface.js";
import { dispatch } from "../actor/dispatch.js";
import {
  getRegisteredActor,
  OcrCoordinateGroundingActor,
} from "../actor/index.js";
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
  reason: "finish" | "max_steps" | "error";
  error?: string;
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
  const brain = deps.brain ?? new Brain(runtime);
  const actor =
    getRegisteredActor() ??
    new OcrCoordinateGroundingActor(() => service.getCurrentScene());
  const computer =
    deps.computerInterface ??
    makeComputerInterface({ getScene: () => service.getCurrentScene() });
  const cascade = new Cascade({ brain, actor });
  const captureAll = deps.captureAll ?? captureAllDisplays;

  const report: ComputerUseAgentReport = {
    goal,
    steps: [],
    finished: false,
    reason: "max_steps",
  };

  for (let step = 1; step <= maxSteps; step += 1) {
    let scene: Scene;
    try {
      scene = await service.refreshScene("agent-turn");
    } catch (err) {
      report.reason = "error";
      report.error = `scene refresh failed: ${errorMessage(err)}`;
      return report;
    }
    const captures = await safeCapture(captureAll);
    if (captures.size === 0) {
      report.reason = "error";
      report.error = "no displays captured";
      return report;
    }
    let proposed: Awaited<ReturnType<typeof cascade.run>>;
    try {
      proposed = await cascade.run({ scene, goal, captures });
    } catch (err) {
      report.reason = "error";
      report.error = `cascade failed: ${errorMessage(err)}`;
      return report;
    }
    const dispatchResult = await dispatch(proposed.proposed, {
      interface: computer,
      listDisplays: () => service.getDisplays(),
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
      await emitStepProgress(deps.onStepProgress, progress);
      await emitCompactStepProgress(deps.onCompactStepProgress, progress);
    }
    if (!dispatchResult.success) {
      report.reason = "error";
      report.error = dispatchResult.error?.message;
      return report;
    }
    if (proposed.proposed.kind === "finish") {
      report.finished = true;
      report.reason = "finish";
      return report;
    }
    if (proposed.proposed.kind === "wait") {
    }
  }
  return report;
}

async function emitStepProgress(
  onStepProgress: AgentDeps["onStepProgress"],
  progress: ComputerUseAgentStepProgress,
): Promise<void> {
  if (!onStepProgress) {
    return;
  }
  try {
    await onStepProgress(progress);
  } catch (err) {
    logger.warn(
      {
        evt: "computeruse.agent.progress_callback_failed",
        step: progress.step,
        goal: progress.goal,
        error: errorMessage(err),
      },
      "[computeruse/agent] progress callback failed",
    );
  }
}

async function emitCompactStepProgress(
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
    logger.warn(
      {
        evt: "computeruse.agent.compact_progress_callback_failed",
        step: progress.step,
        goal: progress.goal,
        error: errorMessage(err),
      },
      "[computeruse/agent] compact progress callback failed",
    );
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
          : `Computer-use agent failed: ${report.error ?? "unknown"}`;
    if (callback) {
      await callback({ text });
    }
    return {
      success: report.reason === "finish",
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
