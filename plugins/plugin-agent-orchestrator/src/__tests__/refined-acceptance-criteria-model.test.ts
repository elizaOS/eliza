/**
 * Replays the model answers of quint/RefinedAcceptanceCriteria.qnt through
 * OrchestratorTaskService.createTask on a PGlite-backed AgentRuntime. The
 * refinement call reaches a local TEXT_SMALL handler that returns the model's
 * answer; no provider is called.
 */

import { readFileSync } from "node:fs";
import {
  type AgentRuntime,
  ModelType,
  type Plugin,
  type ServiceClass,
} from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_CRITERIA_TEMPLATES,
  type OrchestratorTaskType,
} from "../services/acceptance-criteria.js";
import { OrchestratorTaskService } from "../services/orchestrator-task-service.js";
import { createRealTestRuntime } from "./real-runtime.js";

/** One answer of the refinement model call (see the model's header). */
interface ModelAnswer {
  answered: boolean;
  keep: number[];
  checks: number;
  file: number;
}

/** A task kind, the model's answer and the criteria ids the model stores. */
interface ModelCase {
  kind: number;
  answer: ModelAnswer;
  criteria: number[];
}

const KINDS: OrchestratorTaskType[] = [
  "coding",
  "app-build",
  "view-create",
  "deploy",
];
// Each goal names the one file the worker changes.
const GOALS: Record<OrchestratorTaskType, { goal: string; file: string }> = {
  coding: {
    goal: "Fix the leap-day parsing bug in src/date-parse.ts",
    file: "src/date-parse.ts",
  },
  "app-build": {
    goal: "Build a pricing page app whose markup lives in site/index.html",
    file: "site/index.html",
  },
  "view-create": {
    goal: "Add a build status view rendered by src/views/build-status.tsx",
    file: "src/views/build-status.tsx",
  },
  deploy: {
    goal: "Deploy the marketing site to Hetzner with deploy/hetzner.sh",
    file: "deploy/hetzner.sh",
  },
};
const GOAL_CHECKS = [
  "the example in the goal gives the expected result",
  "no unrelated behavior changes",
];
const GOAL_FILE = 20;
const UNNAMED_FILE = 21;

/** The criterion text of a model criterion id for a task kind. */
function criterionText(kind: OrchestratorTaskType, id: number): string {
  if (id < 10) {
    const line = DEFAULT_CRITERIA_TEMPLATES[kind][id];
    if (line === undefined) throw new Error(`No template line ${id}`);
    return line;
  }
  if (id < GOAL_FILE) return GOAL_CHECKS[id - 10];
  if (id === GOAL_FILE) return `${GOALS[kind].file} contains the change`;
  if (id === UNNAMED_FILE) return "docs/RUNBOOK.md describes the change";
  throw new Error(`Unknown criterion id ${id}`);
}

/** The criteria the model lists, in the order of the model's `listed`. */
function listedIds(answer: ModelAnswer): number[] {
  return [
    ...[...answer.keep].sort((a, b) => a - b),
    ...[10, 11].slice(0, answer.checks),
    ...(answer.file === 0 ? [] : [19 + answer.file]),
  ];
}

// A kept template line that names a path ("rollback/undo", "/api/views",
// "Plugin.views") was handed to the model by the template; it stays.
const DEFAULT_CASES: ModelCase[] = [
  {
    kind: 0,
    answer: { answered: true, keep: [0, 1, 2, 3], checks: 1, file: 2 },
    criteria: [0, 1, 2, 3, 10],
  },
  {
    kind: 1,
    answer: { answered: false, keep: [], checks: 0, file: 0 },
    criteria: [0, 1, 2],
  },
  {
    kind: 2,
    answer: { answered: true, keep: [0, 1, 2], checks: 1, file: 2 },
    criteria: [0, 1, 2, 10],
  },
  {
    kind: 2,
    answer: { answered: true, keep: [1], checks: 2, file: 0 },
    criteria: [1, 10, 11],
  },
  {
    kind: 3,
    answer: { answered: true, keep: [0, 1, 2], checks: 2, file: 1 },
    criteria: [0, 1, 2, 10, 11, GOAL_FILE],
  },
  {
    kind: 3,
    answer: { answered: true, keep: [], checks: 0, file: 2 },
    criteria: [0, 1, 2],
  },
];

