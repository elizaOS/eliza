/**
 * Default acceptance-criteria generation (#8896).
 *
 * The auto goal-verifier only grills tasks that carry acceptance criteria, so a
 * criteria-free "fix this bug" task historically skipped verification entirely.
 * {@link generateDefaultAcceptanceCriteria} closes that gap by minting 3-5
 * measurable criteria from the goal. These tests pin:
 *
 *  - the static (model-free) path always returns ≥3 criteria,
 *  - coding / app-build / view-create / deploy produce DISTINCT sets,
 *  - {@link detectTaskType} classifies sample goals correctly,
 *  - the model path is defensive: a throwing / malformed / stingy model falls
 *    back to the static template, never throws.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_CRITERIA_TEMPLATES,
  detectTaskType,
  generateDefaultAcceptanceCriteria,
  isNonTrivialGoal,
  shouldRequireGoalContract,
  staticAcceptanceCriteria,
} from "../../src/services/acceptance-criteria.js";

/** A runtime whose `useModel` returns the given raw string (or throws). */
function runtimeWithModel(
  impl: (() => Promise<unknown>) | string,
): IAgentRuntime {
  const useModel =
    typeof impl === "string" ? vi.fn(async () => impl) : vi.fn(impl);
  return { useModel } as unknown as IAgentRuntime;
}

describe("detectTaskType", () => {
  it("defaults to coding for a plain bug-fix goal", () => {
    expect(detectTaskType("fix the off-by-one bug in the parser")).toBe(
      "coding",
    );
    expect(detectTaskType("refactor the auth module")).toBe("coding");
    // A bare "app"/"application" is coding, NOT an app-build — it must not pull
    // in the app-build-only "the live URL returns HTTP 200" criterion.
    expect(detectTaskType("refactor the app's state store")).toBe("coding");
    expect(detectTaskType("fix the application startup crash")).toBe("coding");
  });

  it("classifies view-create goals", () => {
    expect(detectTaskType("create a new dashboard view with a viewKind")).toBe(
      "view-create",
    );
    expect(detectTaskType("add a widget to the workbench")).toBe("view-create");
  });

  it("classifies app-build goals", () => {
    expect(detectTaskType("build a landing page for the product")).toBe(
      "app-build",
    );
    expect(detectTaskType("create a web app that lists todos")).toBe(
      "app-build",
    );
    // Canonical grammatical phrasing: "an app" and up to two intervening
    // words must classify (a bare `build\s+a\s+app` regressed these to
    // coding, silently dropping the live-URL acceptance criterion).
    expect(detectTaskType("build an app that tracks expenses")).toBe(
      "app-build",
    );
    expect(detectTaskType("create an app for my book club")).toBe("app-build");
    expect(detectTaskType("make an app that shows the weather")).toBe(
      "app-build",
    );
    expect(detectTaskType("build a todo app with reminders")).toBe("app-build");
    expect(detectTaskType("create an expense tracking app")).toBe("app-build");
  });

  it("keeps refactor/fix phrasing with intervening verbs as coding", () => {
    // The verb branch must not overreach: mentioning app-ish words without a
    // build/create/make verb (or web/site phrasing) stays coding.
    expect(detectTaskType("build an approach for caching")).toBe("coding");
    expect(detectTaskType("update the app manifest parser")).toBe("coding");
  });

  it("classifies deploy goals", () => {
    expect(detectTaskType("deploy the service to production")).toBe("deploy");
    expect(detectTaskType("ship to prod and set up autoscaling")).toBe(
      "deploy",
    );
  });

  it("is empty-safe", () => {
    expect(detectTaskType("")).toBe("coding");
    expect(detectTaskType("   ")).toBe("coding");
  });
});

describe("staticAcceptanceCriteria", () => {
  it("returns ≥3 criteria for every task type", () => {
    for (const type of [
      "coding",
      "app-build",
      "view-create",
      "deploy",
    ] as const) {
      expect(DEFAULT_CRITERIA_TEMPLATES[type].length).toBeGreaterThanOrEqual(3);
    }
    expect(staticAcceptanceCriteria("fix bug").length).toBeGreaterThanOrEqual(
      3,
    );
  });

  it("produces DIFFERENT sets for coding vs app-build vs view-create", () => {
    const coding = staticAcceptanceCriteria("fix bug", "coding");
    const appBuild = staticAcceptanceCriteria("build a site", "app-build");
    const viewCreate = staticAcceptanceCriteria("add a view", "view-create");

    expect(coding).not.toEqual(appBuild);
    expect(coding).not.toEqual(viewCreate);
    expect(appBuild).not.toEqual(viewCreate);

    // app-build is the coding superset plus the live-URL check.
    expect(appBuild).toEqual([...coding, "the live URL returns HTTP 200"]);
    // view-create is its own distinct set (no overlap with coding's checks).
    expect(viewCreate.some((c) => coding.includes(c))).toBe(false);
  });

  it("respects an explicit task-type hint over goal detection", () => {
    // Goal text reads like a deploy, but the hint forces view-create.
    expect(staticAcceptanceCriteria("deploy to prod", "view-create")).toEqual(
      staticAcceptanceCriteria("any", "view-create"),
    );
  });
});

