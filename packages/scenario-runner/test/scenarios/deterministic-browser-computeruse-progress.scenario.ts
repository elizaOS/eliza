/**
 * Keyless coverage that browser and computer-use progress events stream through
 * to the scenario surface. Runs on the pr-deterministic lane under the LLM proxy.
 */
import type { Action, AgentRuntime } from "@elizaos/core";
import type {
  ScenarioContext,
  ScenarioTurnExecution,
} from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";
import { browserPlugin } from "../../../../plugins/plugin-browser/src/plugin.ts";
import {
  __resetBrowserWorkspaceStateForTests,
  executeBrowserWorkspaceCommand,
} from "../../../../plugins/plugin-browser/src/workspace/browser-workspace.ts";
import { useComputerAction } from "../../../../plugins/plugin-computeruse/src/actions/use-computer.ts";
import { runComputerUseAgentLoop } from "../../../../plugins/plugin-computeruse/src/actions/use-computer-agent.ts";
import { Brain } from "../../../../plugins/plugin-computeruse/src/actor/brain.ts";
import type { DisplayCapture } from "../../../../plugins/plugin-computeruse/src/platform/capture.ts";
import type { Scene } from "../../../../plugins/plugin-computeruse/src/scene/scene-types.ts";
import type { ComputerUseService } from "../../../../plugins/plugin-computeruse/src/services/computer-use-service.ts";
import type {
  ApprovalSnapshot,
  DisplayDescriptor,
} from "../../../../plugins/plugin-computeruse/src/types.ts";

const APPROVAL_ID = "approval_8912";

type RuntimeWithRegistration = AgentRuntime & {
  plugins?: Array<{ name?: string }>;
  registerPlugin?: (plugin: typeof browserPlugin) => Promise<void>;
};

function display(): DisplayDescriptor {
  return {
    id: 0,
    bounds: [0, 0, 1280, 720],
    scaleFactor: 1,
    primary: true,
    name: "scenario-display",
  };
}

function scene(): Scene {
  return {
    timestamp: Date.now(),
    displays: [display()],
    focused_window: null,
    apps: [],
    ocr: [
      {
        id: "ocr-save",
        text: "Done",
        bbox: [100, 100, 120, 40],
        conf: 0.99,
        displayId: 0,
      },
    ],
    ax: [],
    vlm_scene: null,
    vlm_elements: null,
  };
}

async function captureAll(): Promise<DisplayCapture[]> {
  return [
    {
      display: display(),
      frame: Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.alloc(64, 0),
      ]),
    },
  ];
}

function fakeComputerUseAgentService(): ComputerUseService {
  return {
    getCurrentScene: () => scene(),
    refreshScene: async () => scene(),
    getDisplays: () => [display()],
    setSceneVlmAnnotations: () => undefined,
  } as unknown as ComputerUseService;
}

function emptyApprovalSnapshot(): ApprovalSnapshot {
  return {
    mode: "approve_all",
    pendingCount: 0,
    pendingApprovals: [],
  };
}

function fakeApprovalService(): ComputerUseService {
  const listeners: Array<(snapshot: ApprovalSnapshot) => void> = [];
  return {
    getApprovalSnapshot: () => emptyApprovalSnapshot(),
    subscribeApprovals: (listener: (snapshot: ApprovalSnapshot) => void) => {
      listeners.push(listener);
      listener(emptyApprovalSnapshot());
      return () => undefined;
    },
    executeDesktopAction: async () => {
      for (const listener of listeners) {
        listener({
          mode: "approve_all",
          pendingCount: 1,
          pendingApprovals: [
            {
              id: APPROVAL_ID,
              command: "desktop_click",
              parameters: { action: "click", coordinate: [10, 20] },
              requestedAt: "2026-06-22T12:00:00.000Z",
            },
          ],
        });
      }
      return {
        success: true,
        message: "Scenario desktop click completed.",
      };
    },
  } as unknown as ComputerUseService;
}

const computerUseAgentScenarioAction: Action = {
  name: "COMPUTER_USE_AGENT",
  description:
    "Scenario-only stub that runs the real computer-use agent loop against a fake display.",
  validate: async () => true,
  handler: async (_runtime, _message, _state, options, callback) => {
    const rawParams =
      options && typeof options === "object"
        ? (options as Record<string, unknown>)
        : {};
    const params = toRecord(rawParams.parameters ?? rawParams);
    const brain = new Brain(null, {
      invokeModel: async () =>
        JSON.stringify({
          scene_summary: "scenario screen is already done",
          target_display_id: 0,
          roi: [],
          proposed_action: {
            kind: "finish",
            rationale: "scenario complete",
          },
        }),
    });
    const report = await runComputerUseAgentLoop(
      null,
      {
        goal: typeof params.goal === "string" ? params.goal : "finish",
        maxSteps: 1,
        streamProgress: params.streamProgress === true,
      },
      fakeComputerUseAgentService(),
      {
        brain,
        captureAll,
        onCompactStepProgress: callback
          ? async (content) => {
              await callback(content, "COMPUTER_USE_AGENT");
            }
          : undefined,
      },
    );
    return {
      success: report.reason === "finish",
      text: `Scenario computer-use agent ${report.reason}.`,
      data: { report },
    };
  },
};

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function firstAction(
  execution: ScenarioTurnExecution,
  actionName: string,
): Record<string, unknown> | null {
  return (
    (execution.actionsCalled.find(
      (action) => action.actionName === actionName,
    ) as Record<string, unknown> | undefined) ?? null
  );
}

