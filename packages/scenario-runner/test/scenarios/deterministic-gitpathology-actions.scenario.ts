import { promises as fs, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  CapturedAction,
  ScenarioContext,
  ScenarioTurnExecution,
} from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";
import gitPathologyPlugin, {
  GIT_PATHOLOGY_SERVICE_NAME,
} from "../../../../plugins/plugin-gitpathologist/src/index.ts";
import {
  type RuntimeWithScenarioLlmFixtures,
  registerStrictActionRouteFixtures,
} from "./_helpers/strict-llm-action-fixtures";

/**
 * Keyless GIT_PATHOLOGY coverage.
 *
 * gitpathologist auto-loads in the app whenever the workspace is a git checkout
 * (plugin-collector: gitpathologistRequested), so GIT_PATHOLOGY is part of the
 * default action surface — it must have a deterministic e2e scenario.
 *
 * The `list` op reads the per-repo report cache and returns a structured
 * ActionResult with no git scan and no LLM narration, so it is fully keyless
 * and deterministic. We pin the cache to a fresh temp dir via the
 * GITPATHOLOGIST_CACHE_DIR env (read only by gitpathologist — no cross-scenario
 * contamination) so the cache is guaranteed empty: reports == []. This proves
 * the action dispatch, service wiring, and JSON result shape end to end without
 * a model or credentials. The heavier `report` op (git history scan + LLM
 * narration) needs a live model for its narrative and stays live-only.
 */

const tmpRoot = path.join(
  realpathSync(os.tmpdir()),
  "eliza-scenario-gitpathology",
);
const cacheDir = path.join(tmpRoot, "cache");

const listParameters = { action: "list" };

