/**
 * Proves the conversational planner can continue a production FILE read from
 * an observed partial ReadView and answer only after the late page is visible.
 * Strict fixtures validate every continuation coordinate without fallback.
 */

import { promises as fs, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type IAgentRuntime,
  isReadView,
  ModelType,
  type ReadView,
} from "@elizaos/core";
import {
  type DeterministicModelCall,
  type DeterministicModelFixture,
  matchesScenarioInput,
  type RuntimeWithScenarioModelFixtures,
  stage1ResponseHandlerFixture,
} from "@elizaos/core/testing";
import type {
  CapturedAction,
  ScenarioContext,
  ScenarioTurnExecution,
} from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";
import codingToolsPlugin from "../../../../plugins/plugin-coding-tools/src/index.ts";

const SCENARIO_ID = "deterministic-progressive-content-planning";
const USER_INPUT =
  "Read the verification token from the seeded file and report it exactly.";
const CANARY = "LATE-PLANNER-CANARY-6e91";
const FINAL_ANSWER = `The verification token is ${CANARY}.`;
const FIRST_PAGE_SIZE = 1024;
const FIRST_PAGE = "p".repeat(FIRST_PAGE_SIZE);
const FILE_SOURCE = `${FIRST_PAGE}${CANARY}`;

type JsonRecord = Record<string, unknown>;
type ScenarioRuntime = IAgentRuntime &
  RuntimeWithScenarioModelFixtures & {
    plugins?: Array<{ name?: string }>;
    registerPlugin: (plugin: unknown) => Promise<void>;
    getServiceLoadPromise?: (serviceType: string) => Promise<unknown>;
  };

let fixtureRoot = "";
let filePath = "";
let previousWorkspaceRoots: string | undefined;
let continuationRevision = "";
let continuationOffset = -1;
let partialModelInputContainedCanary = false;
let finalModelObservedCanary = false;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function visitStrings(value: unknown, strings: string[]): void {
  if (typeof value === "string") {
    strings.push(value);
  } else if (Array.isArray(value)) {
    for (const child of value) visitStrings(child, strings);
  } else if (isRecord(value)) {
    for (const child of Object.values(value)) visitStrings(child, strings);
  }
}

function modelStrings(call: DeterministicModelCall): string[] {
  const strings: string[] = [];
  visitStrings(call.params.messages, strings);
  if (call.params.prompt) strings.push(call.params.prompt);
  return strings;
}

function readViewsFromCall(call: DeterministicModelCall): ReadView[] {
  const views: ReadView[] = [];
  for (const candidate of modelStrings(call)) {
    if (!candidate.includes('"readView"')) continue;
    try {
      const pending: unknown[] = [JSON.parse(candidate)];
      while (pending.length > 0) {
        const current = pending.pop();
        if (isReadView(current)) {
          views.push(current);
        } else if (Array.isArray(current)) {
          pending.push(...current);
        } else if (isRecord(current)) {
          pending.push(...Object.values(current));
        }
      }
    } catch {
      // error-policy:J3 only complete JSON tool-result strings are candidates.
    }
  }
  return views;
}

function latestReadView(call: DeterministicModelCall): ReadView | undefined {
  return readViewsFromCall(call).at(-1);
}

function callContains(call: DeterministicModelCall, text: string): boolean {
  return modelStrings(call).some((value) => value.includes(text));
}

function partialReadObserved(call: DeterministicModelCall): boolean {
  const view = latestReadView(call);
  return (
    view?.reference.kind === "file" &&
    view.slice.completeness === "partial-recoverable" &&
    view.slice.range.unit === "byte" &&
    view.slice.range.start === 0 &&
    view.slice.range.end === FIRST_PAGE_SIZE &&
    view.slice.nextOffset === FIRST_PAGE_SIZE &&
    typeof view.slice.revision === "string" &&
    !callContains(call, CANARY)
  );
}

function completeCanaryReadObserved(call: DeterministicModelCall): boolean {
  const view = latestReadView(call);
  return (
    view?.reference.kind === "file" &&
    view.slice.completeness === "complete" &&
    view.slice.range.unit === "byte" &&
    view.slice.range.start === FIRST_PAGE_SIZE &&
    view.slice.range.end === Buffer.byteLength(FILE_SOURCE) &&
    view.slice.hasMore === false &&
    callContains(call, CANARY)
  );
}

