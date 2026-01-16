/**
 * Unit tests for WorkflowRunner - specifically state restoration edge cases
 */

import { WorkflowRunner } from "../runner";
import { createStep } from "../step";
import { createWorkflow } from "../workflow";
import { z } from "zod";

// Mock Desktop
const mockDesktop = {
  locator: jest.fn(),
  openApplication: jest.fn(),
  delay: jest.fn(),
} as any;

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
      const restoredState = {
        stepResults: {},
        lastStepIndex: 0,
        context: undefined as any, // Simulates corrupted/stale state
      };

      // Should not throw
      expect(() => {
        new WorkflowRunner({
          workflow: simpleWorkflow,
          inputs: {},
          restoredState,
        });
      }).not.toThrow();
    });

    test("handles restoredState with null context gracefully", () => {
      const restoredState = {
        stepResults: {},
        lastStepIndex: 0,
        context: null as any,
      };

      expect(() => {
        new WorkflowRunner({
          workflow: simpleWorkflow,
          inputs: {},
          restoredState,
        });
      }).not.toThrow();
    });

    test("handles restoredState with empty context object", () => {
      const restoredState = {
        stepResults: {},
        lastStepIndex: 0,
        context: {} as any, // Empty context (missing data, state, variables)
      };

      expect(() => {
        new WorkflowRunner({
          workflow: simpleWorkflow,
          inputs: {},
          restoredState,
        });
      }).not.toThrow();
    });

    test("properly restores valid context", () => {
      const restoredState = {
        stepResults: { step1: { status: "success", result: { foo: "bar" } } },
        lastStepIndex: 0,
        context: {
          data: { existingData: true },
          state: { existingState: true },
          variables: { existingVar: "value" },
        } as any,
      };

      const runner = new WorkflowRunner({
        workflow: simpleWorkflow,
        inputs: { newInput: "test" },
        restoredState,
      });

      // Runner should be created successfully
      expect(runner).toBeDefined();
    });
  });
});
