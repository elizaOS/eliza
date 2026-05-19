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
 * picks up via standard log capture. We don't take a hard dependency on the
 * trajectory-logger plugin from here.
 */

import {
  type Action,
  type ActionResult,
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

const DEFAULT_MAX_STEPS = 5;

export interface ComputerUseAgentParams {
  goal: string;
  maxSteps?: number;
}

interface AgentDeps {
  brain?: Brain;
  computerInterface?: ComputerInterface;
  captureAll?: () => Promise<DisplayCapture[]>;
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
    report.steps.push({
      step,
      sceneSummary: proposed.scene_summary,
      actionKind: proposed.proposed.kind,
      rationale: proposed.proposed.rationale,
      rois: proposed.rois.length,
      result: {
        success: dispatchResult.success,
        error: dispatchResult.error?.message,
      },
    });
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

export const computerUseAgentAction: Action = {
  name: "COMPUTER_USE_AGENT",
  contexts: ["automation", "admin"],
  contextGate: { anyOf: ["automation", "admin"] },
  roleGate: { minRole: "OWNER" },
  similes: ["AUTOMATE_SCREEN", "RUN_COMPUTER_AGENT", "SCREEN_AGENT"],
  description:
    "computer_use_agent: autonomous desktop loop for a goal until done or maxSteps. Uses WS6 scene-builder, WS7 Brain+Actor cascade, WS5 multi-monitor coords. Prefer COMPUTER_USE for named single steps; use COMPUTER_USE_AGENT for goal-level screen tasks.",
  descriptionCompressed:
    "Autonomous desktop loop: scene → Brain → cascade → click. Pass {goal, maxSteps?}.",
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
    const report = await runComputerUseAgentLoop(runtime, params, service);
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
