/**
 * Keyless per-plugin e2e for `@elizaos/plugin-computeruse` (issue #8801).
 *
 * Drives the `COMPUTER_USE` action's read-only `get_cursor_position` op
 * end-to-end through the real action → service path. Desktop input/capture
 * normally lands on a native driver (nutjs / xdotool / cliclick) that requires
 * a headful display session, so the seed installs a scoped stub of the
 * `ComputerUseService.executeDesktopAction` boundary — the device-syscall
 * analogue of a fetch interceptor — returning a deterministic cursor position.
 * Everything above that boundary (param resolution, approval parsing, result
 * mapping) runs for real, keyless, with zero credentials or hardware.
 */
import type { AgentRuntime } from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import { scenario } from "@elizaos/scenario-runner/schema";
import {
  describeCalls,
  successfulActionData,
  toRecord,
} from "../_helpers/effect-assertions.ts";

process.env.COMPUTER_USE_ENABLED = "1";

const COMPUTER_USE = "COMPUTER_USE";

type DesktopActionParams = { action: string; [key: string]: unknown };
type ComputerActionResult = {
  success: boolean;
  cursorPosition?: { x: number; y: number };
  message?: string;
  error?: string;
};
type ComputerUseService = {
  executeDesktopAction: (
    params: DesktopActionParams,
  ) => Promise<ComputerActionResult>;
};
type R = AgentRuntime & {
  getService: (type: string) => ComputerUseService | null;
  scenarioLlmFixtures?: {
    register: (...f: Array<Record<string, unknown>>) => void;
  };
};

let restore: (() => void) | undefined;

export default scenario({
  lane: "pr-deterministic",
  id: "computeruse.get-cursor-position",
  title: "Computeruse: read cursor position through a stubbed device boundary",
  domain: "computeruse",
  tags: ["smoke", "computeruse", "desktop"],
  description:
    "Reads the desktop cursor position through the COMPUTER_USE action with the native device driver stubbed at the service boundary — keyless, no display, no credentials.",

  requires: { plugins: ["@elizaos/plugin-computeruse"] },
  isolation: "per-scenario",

  seed: [
    {
      type: "custom",
      name: "computeruse-device-stub",
      apply: async (ctx) => {
        const runtime = ctx.runtime as R;
        const service = runtime.getService("computeruse");
        if (!service) {
          throw new Error(
            "ComputerUseService not available — plugin-computeruse did not load",
          );
        }
        const original = service.executeDesktopAction.bind(service);
        service.executeDesktopAction = async (
          params: DesktopActionParams,
        ): Promise<ComputerActionResult> => {
          if (params.action === "get_cursor_position") {
            return {
              success: true,
              cursorPosition: { x: 640, y: 360 },
              message: "Cursor is at (640, 360).",
            };
          }
          return original(params);
        };
        restore = () => {
          service.executeDesktopAction = original;
          restore = undefined;
        };

        runtime.scenarioLlmFixtures?.register(
          {
            name: "computeruse-stage1",
            match: {
              modelType: ModelType.RESPONSE_HANDLER,
              input: (v: string) => v.includes("cursor"),
              toolName: "HANDLE_RESPONSE",
            },
            response: {
              contexts: ["automation"],
              intents: ["read desktop cursor position"],
              replyText: "",
              threadOps: [],
              candidateActionNames: [COMPUTER_USE],
            },
            times: 1,
          },
          {
            name: "computeruse-planner",
            match: {
              modelType: ModelType.ACTION_PLANNER,
              input: (v: string) => v.includes("cursor"),
              toolName: COMPUTER_USE,
            },
            response: {
              text: "",
              thought: "Read the current desktop cursor position.",
              messageToUser: "",
              completed: true,
              finishReason: "tool-calls",
              toolCalls: [
                {
                  id: "call-cu",
                  name: COMPUTER_USE,
                  type: "function",
                  arguments: { action: "get_cursor_position" },
                },
              ],
            },
            times: 1,
          },
          {
            name: "computeruse-decision",
            match: (call: { modelType: string; toolNames: string[] }) =>
              call.modelType === ModelType.RESPONSE_HANDLER &&
              !call.toolNames.includes("HANDLE_RESPONSE"),
            response: {
              success: true,
              decision: "FINISH",
              thought: "Reported the cursor position; nothing more to do.",
              messageToUser: "The cursor is at (640, 360).",
            },
            times: 1,
          },
        );
        return undefined;
      },
    },
  ],
  cleanup: [
    {
      type: "custom",
      name: "restore-computeruse-service",
      apply: () => {
        restore?.();
        return undefined;
      },
    },
  ],

  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Computeruse",
    },
  ],

  turns: [
    {
      kind: "message",
      name: "cursor",
      text: "Where is the mouse cursor right now? Read the cursor position.",
      timeoutMs: 120_000,
      assertTurn: (turn) => {
        const call = turn.actionsCalled.find(
          (a) => a.actionName === COMPUTER_USE,
        );
        if (!call) {
          return `Expected ${COMPUTER_USE} but got: ${turn.actionsCalled
            .map((a) => a.actionName)
            .join(", ")}`;
        }
        if (!call.result?.success) {
          return `${COMPUTER_USE} did not succeed: ${
            call.error?.message ?? call.result?.text ?? "unknown error"
          }`;
        }
      },
    },
  ],

  finalChecks: [
    {
      type: "actionCalled",
      actionName: COMPUTER_USE,
      status: "success",
      minCount: 1,
    },
    {
      // Effect proof (#11381): the param-resolution → service → result-mapping
      // path must carry the device boundary's answer back out. The stub
      // returns (640, 360) only for the `get_cursor_position` op, so a wrong
      // op, dropped params, or broken result mapping all fail here.
      type: "custom",
      name: "cursor-position-round-trips-device-boundary",
      predicate: (ctx) => {
        const data = successfulActionData(ctx, COMPUTER_USE);
        if (!data) {
          return `no successful ${COMPUTER_USE} result data; calls: ${describeCalls(ctx)}`;
        }
        if (data.computerUseAction !== "get_cursor_position") {
          return `expected computerUseAction "get_cursor_position", saw ${JSON.stringify(data.computerUseAction)}`;
        }
        const cursor = toRecord(toRecord(data.result)?.cursorPosition);
        if (cursor?.x !== 640 || cursor?.y !== 360) {
          return `expected result.cursorPosition {x:640,y:360} from the stubbed device boundary, saw ${JSON.stringify(data.result).slice(0, 200)}`;
        }
      },
    },
  ],
});