describe("isNonTrivialGoal / shouldRequireGoalContract", () => {
  it("treats blank / near-blank goals as trivial", () => {
    expect(isNonTrivialGoal("")).toBe(false);
    expect(isNonTrivialGoal("  ")).toBe(false);
    expect(isNonTrivialGoal("fix")).toBe(false);
    expect(isNonTrivialGoal("fix this bug")).toBe(true);
  });

  it("defaults the goal contract ON; only '0' disables", () => {
    const prev = process.env.ELIZA_REQUIRE_GOAL_CONTRACT;
    try {
      delete process.env.ELIZA_REQUIRE_GOAL_CONTRACT;
      expect(shouldRequireGoalContract()).toBe(true);
      process.env.ELIZA_REQUIRE_GOAL_CONTRACT = "1";
      expect(shouldRequireGoalContract()).toBe(true);
      process.env.ELIZA_REQUIRE_GOAL_CONTRACT = "0";
      expect(shouldRequireGoalContract()).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.ELIZA_REQUIRE_GOAL_CONTRACT;
      else process.env.ELIZA_REQUIRE_GOAL_CONTRACT = prev;
    }
  });
});

describe("generateDefaultAcceptanceCriteria", () => {
  it("returns the static template when no runtime is supplied", async () => {
    const criteria = await generateDefaultAcceptanceCriteria(
      "fix the bug",
      "coding",
    );
    expect(criteria).toEqual([...DEFAULT_CRITERIA_TEMPLATES.coding]);
    expect(criteria.length).toBeGreaterThanOrEqual(3);
  });

  it("falls back to the static set when useModel is absent", async () => {
    const runtime = {} as IAgentRuntime;
    const criteria = await generateDefaultAcceptanceCriteria(
      "build a web app",
      undefined,
      runtime,
    );
    expect(criteria).toEqual([...DEFAULT_CRITERIA_TEMPLATES["app-build"]]);
  });

  it("uses the model's refined criteria when it returns a valid object", async () => {
    const refined = [
      "the new endpoint returns 200 for a valid request",
      "the parser handles empty input without throwing",
      "tests for the new branch pass",
      "the diff includes the regression test",
    ];
    const runtime = runtimeWithModel(JSON.stringify({ criteria: refined }));
    const criteria = await generateDefaultAcceptanceCriteria(
      "fix the parser crash on empty input",
      "coding",
      runtime,
    );
    expect(criteria).toEqual(refined);
  });

  it("falls back to the static set when the model throws", async () => {
    const runtime = runtimeWithModel(async () => {
      throw new Error("model exploded");
    });
    const criteria = await generateDefaultAcceptanceCriteria(
      "fix the bug",
      "coding",
      runtime,
    );
    expect(criteria).toEqual([...DEFAULT_CRITERIA_TEMPLATES.coding]);
  });

  it("falls back when the model returns unparseable output", async () => {
    const runtime = runtimeWithModel("not json at all, sorry");
    const criteria = await generateDefaultAcceptanceCriteria(
      "fix the bug",
      "coding",
      runtime,
    );
    expect(criteria).toEqual([...DEFAULT_CRITERIA_TEMPLATES.coding]);
  });

  it("tops up to ≥3 from the fallback when the model is stingy", async () => {
    const runtime = runtimeWithModel(
      JSON.stringify({ criteria: ["only one concrete criterion"] }),
    );
    const criteria = await generateDefaultAcceptanceCriteria(
      "fix the bug",
      "coding",
      runtime,
    );
    expect(criteria.length).toBeGreaterThanOrEqual(3);
    expect(criteria[0]).toBe("only one concrete criterion");
  });

  it("caps the criteria at the upper bound", async () => {
    const many = Array.from({ length: 12 }, (_, i) => `criterion number ${i}`);
    const runtime = runtimeWithModel(JSON.stringify({ criteria: many }));
    const criteria = await generateDefaultAcceptanceCriteria(
      "do a lot of things",
      "coding",
      runtime,
    );
    expect(criteria.length).toBeLessThanOrEqual(5);
  });
});
