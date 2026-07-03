/**
 * Deterministic e2e coverage for the trycua/cua parity verbs added in #9170 —
 * set_value, kill_app (COMPUTER_USE) and the window getters get_window_size /
 * get_window_position (WINDOW). Zero-cost: a fake ComputerUseService returns
 * deterministic DTOs, so the real action → service dispatch path is exercised
 * end-to-end through the scenario runner with no live model and no live desktop.
 */

import type { Plugin } from "@elizaos/core";
import type {
  ScenarioContext,
  ScenarioTurnExecution,
} from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";
import { useComputerAction } from "../../../../plugins/plugin-computeruse/src/actions/use-computer.ts";
import { windowAction } from "../../../../plugins/plugin-computeruse/src/actions/window.ts";
import type { ComputerUseService } from "../../../../plugins/plugin-computeruse/src/services/computer-use-service.ts";
import type {
  ApprovalSnapshot,
  ComputerActionResult,
  DesktopActionParams,
  WindowActionParams,
  WindowActionResult,
} from "../../../../plugins/plugin-computeruse/src/types.ts";

function emptyApprovalSnapshot(): ApprovalSnapshot {
  return { mode: "approve_all", pendingCount: 0, pendingApprovals: [] };
}

function createFakeComputerUseService(): Partial<ComputerUseService> {
  return {
    getApprovalSnapshot: () => emptyApprovalSnapshot(),
    subscribeApprovals: () => () => {},
    getCapabilities: () =>
      ({
        windowList: { available: true, tool: "fake" },
      }) as ReturnType<ComputerUseService["getCapabilities"]>,
    executeDesktopAction: async (
      params: DesktopActionParams,
    ): Promise<ComputerActionResult> => {
      if (params.action === "set_value") {
        return { success: true, message: `Set value at the target.` };
      }
      if (params.action === "kill_app") {
        return {
          success: true,
          message: "Terminated 4321.",
          data: { target: "4321", pid: 4321, killed: true },
        };
      }
      return { success: true, message: `Did ${params.action}.` };
    },
    executeWindowAction: async (
      params: WindowActionParams,
    ): Promise<WindowActionResult> => {
      if (params.action === "get_window_size") {
        return {
          success: true,
          message: "Window size: 1216x808.",
          bounds: { x: 256, y: 102, width: 1216, height: 808 },
        };
      }
      if (params.action === "get_window_position") {
        return {
          success: true,
          message: "Window position: (256, 102).",
          bounds: { x: 256, y: 102, width: 1216, height: 808 },
        };
      }
      return { success: true, message: `Window ${params.action} completed.` };
    },
  };
}

async function seedComputerUse(
  ctx: ScenarioContext,
): Promise<string | undefined> {
  const runtime = ctx.runtime as
    | ({
        getService?: (name: string) => unknown;
        registerPlugin?: (plugin: Plugin) => Promise<void>;
      } & Record<string, unknown>)
    | undefined;
  if (!runtime?.registerPlugin) {
    return "runtime.registerPlugin unavailable";
  }
  const fakeService = createFakeComputerUseService();
  const previousGetService = runtime.getService?.bind(runtime);
  runtime.getService = (name: string) => {
    if (name === "computeruse") return fakeService;
    return previousGetService?.(name) ?? null;
  };
  await runtime.registerPlugin({
    name: "scenario-computeruse-parity",
    description: "Deterministic computer-use parity-verb scenario plugin",
    actions: [useComputerAction, windowAction],
  });
}

function expectSuccess(message: string) {
  return (execution: ScenarioTurnExecution): string | undefined => {
    if (!execution.responseText.includes(message)) {
      return `expected "${message}" in: ${JSON.stringify(execution.responseText)}`;
    }
    return undefined;
  };
}

function expectParityResults(ctx: ScenarioContext): string | undefined {
  const blob = JSON.stringify(
    ctx.actionsCalled.map((action) => ({
      actionName: action.actionName,
      success: action.result?.success,
      text: action.result?.text,
      data: action.result?.data,
    })),
  );
  for (const expected of [
    "Set value at the target.",
    "Terminated 4321.",
    '"killed":true',
    "Window size: 1216x808.",
    '"width":1216',
    "Window position: (256, 102).",
    '"x":256',
  ]) {
    if (!blob.includes(expected)) {
      return `expected computer-use parity result to include ${JSON.stringify(expected)}, saw ${blob}`;
    }
  }
  return undefined;
}

export default scenario({
  id: "deterministic-computeruse-parity-verbs",
  lane: "pr-deterministic",
  title: "Computer-use parity verbs (set_value / kill_app / window getters)",
  domain: "computeruse",
  tags: ["pr", "deterministic", "zero-cost", "computeruse", "parity"],
  isolation: "shared-runtime",
  seed: [
    {
      type: "custom",
      name: "register COMPUTER_USE + WINDOW with a deterministic service",
      apply: seedComputerUse,
    },
  ],
  turns: [
    {
      kind: "action",
      name: "COMPUTER_USE set_value writes a field value",
      actionName: "COMPUTER_USE",
      text: "Set the value of the field",
      options: {
        parameters: { action: "set_value", coordinate: [120, 240], text: "hi" },
      },
      assertTurn: expectSuccess("Set value"),
    },
    {
      kind: "action",
      name: "COMPUTER_USE kill_app terminates a process",
      actionName: "COMPUTER_USE",
      text: "Kill process 4321",
      options: { parameters: { action: "kill_app", target: "4321" } },
      assertTurn: expectSuccess("Terminated 4321"),
    },
    {
      kind: "action",
      name: "WINDOW get_window_size returns bounds",
      actionName: "WINDOW",
      text: "What is the window size?",
      options: { parameters: { action: "get_window_size" } },
      assertTurn: expectSuccess("1216x808"),
    },
    {
      kind: "action",
      name: "WINDOW get_window_position returns coordinates",
      actionName: "WINDOW",
      text: "Where is the window?",
      options: { parameters: { action: "get_window_position" } },
      assertTurn: expectSuccess("(256, 102)"),
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "computeruse-parity-result-shapes",
      predicate: expectParityResults,
    },
  ],
});