function strictPlanningFixtures(): DeterministicModelFixture[] {
  return [
    stage1ResponseHandlerFixture({
      actionName: "FILE",
      args: {},
      contextIds: ["code"],
      input: USER_INPUT,
      messageToUser: "",
    }),
    {
      name: "progressive-file-initial-planner",
      match: (call) =>
        call.modelType === ModelType.ACTION_PLANNER &&
        call.toolNames.includes("FILE") &&
        matchesScenarioInput(USER_INPUT)(call.latestUserText) &&
        readViewsFromCall(call).length === 0 &&
        !callContains(call, CANARY),
      response: {
        text: "",
        thought: "Read only the first bounded byte page.",
        completed: false,
        finishReason: "tool-calls",
        toolCalls: [
          {
            id: "progressive-file-first-page",
            name: "FILE",
            type: "function",
            arguments: {
              action: "read",
              file_path: filePath,
              unit: "byte",
              offset: 0,
              limit: FIRST_PAGE_SIZE,
            },
          },
        ],
      },
      times: 1,
    },
    {
      name: "progressive-file-partial-evaluator",
      match: (call) =>
        call.modelType === ModelType.RESPONSE_HANDLER &&
        partialReadObserved(call),
      response: (call) => {
        partialModelInputContainedCanary = callContains(call, CANARY);
        return {
          success: true,
          decision: "CONTINUE",
          thought: "The partial page exposes an exact continuation.",
        };
      },
      times: 1,
    },
    {
      name: "progressive-file-continuation-planner",
      match: (call) =>
        call.modelType === ModelType.ACTION_PLANNER &&
        call.toolNames.includes("FILE") &&
        partialReadObserved(call),
      response: (call) => {
        const view = latestReadView(call);
        if (!view?.slice.revision || view.slice.nextOffset === undefined) {
          throw new Error("partial ReadView omitted continuation coordinates");
        }
        continuationRevision = view.slice.revision;
        continuationOffset = view.slice.nextOffset;
        return {
          text: "",
          thought: "Continue at the exact next offset and revision.",
          completed: false,
          finishReason: "tool-calls",
          toolCalls: [
            {
              id: "progressive-file-continuation",
              name: "FILE",
              type: "function",
              arguments: {
                action: "read",
                file_path: filePath,
                unit: "byte",
                offset: view.slice.nextOffset,
                limit: 128,
                expectedRevision: view.slice.revision,
              },
            },
          ],
        };
      },
      times: 1,
    },
    {
      name: "progressive-file-final-evaluator",
      match: (call) =>
        call.modelType === ModelType.RESPONSE_HANDLER &&
        completeCanaryReadObserved(call),
      response: (call) => {
        finalModelObservedCanary = callContains(call, CANARY);
        return {
          success: true,
          decision: "FINISH",
          thought: "The continuation page contains the requested token.",
          messageToUser: FINAL_ANSWER,
        };
      },
      times: 1,
    },
    {
      name: "progressive-file-post-turn-evaluators",
      match: { modelType: ModelType.TEXT_SMALL },
      response: {},
      required: false,
      times: { min: 0, max: 1 },
    },
  ];
}

async function setupPlanningFixture(
  ctx: ScenarioContext,
): Promise<string | undefined> {
  const runtime = ctx.runtime as ScenarioRuntime;
  if (!ctx.primaryRoomId) return "scenario primary room unavailable";
  continuationRevision = "";
  continuationOffset = -1;
  partialModelInputContainedCanary = false;
  finalModelObservedCanary = false;
  fixtureRoot = await fs.mkdtemp(
    path.join(realpathSync(os.tmpdir()), `${SCENARIO_ID}-`),
  );
  filePath = path.join(fixtureRoot, "verification-token.txt");
  await fs.writeFile(filePath, FILE_SOURCE, "utf8");
  previousWorkspaceRoots = process.env.CODING_TOOLS_WORKSPACE_ROOTS;
  process.env.CODING_TOOLS_WORKSPACE_ROOTS = fixtureRoot;
  if (
    !runtime.plugins?.some(
      (plugin) =>
        plugin.name === "coding-tools" ||
        plugin.name === "@elizaos/plugin-coding-tools",
    )
  ) {
    await runtime.registerPlugin(codingToolsPlugin);
  }
  await Promise.all([
    runtime.getServiceLoadPromise?.("CODING_TOOLS_SESSION_CWD"),
    runtime.getServiceLoadPromise?.("CODING_TOOLS_SANDBOX"),
  ]);
  const session = runtime.getService("CODING_TOOLS_SESSION_CWD") as {
    setCwd?: (conversationId: string, absPath: string) => void;
  } | null;
  const sandbox = runtime.getService("CODING_TOOLS_SANDBOX") as {
    addRoot?: (conversationId: string, absPath: string) => void;
  } | null;
  if (!session?.setCwd || !sandbox?.addRoot) {
    return "coding-tools workspace services unavailable";
  }
  sandbox.addRoot(ctx.primaryRoomId, fixtureRoot);
  session.setCwd(ctx.primaryRoomId, fixtureRoot);
  runtime.scenarioModelFixtures?.register(...strictPlanningFixtures());
  return undefined;
}

