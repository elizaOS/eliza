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

  it("dedupes within the value itself when no required tags are given", () => {
    expect(normalizeTags(["a", "a", " b "])).toEqual(["a", "b"]);
  });

  it("trims required entries and drops blank ones", () => {
    expect(normalizeTags([], [" x ", ""])).toEqual(["x"]);
  });
});

describe("asObject edge inputs", () => {
  it("rejects undefined, zero, false, and strings", () => {
    expect(asObject(undefined)).toBeNull();
    expect(asObject(0)).toBeNull();
    expect(asObject(false)).toBeNull();
    expect(asObject("text")).toBeNull();
  });
});

describe("normalizeStringArray edge inputs", () => {
  it("returns empty output for empty or fully invalid arrays", () => {
    expect(normalizeStringArray([])).toEqual([]);
    expect(normalizeStringArray([1, null, { size: 2 }])).toEqual([]);
  });
});

describe("normalizeTimestamp edge inputs", () => {
  it("rejects non-finite numbers and booleans", () => {
    expect(normalizeTimestamp(Number.NaN)).toBeUndefined();
    expect(normalizeTimestamp(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(normalizeTimestamp(true)).toBeUndefined();
  });
});

describe("parseNullableNumber edge inputs", () => {
  it("returns null for undefined, non-finite numbers, and booleans", () => {
    expect(parseNullableNumber(undefined)).toBeNull();
    expect(parseNullableNumber(Number.NaN)).toBeNull();
    expect(parseNullableNumber(true)).toBeNull();
  });
});

describe("readTaskCompleted precedence", () => {
  it("honors an explicit false without falling through to nested todos", () => {
    expect(readTaskCompleted(task({ metadata: { isCompleted: false } }))).toBe(
      false,
    );
  });

  it("falls back to plain todo metadata for completion state", () => {
    expect(
      readTaskCompleted(task({ metadata: { todo: { isCompleted: true } } })),
    ).toBe(true);
  });

  it("ignores a non-boolean flag and reads the nested todo flag instead", () => {
    expect(
      readTaskCompleted(
        task({
          metadata: {
            isCompleted: "yes",
            workbenchTodo: { isCompleted: false },
          },
        }),
      ),
    ).toBe(false);
  });
});

describe("isWorkbenchTodoTask trigger guard", () => {
  it("excludes trigger-configured tasks even when tagged as todos", () => {
    expect(
      isWorkbenchTodoTask(
        task({
          tags: ["workbench-todo"],
          metadata: {
            trigger: {
              kind: "prompt",
              version: 1,
              triggerId: "trg-1",
              displayName: "Test trigger",
              instructions: "check the calendar",
              triggerType: "interval",
              enabled: true,
              wakeMode: "next_autonomy_cycle",
              createdBy: "test-suite",
              runCount: 0,
            },
          },
        }),
      ),
    ).toBe(false);
  });

  it("keeps todo tasks whose trigger entry has no usable triggerId", () => {
    expect(
      isWorkbenchTodoTask(
        task({
          tags: ["todo"],
          metadata: {
            trigger: {
              kind: "prompt",
              version: 1,
              triggerId: "",
              displayName: "Unidentified trigger",
              instructions: "check the calendar",
              triggerType: "interval",
              enabled: true,
              wakeMode: "next_autonomy_cycle",
              createdBy: "test-suite",
              runCount: 0,
            },
          },
        }),
      ),
    ).toBe(true);
  });

  it("detects workbenchTodo metadata objects", () => {
    expect(isWorkbenchTodoTask(task({ metadata: { workbenchTodo: {} } }))).toBe(
      true,
    );
  });
});

describe("toWorkbenchTodo view construction", () => {
  it("builds the complete view from workbenchTodo metadata", () => {
    const view = toWorkbenchTodo(
      task({
        id: "td-9",
        name: "File taxes",
        description: "task-level description",
        tags: ["workbench-todo"],
        createdAt: 1700000000000,
        updatedAt: 1700000005000,
        metadata: {
          workbenchTodo: {
            description: "from todo meta",
            priority: "2",
            isUrgent: true,
            type: "errand",
          },
        },
      }),
    );
    expect(view).toEqual({
      id: "td-9",
      name: "File taxes",
      description: "from todo meta",
      priority: 2,
      isUrgent: true,
      isCompleted: false,
      type: "errand",
      tags: ["workbench-todo"],
      createdAt: "2023-11-14T22:13:20.000Z",
      updatedAt: "2023-11-14T22:13:25.000Z",
    });
  });

  it("falls back to the task description, defaults urgency, and nulls a cleared updatedAt", () => {
    const view = toWorkbenchTodo(
      task({
        id: "td-10",
        tags: ["todo"],
        description: "task-level description",
        updatedAt: undefined,
        metadata: { todo: {} },
      }),
    );
    expect(view?.description).toBe("task-level description");
    expect(view?.isUrgent).toBe(false);
    expect(view?.createdAt).toBe("2023-11-14T22:13:20.000Z");
    expect(view?.updatedAt).toBeNull();
  });

  it("drops todo tasks without a usable id", () => {
    expect(toWorkbenchTodo(task({ id: "   ", tags: ["todo"] }))).toBeNull();
  });

  it("drops trigger-configured tasks", () => {
    expect(
      toWorkbenchTodo(
        task({
          tags: ["todo"],
          metadata: {
            trigger: {
              kind: "prompt",
              version: 1,
              triggerId: "trg-2",
              displayName: "Test trigger",
              instructions: "check the calendar",
              triggerType: "interval",
              enabled: true,
              wakeMode: "next_autonomy_cycle",
              createdBy: "test-suite",
              runCount: 0,
            },
          },
        }),
      ),
    ).toBeNull();
  });
});

describe("toWorkbenchTask view construction", () => {
  it("falls back to metadata.updatedAt when the record lacks its own", () => {
    const view = toWorkbenchTask(
      task({
        id: "tw-1",
        tags: ["workbench-task"],
        updatedAt: undefined,
        metadata: { updatedAt: 1700000009000 },
      }),
    );
    expect(view?.updatedAt).toBe(1700000009000);
  });

  it("omits updatedAt entirely when neither source provides one", () => {
    const view = toWorkbenchTask(
      task({
        id: "tw-2",
        tags: ["workbench-task"],
        updatedAt: undefined,
      }),
    );
    expect(view).not.toBeNull();
    expect("updatedAt" in (view as object)).toBe(false);
  });

  it("defaults an empty name and a missing description", () => {
    const view = toWorkbenchTask(
      task({
        id: "tw-3",
        name: "",
        description: undefined,
        tags: ["workbench-task"],
      }),
    );
    expect(view?.name).toBe("Task");
    expect(view?.description).toBe("");
  });

  it("drops tasks carrying a trigger configuration", () => {
    expect(
      toWorkbenchTask(
        task({
          tags: ["workbench-task"],
          metadata: {
            trigger: {
              kind: "prompt",
              version: 1,
              triggerId: "trg-3",
              displayName: "Test trigger",
              instructions: "check the calendar",
              triggerType: "interval",
              enabled: true,
              wakeMode: "next_autonomy_cycle",
              createdBy: "test-suite",
              runCount: 0,
            },
          },
        }),
      ),
    ).toBeNull();
  });

  it("drops tasks without a usable id", () => {
    expect(
      toWorkbenchTask(task({ id: "", tags: ["workbench-task"] })),
    ).toBeNull();
  });
});
