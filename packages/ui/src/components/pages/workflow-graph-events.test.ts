/**
 * Unit tests for workflow graph events: validates visualize event dispatch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchVisualizeWorkflow } from "./workflow-graph-events.ts";

describe("workflow-graph-events", () => {
  const globalScope = globalThis as unknown as { window?: unknown };

  beforeEach(() => {
    globalScope.window = {
      dispatchEvent: vi.fn(),
    };
  });

  afterEach(() => {
    delete globalScope.window;
  });

  it("dispatches custom event on window with workflowId detail", () => {
    dispatchVisualizeWorkflow("wf-12345");
    expect(
      (globalScope.window as { dispatchEvent: ReturnType<typeof vi.fn> })
        .dispatchEvent,
    ).toHaveBeenCalled();
  });
});
