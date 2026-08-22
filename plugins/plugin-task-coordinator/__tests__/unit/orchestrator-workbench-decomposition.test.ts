/**
 * Guards the physical ownership boundaries of the decomposed orchestrator workbench.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function source(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../src/${relativePath}`, import.meta.url)),
    "utf8",
  );
}

describe("OrchestratorWorkbench module boundaries", () => {
  it("keeps live coordination separate from inspector and operator rendering", () => {
    const workbench = source("OrchestratorWorkbench.tsx");
    expect(workbench.split("\n").length).toBeLessThanOrEqual(1_200);
    expect(workbench).toContain('from "./orchestrator-task-inspector"');
    expect(workbench).toContain('from "./orchestrator-operator-detail"');
    expect(workbench).toContain('from "./orchestrator-workbench-list"');
    expect(workbench).not.toContain("function TaskInspector(");
    expect(workbench).not.toContain("function OperatorDetailDrawer(");
    expect(workbench).not.toContain("function FilterSelect(");
  });

  it("keeps each extracted domain behind an explicit export boundary", () => {
    expect(source("orchestrator-task-inspector.tsx")).toContain(
      "export function TaskInspector(",
    );
    expect(source("orchestrator-operator-detail.tsx")).toContain(
      "export function OperatorDetailDrawer(",
    );
    expect(source("orchestrator-workbench-list.tsx")).toContain(
      "export function FilterSelect(",
    );
  });
});
