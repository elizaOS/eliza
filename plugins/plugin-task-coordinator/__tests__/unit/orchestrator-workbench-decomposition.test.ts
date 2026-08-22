/**
 * Guards the physical ownership boundaries of the decomposed orchestrator workbench.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

function source(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../src/${relativePath}`, import.meta.url)),
    "utf8",
  );
}

function registeredAgentIds(text: string): string[] {
  const file = ts.createSourceFile(
    "fixture.tsx",
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const ids: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "useAgentElement" &&
      ts.isObjectLiteralExpression(node.arguments[0])
    ) {
      const id = node.arguments[0].properties.find(
        (property): property is ts.PropertyAssignment =>
          ts.isPropertyAssignment(property) &&
          ts.isIdentifier(property.name) &&
          property.name.text === "id",
      );
      if (id) ids.push(id.initializer.getText(file));
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return ids;
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

  it("keeps authority-changing controls out of direct agent activation", () => {
    const inspector = source("orchestrator-task-inspector.tsx");
    const workbench = source("OrchestratorWorkbench.tsx");
    const operator = source("orchestrator-operator-detail.tsx");
    const registered = registeredAgentIds(
      [inspector, workbench, operator].join("\n"),
    );
    for (const id of [
      "header-pause-all",
      "header-resume-all",
      "timeline-stop-active",
      "inspector-restart-edited-plan",
      "add-agent-spawn",
      "inspector-priority",
      "inspector-delete-confirm",
    ]) {
      expect(registered, id).not.toContain(`"${id}"`);
    }
    expect(registered.some((id) => id.includes("sub-agent-stop-"))).toBe(false);
    expect(inspector).toContain('data-agent-authority="human"');
    expect(operator).toContain('agentId="operator-retry-session"');
  });

  it("does not grant Task Coordinator generic DOM activation", () => {
    const index = source("index.ts");
    const declaration = index.slice(
      index.indexOf('id: "task-coordinator"'),
      index.indexOf('id: "orchestrator"'),
    );
    expect(declaration).not.toContain("agent-surface");
    expect(source("components/TaskCoordinatorSpatialView.tsx")).toContain(
      'authority: "human"',
    );
  });
});