function assertResponseIncludesAll(
  execution: ScenarioTurnExecution,
  expected: string[],
): string | undefined {
  const response = execution.responseText ?? "";
  for (const text of expected) {
    if (!response.includes(text)) {
      return `expected response to include ${JSON.stringify(text)}, saw ${JSON.stringify(response)}`;
    }
  }
  return undefined;
}

function assertSuccessfulAction(
  execution: ScenarioTurnExecution,
  actionName: string,
): string | undefined {
  const action = firstAction(execution, actionName);
  if (!action) return `expected ${actionName} to be called`;
  const result = toRecord(action.result);
  if (result.success !== true) {
    return `expected ${actionName} result.success=true, saw ${JSON.stringify(result)}`;
  }
  return undefined;
}

function assertProgressActions(ctx: ScenarioContext): string | undefined {
  const actionBlob = JSON.stringify(
    ctx.actionsCalled.map((action) => ({
      actionName: action.actionName,
      success: action.result?.success,
      text: action.result?.text,
      data: action.result?.data,
    })),
  );
  const turnBlob = JSON.stringify(
    (ctx.turns ?? []).map((turn) => ({
      name: turn.name,
      responseText: turn.responseText,
    })),
  );
  for (const expected of ["BROWSER", "COMPUTER_USE_AGENT", "COMPUTER_USE"]) {
    if (!actionBlob.includes(expected)) {
      return `expected progress action trace to include ${JSON.stringify(expected)}, saw ${actionBlob}`;
    }
  }
  for (const expected of [
    "Step 1: screenshot",
    "Step 1: finish",
    "Scenario desktop click completed.",
  ]) {
    if (!turnBlob.includes(expected)) {
      return `expected progress turn trace to include ${JSON.stringify(expected)}, saw ${turnBlob}`;
    }
  }
  return undefined;
}

async function seedScenario(ctx: {
  runtime?: unknown;
}): Promise<string | undefined> {
  const runtime = ctx.runtime as RuntimeWithRegistration | undefined;
  if (!runtime) return "scenario runtime was not available";

  if (
    runtime.registerPlugin &&
    !runtime.plugins?.some(
      (plugin) =>
        plugin.name === "@elizaos/plugin-browser" || plugin.name === "browser",
    )
  ) {
    await runtime.registerPlugin(browserPlugin);
  }

  __resetBrowserWorkspaceStateForTests();
  await executeBrowserWorkspaceCommand({
    show: true,
    subaction: "open",
    title: "Scenario Progress Page",
    url: "about:blank",
  });

  const previousGetService = runtime.getService.bind(runtime);
  const approvalService = fakeApprovalService();
  runtime.getService = ((serviceType: string) =>
    serviceType === "computeruse"
      ? approvalService
      : previousGetService(serviceType)) as AgentRuntime["getService"];

  runtime.actions = [
    ...(runtime.actions ?? []).filter(
      (action) =>
        action.name !== "COMPUTER_USE_AGENT" && action.name !== "COMPUTER_USE",
    ),
    computerUseAgentScenarioAction,
    useComputerAction,
  ];
  return undefined;
}

export default scenario({
  id: "deterministic-browser-computeruse-progress",
  lane: "pr-deterministic",
  title: "Browser and computer-use progress streaming",
  domain: "scenario-runner",
  tags: [
    "pr",
    "deterministic",
    "zero-cost",
    "browser",
    "computeruse",
    "progress",
  ],
  isolation: "shared-runtime",
  seed: [
    {
      type: "custom",
      name: "register browser action and fake computer-use services",
      apply: seedScenario,
    },
  ],
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "Progress Stream Scenario",
    },
  ],
  turns: [
    {
      kind: "action",
      name: "browser emits streamProgress callback",
      text: "Inspect the current scenario browser state",
      actionName: "BROWSER",
      options: {
        parameters: {
          action: "screenshot",
          streamProgress: true,
          rationale: "capture seeded scenario tab",
        },
      },
      assertTurn: (execution) =>
        assertResponseIncludesAll(execution, [
          "Step 1: screenshot — capture seeded scenario tab",
        ]) ?? assertSuccessfulAction(execution, "BROWSER"),
    },
    {
      kind: "action",
      name: "computer-use agent emits per-step progress",
      text: "Finish the fake display task",
      actionName: "COMPUTER_USE_AGENT",
      options: {
        goal: "finish the fake display task",
        maxSteps: 1,
        streamProgress: true,
      },
      assertTurn: (execution) =>
        assertResponseIncludesAll(execution, [
          "Step 1: finish — scenario complete",
        ]) ?? assertSuccessfulAction(execution, "COMPUTER_USE_AGENT"),
    },
    {
      kind: "action",
      name: "computer-use approval prompt carries inline buttons",
      text: "Click the fake display button",
      actionName: "COMPUTER_USE",
      options: {
        parameters: {
          action: "click",
          coordinate: [10, 20],
          displayId: 0,
        },
      },
      assertTurn: (execution) =>
        assertResponseIncludesAll(execution, [
          `[CHOICE:computeruse-approval id=${APPROVAL_ID}]`,
          `cua:${APPROVAL_ID}:approve=Approve`,
          `cua:${APPROVAL_ID}:deny=Deny`,
          "Scenario desktop click completed.",
        ]) ?? assertSuccessfulAction(execution, "COMPUTER_USE"),
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "browser-computeruse-progress-results",
      predicate: assertProgressActions,
    },
  ],
});