function actionParameters(action: CapturedAction): JsonRecord | undefined {
  if (!isRecord(action.parameters)) return undefined;
  return isRecord(action.parameters.parameters)
    ? action.parameters.parameters
    : action.parameters;
}

function assertPlanningTurn(
  execution: ScenarioTurnExecution,
): string | undefined {
  if (execution.responseText !== FINAL_ANSWER) {
    return `expected final canary answer, saw ${JSON.stringify(execution.responseText)}`;
  }
  const actions = execution.actionsCalled.filter(
    (action) => action.actionName === "FILE",
  );
  if (actions.length !== 2) {
    return `expected exactly two FILE reads, saw ${actions.length}`;
  }
  const firstParams = actionParameters(actions[0]);
  const continuationParams = actionParameters(actions[1]);
  if (
    firstParams?.offset !== 0 ||
    firstParams.limit !== FIRST_PAGE_SIZE ||
    firstParams.expectedRevision !== undefined
  ) {
    return `unexpected first FILE arguments: ${JSON.stringify(firstParams)}`;
  }
  if (
    actions[0].result?.text !== FIRST_PAGE ||
    actions[0].result.text.includes(CANARY)
  ) {
    return "first FILE result leaked the late canary or returned the wrong page";
  }
  if (
    continuationParams?.offset !== FIRST_PAGE_SIZE ||
    continuationParams.limit !== 128 ||
    continuationParams.expectedRevision !== continuationRevision ||
    continuationOffset !== FIRST_PAGE_SIZE
  ) {
    return `continuation missed the observed range/revision: ${JSON.stringify({ continuationParams, continuationOffset, continuationRevision })}`;
  }
  if (actions[1].result?.text !== CANARY) {
    return `expected exact late page, saw ${JSON.stringify(actions[1].result?.text)}`;
  }
  if (partialModelInputContainedCanary) {
    return "late canary leaked into a model input before continuation";
  }
  if (!finalModelObservedCanary) {
    return "final answer was not gated on observing the late canary page";
  }
  return undefined;
}

export default scenario({
  id: "deterministic-progressive-content-planning",
  lane: "pr-deterministic",
  modelFixtures: { mode: "fixtures", fixtures: [] },
  title: "Deterministic autonomous progressive FILE planning",
  domain: "scenario-runner",
  tags: ["pr", "deterministic", "progressive-content", "planning"],
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-coding-tools"] },
  rooms: [{ id: "main", source: "client_chat", title: "Progressive Planning" }],
  seed: [
    {
      type: "custom",
      name: "seed production FILE source and strict planning fixtures",
      apply: setupPlanningFixture,
    },
  ],
  turns: [
    {
      kind: "message",
      name: "planner follows ReadView continuation to the late token",
      text: USER_INPUT,
      assertTurn: assertPlanningTurn,
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      name: "production FILE action ran twice",
      actionName: "FILE",
      minCount: 2,
    },
  ],
  cleanup: [
    {
      type: "custom",
      name: "remove progressive-planning workspace",
      apply: async () => {
        if (fixtureRoot) {
          await fs.rm(fixtureRoot, { force: true, recursive: true });
        }
        if (previousWorkspaceRoots === undefined) {
          delete process.env.CODING_TOOLS_WORKSPACE_ROOTS;
        } else {
          process.env.CODING_TOOLS_WORKSPACE_ROOTS = previousWorkspaceRoots;
        }
        return undefined;
      },
    },
  ],
});
