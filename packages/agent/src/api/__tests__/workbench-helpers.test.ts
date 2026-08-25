/**
 * Verifies the workbench task normalization helpers by importing the
 * production API module directly; the helpers are pure, so the harness is
 * deterministic and nothing is mocked.
 */

import type { Task } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  asObject,
  isWorkbenchTodoTask,
  normalizeStringArray,
  normalizeTags,
  normalizeTaskId,
  normalizeTimestamp,
  parseNullableNumber,
  readTaskCompleted,
  readTaskMetadata,
  toWorkbenchTask,
  toWorkbenchTodo,
} from "../workbench-helpers.ts";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
    name: "Task 1",
    description: "desc",
    tags: [],
    metadata: {},
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
    ...overrides,
  } as Task;
}

describe("asObject", () => {
  it("accepts plain objects and rejects others", () => {
    expect(asObject({ a: 1 })).toEqual({ a: 1 });
    expect(asObject(null)).toBeNull();
    expect(asObject([])).toBeNull();
    expect(asObject(42)).toBeNull();
  });
});

describe("normalizeStringArray", () => {
  it("filters, trims, and drops empties", () => {
    expect(normalizeStringArray([" a ", 5, "b", "", null])).toEqual(["a", "b"]);
    expect(normalizeStringArray("not-array")).toEqual([]);
  });
});

describe("normalizeTimestamp", () => {
  it("accepts numbers, Dates, numeric strings, and date strings", () => {
    expect(normalizeTimestamp(123)).toBe(123);
    expect(normalizeTimestamp(new Date(456))).toBe(456);
    expect(normalizeTimestamp("789")).toBe(789);
    expect(normalizeTimestamp("2026-01-01T00:00:00Z")).toBe(
      Date.parse("2026-01-01T00:00:00Z"),
    );
  });
  it("returns undefined for garbage", () => {
    expect(normalizeTimestamp("nope")).toBeUndefined();
    expect(normalizeTimestamp({})).toBeUndefined();
  });
});

describe("parseNullableNumber", () => {
  it("parses numbers and numeric strings, null for the rest", () => {
    expect(parseNullableNumber(5)).toBe(5);
    expect(parseNullableNumber("7")).toBe(7);
    expect(parseNullableNumber(null)).toBeNull();
    expect(parseNullableNumber("")).toBeNull();
    expect(parseNullableNumber("x")).toBeNull();
  });
});

describe("readTaskMetadata / normalizeTaskId", () => {
  it("reads metadata safely and normalizes ids", () => {
    expect(readTaskMetadata(task({ metadata: { a: 1 } }))).toEqual({ a: 1 });
    expect(readTaskMetadata(task({ metadata: null as never }))).toEqual({});
    expect(normalizeTaskId(task({ id: "x" }))).toBe("x");
    expect(normalizeTaskId(task({ id: "  " }))).toBeNull();
  });
});

describe("readTaskCompleted", () => {
  it("checks metadata and nested todo metadata", () => {
    expect(readTaskCompleted(task({ metadata: { isCompleted: true } }))).toBe(
      true,
    );
    expect(
      readTaskCompleted(
        task({ metadata: { workbenchTodo: { isCompleted: true } } }),
      ),
    ).toBe(true);
    expect(readTaskCompleted(task())).toBe(false);
  });
});

describe("isWorkbenchTodoTask", () => {
  it("detects todo tags and todo metadata", () => {
    expect(isWorkbenchTodoTask(task({ tags: ["workbench-todo"] }))).toBe(true);
    expect(isWorkbenchTodoTask(task({ tags: ["todo"] }))).toBe(true);
    expect(isWorkbenchTodoTask(task({ metadata: { todo: {} } }))).toBe(true);
    expect(isWorkbenchTodoTask(task({ tags: ["other"] }))).toBe(false);
  });
});

describe("toWorkbenchTodo", () => {
  it("builds a todo view with defaults", () => {
    const view = toWorkbenchTodo(task({ tags: ["todo"], name: "" }));
    expect(view).not.toBeNull();
    expect(view?.name).toBe("Todo");
    expect(view?.priority).toBeNull();
    expect(view?.type).toBe("task");
  });

  it("returns null for non-todo tasks", () => {
    expect(toWorkbenchTodo(task({ tags: ["other"] }))).toBeNull();
  });
});

describe("toWorkbenchTask", () => {
  it("builds a task view for workbench-task tags", () => {
    const view = toWorkbenchTask(task({ tags: ["workbench-task"] }));
    expect(view?.id).toBe("t1");
    expect(view?.updatedAt).toBe(1700000000000);
  });

  it("returns null without the task tag or for todo tasks", () => {
    expect(toWorkbenchTask(task({ tags: ["other"] }))).toBeNull();
    expect(
      toWorkbenchTask(task({ tags: ["workbench-task", "todo"] })),
    ).toBeNull();
  });
});

describe("normalizeTags", () => {
  it("merges with required tags and dedupes", () => {
    expect(normalizeTags(["a", "b"], ["b", " c "])).toEqual(["a", "b", "c"]);
  });
});
