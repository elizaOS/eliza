import { describe, expect, it } from "vitest";
import { passesFilter } from "./automation-feed-filter";

describe("passesFilter", () => {
  it("'all' passes everything", () => {
    expect(passesFilter({ kind: "task", active: true }, "all")).toBe(true);
    expect(passesFilter({ kind: "workflow", active: false }, "all")).toBe(true);
  });

  it("'tasks' filters out workflows", () => {
    expect(passesFilter({ kind: "workflow", active: true }, "tasks")).toBe(
      false,
    );
    expect(passesFilter({ kind: "task", active: true }, "tasks")).toBe(true);
  });

  it("'workflows' filters out tasks", () => {
    expect(passesFilter({ kind: "task", active: true }, "workflows")).toBe(
      false,
    );
    expect(passesFilter({ kind: "workflow", active: true }, "workflows")).toBe(
      true,
    );
  });

  it("'active' / 'inactive' split on the active flag", () => {
    expect(passesFilter({ kind: "task", active: true }, "active")).toBe(true);
    expect(passesFilter({ kind: "task", active: false }, "active")).toBe(false);
    expect(passesFilter({ kind: "task", active: false }, "inactive")).toBe(
      true,
    );
  });
});
