// @vitest-environment jsdom

/**
 * jsdom tests for the workflow action-handoff helpers: `findWorkflowIdForActionHandoff`
 * (resolving the target workflow from a chat action result) and
 * `dispatchWorkflowActionHandoff` (emitting the handoff event).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatActionResultSummary } from "../../api/client-types-chat";
import {
  dispatchWorkflowActionHandoff,
  findWorkflowIdForActionHandoff,
} from "./workflow-action-handoff";
import { VISUALIZE_WORKFLOW_EVENT } from "./workflow-graph-events";

describe("workflow action handoff", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("selects the latest successful workflow id from streamed action summaries", () => {
    const actionResults: ChatActionResultSummary[] = [
      {
        actionName: "WORKFLOW",
        success: true,
        values: { workflowId: "workflow-old" },
      },
      {
        actionName: "WORKFLOW",
        success: false,
        values: { workflowId: "workflow-failed" },
      },
      {
        actionName: "WORKFLOW",
        success: true,
        values: { workflowId: "workflow-new" },
      },
    ];

    expect(findWorkflowIdForActionHandoff(actionResults)).toBe("workflow-new");
  });

  it("dispatches the existing visualize workflow event", () => {
    const events: CustomEvent[] = [];
    const handler = (event: Event) => events.push(event as CustomEvent);
    window.addEventListener(VISUALIZE_WORKFLOW_EVENT, handler);

    const dispatched = dispatchWorkflowActionHandoff([
      {
        actionName: "WORKFLOW",
        success: true,
        values: { workflowId: "workflow-1" },
      },
    ]);

    window.removeEventListener(VISUALIZE_WORKFLOW_EVENT, handler);
    expect(dispatched).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0].detail).toEqual({ workflowId: "workflow-1" });
  });
});
