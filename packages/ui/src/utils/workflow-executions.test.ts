/**
 * Unit coverage for workflow-execution diagnostics/formatting (engine metrics,
 * duration, run rows). Pure functions, no harness.
 */
import { describe, expect, it } from "vitest";
import type { WorkflowExecution } from "../api/client-types-chat";
import {
  buildWorkflowExecutionDiagnostics,
  formatWorkflowEngineMetrics,
  formatWorkflowExecutionDuration,
  getWorkflowExecutionError,
  getWorkflowExecutionRunRows,
  summarizeWorkflowExecution,
} from "./workflow-executions";

const SUCCESS_EXECUTION: WorkflowExecution = {
  id: "exec-1",
  workflowId: "wf-1",
  status: "success",
  startedAt: "2026-06-19T12:00:00.000Z",
  stoppedAt: "2026-06-19T12:00:01.250Z",
  mode: "manual",
  data: {
    resultData: {
      engine: {
        provider: "smithers",
        nodes: 2,
        levels: 2,
        maxConcurrency: 1,
        started: 2,
        finished: 2,
        failed: 0,
        skipped: 0,
        retries: 1,
      },
      lastNodeExecuted: "Set",
      runData: {
        Trigger: [
          {
            data: {
              main: [[{ json: { source: "manual" } }]],
            },
            executionTime: 3,
          },
        ],
        Set: [
          {
            data: {
              main: [[{ json: { ok: true } }, { json: { ok: false } }]],
            },
            executionTime: 7,
          },
        ],
      },
    },
  },
};

describe("workflow execution helpers", () => {
  it("summarizes success executions and counts node output", () => {
    const summary = summarizeWorkflowExecution(SUCCESS_EXECUTION);
    const rows = getWorkflowExecutionRunRows(SUCCESS_EXECUTION);

    expect(summary.statusLabel).toBe("Succeeded");
    expect(summary.tone).toBe("success");
    expect(summary.durationLabel).toBe("1.3 s");
    expect(summary.nodeCount).toBe(2);
    expect(summary.lastNode).toBe("Set");
    expect(rows.map((row) => row.nodeName)).toEqual(["Trigger", "Set"]);
    expect(rows[1].itemCount).toBe(2);
    expect(rows[1].preview).toContain('"ok":true');
    expect(formatWorkflowEngineMetrics(SUCCESS_EXECUTION)).toBe(
      "2 nodes / 2 levels / 1 max parallel / 1 retries",
    );
  });

  it("surfaces top-level and per-node errors", () => {
    const execution: WorkflowExecution = {
      id: "exec-2",
      workflowId: "wf-1",
      status: "error",
      startedAt: "2026-06-19T12:00:00.000Z",
      stoppedAt: "2026-06-19T12:00:00.050Z",
      data: {
        resultData: {
          error: { message: "HTTP request failed" },
          runData: {
            "HTTP Request": [
              {
                error: { message: "500 Server Error" },
                data: { main: [[]] },
              },
            ],
          },
        },
      },
    };

    expect(getWorkflowExecutionError(execution)).toBe("HTTP request failed");
    expect(summarizeWorkflowExecution(execution).tone).toBe("danger");
    expect(getWorkflowExecutionRunRows(execution)[0].error).toBe(
      "500 Server Error",
    );
  });

  it("formats short and long durations", () => {
    expect(
      formatWorkflowExecutionDuration(
        "2026-06-19T12:00:00.000Z",
        "2026-06-19T12:00:00.099Z",
      ),
    ).toBe("99 ms");
    expect(
      formatWorkflowExecutionDuration(
        "2026-06-19T12:00:00.000Z",
        "2026-06-19T12:03:02.000Z",
      ),
    ).toBe("3 min");
  });

  it("builds copyable diagnostics for chat-assisted troubleshooting", () => {
    const diagnostics = buildWorkflowExecutionDiagnostics(SUCCESS_EXECUTION);

    expect(diagnostics).toContain("Workflow execution exec-1");
    expect(diagnostics).toContain("Status: Succeeded");
    expect(diagnostics).toContain("Last node: Set");
    expect(diagnostics).toContain(
      "Engine: 2 nodes / 2 levels / 1 max parallel / 1 retries",
    );
    expect(diagnostics).toContain("- Set: success; 2 items; 7 ms;");
    expect(diagnostics).toContain('preview={"ok":true}');
  });
});
