import { describe, expect, mock, test } from "bun:test";
import type { ModelType } from "@elizaos/core";
import { activateWorkflowAction } from "../../../workflow/actions/activateWorkflow";
import { deactivateWorkflowAction } from "../../../workflow/actions/deactivateWorkflow";
import { deleteWorkflowAction } from "../../../workflow/actions/deleteWorkflow";
import { N8N_WORKFLOW_SERVICE_TYPE } from "../../../workflow/services/n8n-workflow-service";
import { createMatchResult, createNoMatchResult } from "../../fixtures/workflows";
import {
  createMockCallback,
  createMockMessage,
  createMockRuntime,
  createMockState,
  getLastCallbackResult,
  getCallbackResultAt,
} from "../../helpers/mockRuntime";
import { createMockService } from "../../helpers/mockService";

function createRuntimeWithMatchingWorkflow(
  matchResult = createMatchResult(),
  serviceOverrides?: Record<string, unknown>
) {
  const mockService = createMockService(serviceOverrides);
  const useModel = mock((_type: ModelType, _params: unknown) => Promise.resolve(matchResult));
  return {
    runtime: createMockRuntime({
      services: { [N8N_WORKFLOW_SERVICE_TYPE]: mockService },
      useModel,
    }),
    service: mockService,
  };
}

function createStateWithWorkflows() {
  return createMockState({
    data: {
      workflows: [
        { id: "wf-001", name: "Stripe Payments", active: true },
        { id: "wf-002", name: "Gmail Notifications", active: false },
      ],
    },
  });
}

// ============================================================================
// ACTIVATE
// ============================================================================

describe("ACTIVATE_N8N_WORKFLOW action", () => {
  describe("validate", () => {
    test("returns true when service is available", async () => {
      const runtime = createMockRuntime({
        services: { [N8N_WORKFLOW_SERVICE_TYPE]: createMockService() },
      });
      const emptyMessage = createMockMessage({ content: { text: "" } });
      expect(await activateWorkflowAction.validate(runtime, emptyMessage)).toBe(true);
    });

    test("returns false when service is unavailable", async () => {
      const runtime = createMockRuntime();
      const emptyMessage = createMockMessage({ content: { text: "" } });
      expect(await activateWorkflowAction.validate(runtime, emptyMessage)).toBe(false);
    });
  });

  describe("handler", () => {
    test("activates matched workflow", async () => {
      const { runtime, service } = createRuntimeWithMatchingWorkflow();
      const message = createMockMessage({
        content: { text: "Activate the Stripe workflow" },
      });
      const callback = createMockCallback();

      const result = await activateWorkflowAction.handler(
        runtime,
        message,
        createStateWithWorkflows(),
        {},
        callback
      );

      expect(result.success).toBe(true);
      expect(service.activateWorkflow).toHaveBeenCalledWith("wf-001");
    });

    test("fails when no workflows available", async () => {
      const { runtime } = createRuntimeWithMatchingWorkflow(createMatchResult(), {
        listWorkflows: mock(() => Promise.resolve([])),
      });
      const message = createMockMessage({
        content: { text: "Activate something" },
      });
      const callback = createMockCallback();

      const result = await activateWorkflowAction.handler(
        runtime,
        message,
        createMockState(),
        {},
        callback
      );

      expect(result.success).toBe(false);
      const callText = getCallbackResultAt(callback, 0)?.text;
      expect(callText).toContain("No workflows available");
    });

    test("fails when no match found", async () => {
      const { runtime } = createRuntimeWithMatchingWorkflow(createNoMatchResult());
      const message = createMockMessage({
        content: { text: "Activate the unknown workflow" },
      });
      const callback = createMockCallback();

      const result = await activateWorkflowAction.handler(
        runtime,
        message,
        createStateWithWorkflows(),
        {},
        callback
      );

      expect(result.success).toBe(false);
    });

    test("handles service error", async () => {
      const { runtime } = createRuntimeWithMatchingWorkflow(createMatchResult(), {
        activateWorkflow: mock(() => Promise.reject(new Error("API error"))),
      });
      const message = createMockMessage({
        content: { text: "Activate Stripe" },
      });
      const callback = createMockCallback();

      const result = await activateWorkflowAction.handler(
        runtime,
        message,
        createStateWithWorkflows(),
        {},
        callback
      );

      expect(result.success).toBe(false);
    });
  });
});

// ============================================================================
// DEACTIVATE
// ============================================================================

