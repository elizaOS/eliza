/**
 * Unit tests for WorkflowRunner - specifically state restoration edge cases
 */

import { WorkflowRunner, WorkflowState } from "../runner";
import { createStep } from "../step";
import { createWorkflow } from "../workflow";
import { z } from "zod";
import type { WorkflowContext } from "../types";

/**
 * Mock Desktop interface for unit tests.
 * Only includes methods used by the test steps.
 */
interface MockDesktop {
  locator: ReturnType<typeof jest.fn>;
  openApplication: ReturnType<typeof jest.fn>;
  delay: ReturnType<typeof jest.fn>;
}

// Mock Desktop
const mockDesktop: MockDesktop = {
  locator: jest.fn(),
  openApplication: jest.fn(),
  delay: jest.fn(),
};

/**
 * Type for testing corrupted/invalid WorkflowState.
 * Used to test edge cases where state may be malformed.
 */
type CorruptedWorkflowState = {
  stepResults: Record<string, { status: string; result?: unknown }>;
  lastStepIndex: number;
  context: WorkflowContext | undefined | null | Partial<WorkflowContext>;
};

// Simple workflow for testing
const simpleWorkflow = createWorkflow({
  input: z.object({}),
  steps: [
    createStep({
      id: "step1",
      name: "Step 1",
      execute: async () => ({ state: { done: true } }),
    }),
  ],
});

describe("WorkflowRunner", () => {
  describe("state restoration", () => {
    test("handles restoredState with undefined context gracefully", () => {
      // This tests the fix for: "undefined is not an object (evaluating 'restored.data')"
      // When restoredState exists but context is undefined (stale/corrupted state)
      const restoredState: CorruptedWorkflowState = {
        stepResults: {},
        lastStepIndex: 0,
        context: undefined, // Simulates corrupted/stale state
      };

      // Should not throw
      expect(() => {
        new WorkflowRunner({
          workflow: simpleWorkflow,
          inputs: {},
          restoredState: restoredState as unknown as WorkflowState,
        });
      }).not.toThrow();
    });

    test("handles restoredState with null context gracefully", () => {
      const restoredState: CorruptedWorkflowState = {
        stepResults: {},
        lastStepIndex: 0,
        context: null,
      };

      expect(() => {
        new WorkflowRunner({
          workflow: simpleWorkflow,
          inputs: {},
          restoredState: restoredState as unknown as WorkflowState,
        });
      }).not.toThrow();
    });

    test("handles restoredState with empty context object", () => {
      const restoredState: CorruptedWorkflowState = {
        stepResults: {},
        lastStepIndex: 0,
        context: {}, // Empty context (missing data, state, variables)
      };

      expect(() => {
        new WorkflowRunner({
          workflow: simpleWorkflow,
          inputs: {},
          restoredState: restoredState as unknown as WorkflowState,
        });
      }).not.toThrow();
    });

    test("properly restores valid context", () => {
      const restoredState: CorruptedWorkflowState = {
        stepResults: { step1: { status: "success", result: { foo: "bar" } } },
        lastStepIndex: 0,
        context: {
          data: { existingData: true },
          state: { existingState: true },
          variables: { existingVar: "value" },
        },
      };

      const runner = new WorkflowRunner({
        workflow: simpleWorkflow,
        inputs: { newInput: "test" },
        restoredState: restoredState as unknown as WorkflowState,
      });

      // Runner should be created successfully
      expect(runner).toBeDefined();
    });
  });
});