const strictGitPathologyRoutes = [
  {
    actionName: "GIT_PATHOLOGY",
    args: listParameters,
    contextIds: ["code"],
    input: "Run the git pathology list action for cached reports",
    messageToUser: "No cached pathology reports",
  },
];

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function actionParameters(action: CapturedAction): JsonRecord {
  return isRecord(action.parameters) ? action.parameters : {};
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function expectEqual(
  actual: unknown,
  expected: unknown,
  label: string,
): string | undefined {
  const actualJson = stableStringify(actual);
  const expectedJson = stableStringify(expected);
  return actualJson === expectedJson
    ? undefined
    : `expected ${label}=${expectedJson}, saw ${actualJson}`;
}

function firstAction(
  execution: ScenarioTurnExecution,
  actionName: string,
): CapturedAction | string {
  const action = execution.actionsCalled.find(
    (candidate) => candidate.actionName === actionName,
  );
  return (
    action ??
    `expected ${actionName} action, saw ${execution.actionsCalled.map((candidate) => candidate.actionName).join(", ") || "none"}`
  );
}

function expectSuccess(action: CapturedAction): string | undefined {
  return action.result?.success === true
    ? undefined
    : `expected ActionResult.success=true, saw ${stableStringify(action.result)}`;
}

function expectActionOptions(
  action: CapturedAction,
  expectedParameters: JsonRecord,
): string | undefined {
  const actual = actionParameters(action);
  if (
    !expectEqual(
      actual,
      expectedParameters,
      `${action.actionName} handler options`,
    )
  ) {
    return undefined;
  }
  const nested = isRecord(actual.parameters) ? actual.parameters : null;
  if (
    nested &&
    !expectEqual(
      nested,
      expectedParameters,
      `${action.actionName} nested handler parameters`,
    )
  ) {
    return undefined;
  }
  return `expected ${action.actionName} handler parameters to include ${stableStringify(expectedParameters)}, saw ${stableStringify(actual)}`;
}

function expectListTurn(execution: ScenarioTurnExecution): string | undefined {
  const action = firstAction(execution, "GIT_PATHOLOGY");
  if (typeof action === "string") return action;
  return (
    expectActionOptions(action, listParameters) ??
    expectSuccess(action) ??
    (() => {
      const data = action.result?.data;
      if (!isRecord(data)) {
        return `expected ActionResult.data object, saw ${stableStringify(data)}`;
      }
      if (!Array.isArray(data.reports)) {
        return `expected data.reports array, saw ${stableStringify(data.reports)}`;
      }
      if (data.reports.length !== 0) {
        return `expected empty reports for fresh cache, saw ${data.reports.length}`;
      }
      return action.result?.text ===
        "No cached pathology reports for this repo yet."
        ? undefined
        : `expected GIT_PATHOLOGY result.text to report empty cache, saw ${stableStringify(action.result?.text)}`;
    })()
  );
}

function expectListScenario(ctx: ScenarioContext): string | undefined {
  const action = ctx.actionsCalled.find(
    (candidate) => candidate.actionName === "GIT_PATHOLOGY",
  );
  if (!action) {
    return `expected GIT_PATHOLOGY action, saw ${ctx.actionsCalled.map((candidate) => candidate.actionName).join(", ") || "none"}`;
  }
  return (
    expectActionOptions(action, listParameters) ??
    expectSuccess(action) ??
    (() => {
      const data = action.result?.data;
      if (!isRecord(data)) {
        return `expected ActionResult.data object, saw ${stableStringify(data)}`;
      }
      if (!Array.isArray(data.reports)) {
        return `expected data.reports array, saw ${stableStringify(data.reports)}`;
      }
      if (data.reports.length !== 0) {
        return `expected empty reports for fresh cache, saw ${data.reports.length}`;
      }
      return action.result?.text ===
        "No cached pathology reports for this repo yet."
        ? undefined
        : `expected GIT_PATHOLOGY result.text to report empty cache, saw ${stableStringify(action.result?.text)}`;
    })()
  );
}

export default scenario({
  id: "deterministic-gitpathology-actions",
  lane: "pr-deterministic",
  title: "Deterministic gitpathology GIT_PATHOLOGY action",
  description:
    "Registers @elizaos/plugin-gitpathologist on the shared runtime and exercises the keyless GIT_PATHOLOGY `list` op against an isolated empty cache.",
  domain: "scenario-runner",
  tags: ["pr", "deterministic", "zero-cost", "gitpathology"],
  isolation: "shared-runtime",
  requires: {
    plugins: ["@elizaos/plugin-gitpathologist"],
  },
  seed: [
    {
      type: "custom",
      name: "register gitpathologist with an isolated empty cache",
      apply: async (ctx) => {
        await fs.rm(tmpRoot, { force: true, recursive: true });
        await fs.mkdir(cacheDir, { recursive: true });
        process.env.GITPATHOLOGIST_CACHE_DIR = cacheDir;

        const runtime = ctx.runtime as
          | (RuntimeWithScenarioLlmFixtures & {
              plugins?: Array<{ name?: string }>;
              registerPlugin?: (
                plugin: typeof gitPathologyPlugin,
              ) => Promise<void>;
              getServiceLoadPromise?: (serviceType: string) => Promise<unknown>;
              getService?: (serviceType: string) => unknown;
            })
          | undefined;
        if (!runtime?.registerPlugin) {
          return "runtime.registerPlugin unavailable";
        }
        if (
          !runtime.plugins?.some(
            (plugin) => plugin.name === "@elizaos/plugin-gitpathologist",
          )
        ) {
          await runtime.registerPlugin(gitPathologyPlugin);
        }
        await runtime.getServiceLoadPromise?.(GIT_PATHOLOGY_SERVICE_NAME);
        if (!runtime.getService?.(GIT_PATHOLOGY_SERVICE_NAME)) {
          return "GitPathologyService unavailable after registerPlugin";
        }
        registerStrictActionRouteFixtures(runtime, strictGitPathologyRoutes);
        return undefined;
      },
    },
  ],
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "Deterministic GitPathology",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "list cached pathology reports",
      text: "Run the git pathology list action for cached reports",
      responseIncludesAny: [
        "No cached pathology reports",
        "Cached pathology reports",
      ],
      assertTurn: expectListTurn,
    },
  ],
  finalChecks: [
    // Structural marker: deterministic-action-coverage.test.ts reads
    // `actionName` fields off loaded finalChecks to prove GIT_PATHOLOGY is
    // still scenario-covered. The custom predicate below is the real gate.
    {
      type: "actionCalled",
      actionName: "GIT_PATHOLOGY",
      status: "success",
      minCount: 1,
    },
    {
      type: "custom",
      name: "gitpathology-list-empty-cache-result",
      predicate: expectListScenario,
    },
  ],
});
