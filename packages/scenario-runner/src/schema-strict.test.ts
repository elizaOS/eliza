/**
 * Fail-loud harness finalization (#9310):
 *  1. Unknown finalCheck types are a hard error at definition AND load time —
 *     a misspelled check type must never become a silently absent assertion.
 *  2. ScenarioTurn/ScenarioDefinition are closed types — a typo'd assertion
 *     key is a type error instead of an ignored no-op.
 *  3. A finalCheck whose runtime dependency is missing reports status
 *     `skipped`, which fails the scenario in the pr-deterministic lane.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { IAgentRuntime } from "@elizaos/core";
import {
  type ScenarioDefinition,
  type ScenarioFinalCheck,
  type ScenarioTurn,
  type ScenarioTurnExecution,
  scenario,
} from "@elizaos/scenario-runner/schema";
import { afterEach, describe, expect, it } from "vitest";
import { skippedFinalCheckFailure } from "./executor.ts";
import { runFinalCheck } from "./final-checks/index.ts";
import { loadScenarioFile } from "./loader.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function makeTempScenarioDir(): Promise<string> {
  const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const dir = await mkdtemp(join(packageDir, ".tmp-schema-strict-"));
  tempDirs.push(dir);
  return dir;
}

describe("scenario() strict finalCheck validation", () => {
  const base = {
    id: "fixture.strict",
    title: "Strict fixture",
    domain: "fixture",
    turns: [{ kind: "message", name: "ask", text: "hello" }],
  } satisfies Omit<ScenarioDefinition, "finalChecks">;

  it("throws on an unknown finalCheck type instead of silently skipping it", () => {
    expect(() =>
      scenario({
        ...base,
        finalChecks: [
          // A typo'd discriminator used to pass validation untouched.
          { type: "definitionCountDeltaa", name: "typo" },
        ] as unknown as ScenarioFinalCheck[],
      }),
    ).toThrow(/unknown type "definitionCountDeltaa"/);
  });

  it("lists the known finalCheck types in the error", () => {
    expect(() =>
      scenario({
        ...base,
        finalChecks: [
          { type: "nope", name: "n" },
        ] as unknown as ScenarioFinalCheck[],
      }),
    ).toThrow(/Known types: .*judgeRubric.*definitionCountDelta/);
  });

  it("still accepts every known finalCheck type and rejects unknown fields", () => {
    expect(() =>
      scenario({
        ...base,
        finalChecks: [
          { type: "actionCalled", name: "ok", actionName: "CREATE_TASK" },
        ],
      }),
    ).not.toThrow();
    expect(() =>
      scenario({
        ...base,
        finalChecks: [
          {
            type: "actionCalled",
            name: "bad",
            actioName: "CREATE_TASK",
          },
        ] as unknown as ScenarioFinalCheck[],
      }),
    ).toThrow(/unknown field\(s\)/);
  });
});

describe("scenario() strict scenario metadata validation", () => {
  const base = {
    id: "fixture.strict.metadata",
    title: "Strict metadata fixture",
    domain: "fixture",
    turns: [{ kind: "message", name: "ask", text: "hello" }],
  } satisfies ScenarioDefinition;

  it("throws on an unknown top-level scenario status instead of running it", () => {
    expect(() =>
      scenario({
        ...base,
        status: "known-red",
      } as unknown as ScenarioDefinition),
    ).toThrow(/invalid status "known-red"/);
  });
});

describe("loadScenarioFile strict validation", () => {
  it("hard-fails loading a plain-object scenario with an unknown finalCheck type", async () => {
    const dir = await makeTempScenarioDir();
    const file = join(dir, "bad-check.scenario.ts");
    await writeFile(
      file,
      [
        // A plain object export bypasses the scenario() helper, so the loader
        // must re-validate at load time.
        "export default {",
        '  id: "fixture.bad.check",',
        '  title: "Bad finalCheck",',
        '  domain: "fixture",',
        '  turns: [{ kind: "message", name: "ask", text: "hello" }],',
        '  finalChecks: [{ type: "memoryWriteOccured", name: "typo" }],',
        "};",
        "",
      ].join("\n"),
    );

    await expect(loadScenarioFile(file)).rejects.toThrow(
      /unknown type "memoryWriteOccured"/,
    );
  });

  it("loads a valid plain-object scenario unchanged", async () => {
    const dir = await makeTempScenarioDir();
    const file = join(dir, "good.scenario.ts");
    await writeFile(
      file,
      [
        "export default {",
        '  id: "fixture.good",',
        '  title: "Good",',
        '  domain: "fixture",',
        '  turns: [{ kind: "message", name: "ask", text: "hello" }],',
        '  finalChecks: [{ type: "gmailNoRealWrite", name: "no writes" }],',
        "};",
        "",
      ].join("\n"),
    );

    await expect(loadScenarioFile(file)).resolves.toMatchObject({
      scenario: { id: "fixture.good" },
    });
  });
});

describe("skipped finalChecks (dependency missing)", () => {
  const runtime = {} as IAgentRuntime;

  it("reports status 'skipped' when the approval queue dependency is missing", async () => {
    const result = await runFinalCheck(
      { type: "approvalRequestExists", name: "approval" },
      { runtime, ctx: { actionsCalled: [] } },
    );
    expect(result).toMatchObject({
      status: "skipped",
      detail: "dependency missing: no approval queue service registered",
    });
  });

  it("reports status 'skipped' when the connector dispatcher dependency is missing", async () => {
    const result = await runFinalCheck(
      { type: "pushSent", name: "push", channel: "telegram" },
      { runtime, ctx: { actionsCalled: [] } },
    );
    expect(result).toMatchObject({
      status: "skipped",
      detail: "dependency missing: no connector dispatcher registered",
    });
  });

  it("fails the scenario for a skipped check in the pr-deterministic lane", () => {
    const failure = skippedFinalCheckFailure("pr-deterministic", {
      status: "skipped",
      label: "approval",
      detail: "dependency missing: no approval queue service registered",
    });
    expect(failure).toMatch(/failure in the pr-deterministic lane/);
    expect(failure).toContain('finalCheck "approval" skipped');
  });

  it("does not fail live-only scenarios for skips (they are counted instead)", () => {
    expect(
      skippedFinalCheckFailure("live-only", {
        status: "skipped",
        label: "approval",
        detail: "dependency missing: no approval queue service registered",
      }),
    ).toBeNull();
    expect(
      skippedFinalCheckFailure("pr-deterministic", {
        status: "passed",
        label: "approval",
        detail: "1 matching approval request(s)",
      }),
    ).toBeNull();
  });
});

describe("closed scenario types (typo-prone keys are type errors)", () => {
  it("rejects typo'd turn assertion keys and dead planner fields at compile time", () => {
    // @ts-expect-error acceptedActions is not a real turn key (use expectedActions)
    const typoTurn: ScenarioTurn = { name: "t", acceptedActions: ["X"] };
    const plannerJudgeTurn: ScenarioTurn = {
      name: "t",
      // @ts-expect-error plannerJudge was declared but never consumed by the executor — removed
      plannerJudge: { rubric: "r" },
    };
    const execution: ScenarioTurnExecution = {
      actionsCalled: [],
      // @ts-expect-error plannerText was never assigned by the executor — removed
      plannerText: "never populated",
    };
    const typoScenario: ScenarioDefinition = {
      id: "x",
      title: "x",
      domain: "x",
      turns: [],
      // @ts-expect-error unknown top-level scenario keys are type errors
      finalCheks: [],
    };
    // The values only exist so the compile-time assertions above have a home.
    expect([typoTurn, plannerJudgeTurn, execution, typoScenario]).toBeTruthy();
  });
});