const casesFile = process.env.ELIZA_REFINED_CRITERIA_MODEL_CASES;
const cases: ModelCase[] = casesFile
  ? JSON.parse(readFileSync(casesFile, "utf8"))
  : DEFAULT_CASES;

let currentKind = 0;
let nextAnswer: ModelAnswer | undefined;
let lastPrompt = "";
let modelCalls = 0;
const refinementModel: Plugin = {
  name: "refined-criteria-model-answer",
  description: "Returns the replayed answer of the refinement model call",
  models: {
    [ModelType.TEXT_SMALL]: async (_runtime, params) => {
      modelCalls += 1;
      lastPrompt = String((params as { prompt?: unknown }).prompt ?? "");
      const answer = nextAnswer;
      if (!answer) throw new Error("No replayed answer");
      if (!answer.answered) return "I cannot set criteria for this goal.";
      const kind = KINDS[currentKind];
      return JSON.stringify({
        criteria: listedIds(answer).map((id) => criterionText(kind, id)),
      });
    },
  },
};

let runtime: AgentRuntime;
let cleanup: (() => Promise<void>) | undefined;
let service: OrchestratorTaskService;
const previousGoalContract = process.env.ELIZA_REQUIRE_GOAL_CONTRACT;

beforeAll(async () => {
  process.env.ELIZA_REQUIRE_GOAL_CONTRACT = "1";
  ({ runtime, cleanup } = await createRealTestRuntime({
    characterName: "RefinedAcceptanceCriteriaModel",
    plugins: [
      refinementModel,
      {
        name: "refined-criteria-task-service",
        description: "Registers the production orchestrator task service",
        services: [OrchestratorTaskService as unknown as ServiceClass],
      },
    ],
  }));
  const loaded = await runtime.getServiceLoadPromise(
    OrchestratorTaskService.serviceType,
  );
  if (!(loaded instanceof OrchestratorTaskService)) {
    throw new Error("Production orchestrator task service did not start");
  }
  service = loaded;
}, 60_000);

afterAll(async () => {
  await cleanup?.();
  if (previousGoalContract === undefined) {
    delete process.env.ELIZA_REQUIRE_GOAL_CONTRACT;
  } else {
    process.env.ELIZA_REQUIRE_GOAL_CONTRACT = previousGoalContract;
  }
});

describe("refined acceptance criteria model", () => {
  it.each(KINDS)("replays the model for %s tasks", async (kind) => {
    const index = KINDS.indexOf(kind);
    // The model's template sizes: four coding lines, three for the others.
    expect(DEFAULT_CRITERIA_TEMPLATES[kind]).toHaveLength(index === 0 ? 4 : 3);
    const group = cases.filter((item) => item.kind === index);
    expect(group.length).toBeGreaterThan(0);
    for (const item of group) {
      currentKind = index;
      nextAnswer = item.answer;
      const callsBefore = modelCalls;
      const task = await service.createTask({
        title: `Refined criteria ${kind}`,
        goal: GOALS[kind].goal,
        kind,
        acceptanceCriteria: [],
      });
      const label = JSON.stringify(item.answer);
      expect(modelCalls - callsBefore, label).toBe(1);
      // The model was handed every template line of the task's kind.
      for (const line of DEFAULT_CRITERIA_TEMPLATES[kind]) {
        expect(lastPrompt, label).toContain(line);
      }
      const stored = await service.getTask(task.id);
      expect(stored?.metadata.acceptanceCriteriaOrigin, label).toBe(
        "generated",
      );
      expect(stored?.acceptanceCriteria, label).toEqual(
        item.criteria.map((id) => criterionText(kind, id)),
      );
    }
  });
});
