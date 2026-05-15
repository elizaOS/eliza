import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
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
  test("quick suite contains only fast local gates", () => {
    const ids = selectTasks(options()).map((task) => task.id);

    expect(ids).toContain("app-core-focused");
    expect(ids).toContain("agent-focused");
    expect(ids).toContain("training-focused");
    expect(ids).toContain("cloud-api-key-client");
    expect(ids).not.toContain("docs");
    expect(ids).not.toContain("ui-smoke");
    expect(ids).not.toContain("cloud-typecheck");
  });

  test("release suite includes tier 1 gates but not nightly browser smoke", () => {
    const ids = selectTasks(options({ suite: "release" })).map(
      (task) => task.id,
    );

    expect(ids).toContain("app-typecheck");
    expect(ids).toContain("cloud-api-key-redaction");
    expect(ids).not.toContain("ui-smoke");
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

  test("quick suite task file references exist", () => {
    for (const task of selectTasks(options())) {
      for (const file of task.requiredFiles ?? []) {
        expect(
          fs.existsSync(path.join(process.cwd(), task.cwd ?? "", file)),
        ).toBe(true);
      }
    }
  });
});
