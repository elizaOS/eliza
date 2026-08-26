/**
 * Exercises acceptance-criteria generation for durable orchestrator tasks.
 * The suite covers task classification, static template distinctions, and
 * defensive fallback when model refinement is unavailable or malformed.
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
    // in the app-build-only live-URL criterion.
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
    // Single-word "webpage" and descriptor-laden phrasing must classify too —
    // the old 2-word window + missing "webpage" literal parked a real page
    // build under coding criteria ("the change is summarized in the diff"),
    // failing every verify attempt (live 2026-08-18: countdown page).
    expect(
      detectTaskType(
        "Create a simple, clean New Year's countdown webpage. Include HTML, CSS, and JavaScript",
      ),
    ).toBe("app-build");
    expect(detectTaskType("make me a lil new years countdown page")).toBe(
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

    // app-build is serve-focused ON PURPOSE (#20794 live residual): a quick
    // one-file app has no test/typecheck surface, so it no longer inherits the
    // coding checks — it pins deliverable existence + live serving instead.
    expect(appBuild).toEqual([
      "the live URL is reachable",
      "the deliverable file exists in the workdir",
      "the page serves the requested content",
    ]);
    expect(appBuild.some((c) => coding.includes(c))).toBe(false);
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

  it("hands the refine prompt the verbatim request for coding goals", async () => {
    const runtime = runtimeWithModel(JSON.stringify({ criteria: [] }));
    await generateDefaultAcceptanceCriteria(
      "Improve parser resilience",
      "coding",
      runtime,
      {
        verbatimRequest:
          "make the parser survive empty input and add a regression test",
      },
    );
    const prompt = String(
      (runtime.useModel as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.prompt,
    );
    expect(prompt).toContain("User's verbatim request");
    expect(prompt).toContain(
      "make the parser survive empty input and add a regression test",
    );
  });
});

// Fix for live 2026-08-21, task 5c6d85c0 "demo-hello": the app-build template
// alone told the verifier nothing about the asked gradient/current date, so
// the builder passed its own blind check while the verifier failed the task
// three times. The template stays the FLOOR (#20794's serve-focused rationale
// stands); a CONSTRAINED refinement layers request-specific, serve-observable
// content criteria from the VERBATIM request on top.
describe("generateDefaultAcceptanceCriteria app-build content specialization", () => {
  const VERBATIM =
    "build a tiny app called demo-hello: a page that says hello with a nice gradient and the current date, deploy it";
  const TEMPLATE = [...DEFAULT_CRITERIA_TEMPLATES["app-build"]];

  it("receives the verbatim request in the constrained refine prompt", async () => {
    const runtime = runtimeWithModel(JSON.stringify({ criteria: [] }));
    await generateDefaultAcceptanceCriteria(
      "demo-hello app",
      "app-build",
      runtime,
      { verbatimRequest: VERBATIM },
    );
    const prompt = String(
      (runtime.useModel as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.prompt,
    );
    expect(prompt).toContain("User's verbatim request:");
    // PROMPT-INTEGRITY: the whole ask, not a summary.
    expect(prompt).toContain(VERBATIM);
    expect(prompt).toContain("observable property of the served page");
  });

  it("layers serve-observable content specifics on top of the intact template floor", async () => {
    const runtime = runtimeWithModel(
      JSON.stringify({
        criteria: [
          "the page shows a gradient background",
          "the page shows the current date",
        ],
      }),
    );
    const criteria = await generateDefaultAcceptanceCriteria(
      "demo-hello app",
      "app-build",
      runtime,
      { verbatimRequest: VERBATIM },
    );
    // Floor first and intact…
    expect(criteria.slice(0, TEMPLATE.length)).toEqual(TEMPLATE);
    // …with the asked features named behind it.
    expect(criteria).toContain("the page shows a gradient background");
    expect(criteria).toContain("the page shows the current date");
    expect(criteria.length).toBeLessThanOrEqual(5);
  });

  it("drops runtime-behavior demands and keeps the pure template when nothing survives", async () => {
    const runtime = runtimeWithModel(
      JSON.stringify({
        criteria: [
          "clicking the button updates the DOM",
          "the browser console shows zero errors",
          "the countdown timer changes its value every second",
        ],
      }),
    );
    const criteria = await generateDefaultAcceptanceCriteria(
      "demo-hello app",
      "app-build",
      runtime,
      { verbatimRequest: VERBATIM },
    );
    expect(criteria).toEqual(TEMPLATE);
  });

  it("keeps only the static-content specific when the model mixes shapes", async () => {
    const runtime = runtimeWithModel(
      JSON.stringify({
        criteria: [
          "clicking the gradient updates the displayed date",
          "the page shows the current date",
        ],
      }),
    );
    const criteria = await generateDefaultAcceptanceCriteria(
      "demo-hello app",
      "app-build",
      runtime,
      { verbatimRequest: VERBATIM },
    );
    expect(criteria).toContain("the page shows the current date");
    expect(criteria).not.toContain(
      "clicking the gradient updates the displayed date",
    );
  });

  it("degrades to the pure template on model failure or garbage", async () => {
    const throwing = runtimeWithModel(async () => {
      throw new Error("model exploded");
    });
    expect(
      await generateDefaultAcceptanceCriteria(
        "demo-hello app",
        "app-build",
        throwing,
        { verbatimRequest: VERBATIM },
      ),
    ).toEqual(TEMPLATE);
    const garbage = runtimeWithModel("not json");
    expect(
      await generateDefaultAcceptanceCriteria(
        "demo-hello app",
        "app-build",
        garbage,
        { verbatimRequest: VERBATIM },
      ),
    ).toEqual(TEMPLATE);
  });

  it("keeps script-run purely deterministic", async () => {
    const runtime = runtimeWithModel(
      JSON.stringify({ criteria: ["a test suite passes"] }),
    );
    const criteria = await generateDefaultAcceptanceCriteria(
      "write a python script that picks a random dinner idea and run it",
      "script-run",
      runtime,
      { verbatimRequest: "write me a dinner-idea script and run it" },
    );
    expect(criteria).toEqual([...DEFAULT_CRITERIA_TEMPLATES["script-run"]]);
    expect(runtime.useModel).not.toHaveBeenCalled();
  });

  it("detects app-build from the verbatim request when the goal is a bare label", async () => {
    // The planner's goal ("demo-hello deliverable") carries no app phrasing;
    // detection must read the verbatim ask, same both-texts rule as
    // taskTypeHintFor. (A "deploy it" tail would classify deploy instead —
    // the create path pins kind "app-build" for those, so the hint wins.)
    const criteria = await generateDefaultAcceptanceCriteria(
      "demo-hello deliverable",
      undefined,
      undefined,
      {
        verbatimRequest:
          "build a tiny app called demo-hello: a page that says hello with a nice gradient and the current date",
      },
    );
    expect(criteria).toEqual(TEMPLATE);
  });
});
