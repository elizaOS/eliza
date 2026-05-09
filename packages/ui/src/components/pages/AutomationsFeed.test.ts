import { describe, expect, it } from "vitest";
import { passesFilter } from "./AutomationsFeed";

const baseRow = {
  key: "k",
  title: "t",
  schedule: null,
  status: "active",
  lastUpdated: null,
  source: {} as never,
};

describe("passesFilter", () => {
  it("'all' passes everything", () => {
    expect(
      passesFilter(
        { ...baseRow, kind: "task", active: true },
        "all",
      ),
    ).toBe(true);
  });

  it("'tasks' filters out workflows", () => {
    expect(
      passesFilter({ ...baseRow, kind: "workflow", active: true }, "tasks"),
    ).toBe(false);
    expect(
      passesFilter({ ...baseRow, kind: "task", active: true }, "tasks"),
    ).toBe(true);
  });

  it("'workflows' filters out tasks", () => {
    expect(
      passesFilter({ ...baseRow, kind: "task", active: true }, "workflows"),
    ).toBe(false);
  });

  it("'active' / 'inactive' split on enabled flag", () => {
    expect(
      passesFilter({ ...baseRow, kind: "task", active: true }, "active"),
    ).toBe(true);
    expect(
      passesFilter({ ...baseRow, kind: "task", active: false }, "active"),
    ).toBe(false);
    expect(
      passesFilter({ ...baseRow, kind: "task", active: false }, "inactive"),
    ).toBe(true);
  });
});
