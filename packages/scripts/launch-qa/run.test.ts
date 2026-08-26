// Exercises launch qa run.test automation behavior with deterministic script fixtures.
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
