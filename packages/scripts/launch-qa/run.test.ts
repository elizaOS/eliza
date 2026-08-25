/**
 * Exercises deterministic launch-QA suite selection without spawning the
 * selected commands.
 */
import { describe, expect, test } from "bun:test";
import { selectTasks } from "./run.mjs";

function options(overrides: Record<string, unknown> = {}) {
  return {
    suite: "quick",
    only: null,
    skip: new Set<string>(),
    ...overrides,
  } as Parameters<typeof selectTasks>[0];
}

describe("launch QA task selection", () => {
  test("staging-resource ledger is mandatory in quick and release suites", () => {
    const quickIds = selectTasks(options()).map((task) => task.id);
    const releaseIds = selectTasks(options({ suite: "release" })).map(
      (task) => task.id,
    );

    expect(quickIds).toContain("staging-resource-ledger");
    expect(releaseIds).toContain("staging-resource-ledger");
  });

  test("only and skip narrow selected gates", () => {
    const ids = selectTasks(
      options({
        only: new Set(["docs", "agent-focused"]),
        skip: new Set(["docs"]),
      }),
    ).map((task) => task.id);

    expect(ids).toEqual(["agent-focused"]);
  });
});