describe("DEACTIVATE_N8N_WORKFLOW action", () => {
  test("deactivates matched workflow", async () => {
    const { runtime, service } = createRuntimeWithMatchingWorkflow();
    const message = createMockMessage({
      content: { text: "Pause the Stripe workflow" },
    });
    const callback = createMockCallback();

    const result = await deactivateWorkflowAction.handler(
      runtime,
      message,
      createStateWithWorkflows(),
      {},
      callback
    );

    expect(result.success).toBe(true);
    expect(service.deactivateWorkflow).toHaveBeenCalledWith("wf-001");
  });

  test("fails when no workflows available", async () => {
    const { runtime } = createRuntimeWithMatchingWorkflow(createMatchResult(), {
      listWorkflows: mock(() => Promise.resolve([])),
    });
    const callback = createMockCallback();

    const result = await deactivateWorkflowAction.handler(
      runtime,
      createMockMessage({ content: { text: "Stop it" } }),
      createMockState(),
      {},
      callback
    );

    expect(result.success).toBe(false);
  });
});

// ============================================================================
// DELETE
// ============================================================================

describe("DELETE_N8N_WORKFLOW action", () => {
  test("deletes matched workflow", async () => {
    const { runtime, service } = createRuntimeWithMatchingWorkflow();
    const message = createMockMessage({
      content: { text: "Delete the Stripe workflow" },
    });
    const callback = createMockCallback();

    const result = await deleteWorkflowAction.handler(
      runtime,
      message,
      createStateWithWorkflows(),
      {},
      callback
    );

    expect(result.success).toBe(true);
    expect(service.deleteWorkflow).toHaveBeenCalledWith("wf-001");
  });

  test("fails when no match", async () => {
    const { runtime } = createRuntimeWithMatchingWorkflow(createNoMatchResult());
    const callback = createMockCallback();

    const result = await deleteWorkflowAction.handler(
      runtime,
      createMockMessage({ content: { text: "Delete unknown" } }),
      createStateWithWorkflows(),
      {},
      callback
    );

    expect(result.success).toBe(false);
  });
});

// ============================================================================
// CALLBACK SUCCESS STATUS TESTS
// ============================================================================

describe("Callback success status", () => {
  test("activate success returns success: true in callback", async () => {
    const { runtime } = createRuntimeWithMatchingWorkflow();
    const callback = createMockCallback();

    await activateWorkflowAction.handler(
      runtime,
      createMockMessage({ content: { text: "Activate Stripe" } }),
      createStateWithWorkflows(),
      {},
      callback
    );

    const lastResult = getLastCallbackResult(callback);
    expect(lastResult?.success).toBe(true);
  });

  test("activate failure returns success: false in callback", async () => {
    const { runtime } = createRuntimeWithMatchingWorkflow(createMatchResult(), {
      activateWorkflow: mock(() => Promise.reject(new Error("API error"))),
    });
    const callback = createMockCallback();

    await activateWorkflowAction.handler(
      runtime,
      createMockMessage({ content: { text: "Activate Stripe" } }),
      createStateWithWorkflows(),
      {},
      callback
    );

    const lastResult = getLastCallbackResult(callback);
    expect(lastResult?.success).toBe(false);
  });

  test("deactivate success returns success: true in callback", async () => {
    const { runtime } = createRuntimeWithMatchingWorkflow();
    const callback = createMockCallback();

    await deactivateWorkflowAction.handler(
      runtime,
      createMockMessage({ content: { text: "Pause Stripe" } }),
      createStateWithWorkflows(),
      {},
      callback
    );

    const lastResult = getLastCallbackResult(callback);
    expect(lastResult?.success).toBe(true);
  });

  test("delete success returns success: true in callback", async () => {
    const { runtime } = createRuntimeWithMatchingWorkflow();
    const callback = createMockCallback();

    await deleteWorkflowAction.handler(
      runtime,
      createMockMessage({ content: { text: "Delete Stripe" } }),
      createStateWithWorkflows(),
      {},
      callback
    );

    const lastResult = getLastCallbackResult(callback);
    expect(lastResult?.success).toBe(true);
  });

  test("no workflows returns success: false in callback", async () => {
    const { runtime } = createRuntimeWithMatchingWorkflow(createMatchResult(), {
      listWorkflows: mock(() => Promise.resolve([])),
    });
    const callback = createMockCallback();

    await activateWorkflowAction.handler(
      runtime,
      createMockMessage({ content: { text: "Activate something" } }),
      createMockState(),
      {},
      callback
    );

    const lastResult = getLastCallbackResult(callback);
    expect(lastResult?.success).toBe(false);
  });

  test("no match returns success: false in callback", async () => {
    const { runtime } = createRuntimeWithMatchingWorkflow(createNoMatchResult());
    const callback = createMockCallback();

    await activateWorkflowAction.handler(
      runtime,
      createMockMessage({ content: { text: "Activate unknown" } }),
      createStateWithWorkflows(),
      {},
      callback
    );

    const lastResult = getLastCallbackResult(callback);
    expect(lastResult?.success).toBe(false);
  });
});
