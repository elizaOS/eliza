import { describe, expect, mock, test } from "bun:test";
import { createWorkflowAction } from "../../../workflow/actions/createWorkflow";
import { N8N_WORKFLOW_SERVICE_TYPE } from "../../../workflow/services/n8n-workflow-service";
import type { WorkflowDraft } from "../../../workflow/types/index";
import {
  createMockCallback,
  createMockMessage,
  createMockRuntime,
  createMockState,
  createUseModelMock,
  getLastCallbackResult,
  getAllCallbackResults,
  getCallbackCallCount,
} from "../../helpers/mockRuntime";
import { createMockService } from "../../helpers/mockService";

describe("CREATE_N8N_WORKFLOW action", () => {
  describe("validate", () => {
    test("returns true when service is available", async () => {
      const runtime = createMockRuntime({
        services: { [N8N_WORKFLOW_SERVICE_TYPE]: createMockService() },
      });
      const emptyMessage = createMockMessage({ content: { text: "" } });
      const result = await createWorkflowAction.validate(runtime, emptyMessage);
      expect(result).toBe(true);
    });

    test("returns false when service is unavailable", async () => {
      const runtime = createMockRuntime();
      const emptyMessage = createMockMessage({ content: { text: "" } });
      const result = await createWorkflowAction.validate(runtime, emptyMessage);
      expect(result).toBe(false);
    });
  });

  describe("handler - new workflow (no draft)", () => {
    test("generates draft and shows preview", async () => {
      const mockService = createMockService();
      const runtime = createMockRuntime({
        services: { [N8N_WORKFLOW_SERVICE_TYPE]: mockService },
      });
      const message = createMockMessage({
        content: {
          text: "Create a workflow that sends Stripe summaries via Gmail",
        },
      });
      const callback = createMockCallback();

      const result = await createWorkflowAction.handler(
        runtime,
        message,
        createMockState(),
        {},
        callback
      );

      expect(result?.success).toBe(true);
      expect(result?.data).toEqual({ awaitingUserInput: true });
      expect(mockService.generateWorkflowDraft).toHaveBeenCalledTimes(1);
      expect(mockService.deployWorkflow).not.toHaveBeenCalled();

      // Callback called with LLM-formatted text containing workflow data
      expect(getCallbackCallCount(callback)).toBeGreaterThan(0);
      const lastText = getLastCallbackResult(callback)?.text;
      expect(lastText).toContain("Generated Workflow"); // workflow name in data
      expect(lastText).toContain("scheduleTrigger"); // node type in data

      // Should store draft in cache
      expect(runtime.setCache).toHaveBeenCalled();
    });

    test("shows clarification when LLM flags requiresClarification", async () => {
      const mockService = createMockService({
        generateWorkflowDraft: mock(() =>
          Promise.resolve({
            name: "Vague Workflow",
            nodes: [
              {
                name: "Start",
                type: "n8n-nodes-base.start",
                typeVersion: 1,
                position: [0, 0],
                parameters: {},
              },
            ],
            connections: {},
            _meta: {
              assumptions: [],
              suggestions: [],
              requiresClarification: [
                "What specific task would you like to automate?",
                "Which services should be connected?",
              ],
            },
          })
        ),
      });

      const runtime = createMockRuntime({
        services: { [N8N_WORKFLOW_SERVICE_TYPE]: mockService },
      });
      const message = createMockMessage({
        content: { text: "automate my business" },
      });
      const callback = createMockCallback();

      const result = await createWorkflowAction.handler(
        runtime,
        message,
        createMockState(),
        {},
        callback
      );

      expect(result?.success).toBe(true);
      expect(result?.data).toEqual({ awaitingUserInput: true });
      const lastResult = getLastCallbackResult(callback);
      // Clarification questions should be in the data passed to the LLM
      expect(lastResult?.text).toContain("What specific task");
      expect(lastText).toContain("Which services");
    });

    test("fails when prompt is empty", async () => {
      const runtime = createMockRuntime({
        services: { [N8N_WORKFLOW_SERVICE_TYPE]: createMockService() },
      });
      const message = createMockMessage({ content: { text: "" } });
      const callback = createMockCallback();

      const result = await createWorkflowAction.handler(
        runtime,
        message,
        createMockState(),
        {},
        callback
      );

      expect(result?.success).toBe(false);
      // Callback should be called (LLM formats EMPTY_PROMPT response)
      expect(getCallbackCallCount(callback)).toBeGreaterThan(0);
    });

    test("fails when service is unavailable", async () => {
      const runtime = createMockRuntime();
      const message = createMockMessage({
        content: { text: "Create a workflow" },
      });
      const callback = createMockCallback();

      const result = await createWorkflowAction.handler(
        runtime,
        message,
        createMockState(),
        {},
        callback
      );

      expect(result?.success).toBe(false);
    });

    test("handles service error gracefully", async () => {
      const mockService = createMockService({
        generateWorkflowDraft: mock(() => Promise.reject(new Error("LLM generation failed"))),
      });
      const runtime = createMockRuntime({
        services: { [N8N_WORKFLOW_SERVICE_TYPE]: mockService },
      });
      const message = createMockMessage({
        content: { text: "Create a workflow" },
      });
      const callback = createMockCallback();

      const result = await createWorkflowAction.handler(
        runtime,
        message,
        createMockState(),
        {},
        callback
      );

      expect(result?.success).toBe(false);
      const errorText = getLastCallbackResult(callback)?.text;
      expect(errorText).toContain("LLM generation failed");
    });
  });

  describe("handler - existing draft", () => {
    function createDraftInCache(): WorkflowDraft {
      return {
        workflow: {
          name: "Stripe Gmail Summary",
          nodes: [
            {
              name: "Schedule Trigger",
              type: "n8n-nodes-base.scheduleTrigger",
              typeVersion: 1,
              position: [0, 0] as [number, number],
              parameters: {},
            },
            {
              name: "Gmail",
              type: "n8n-nodes-base.gmail",
              typeVersion: 2,
              position: [200, 0] as [number, number],
              parameters: { operation: "send" },
              credentials: {
                gmailOAuth2Api: { id: "{{CREDENTIAL_ID}}", name: "Gmail Account" },
              },
            },
          ],
          connections: {
            "Schedule Trigger": {
              main: [[{ node: "Gmail", type: "main", index: 0 }]],
            },
          },
        },
        prompt: "Send Stripe summaries via Gmail",
        userId: "user-001",
        createdAt: Date.now(),
      };
    }

    test("deploys workflow on confirm intent", async () => {
      const draft = createDraftInCache();
      const mockService = createMockService();

      const runtime = createMockRuntime({
        services: { [N8N_WORKFLOW_SERVICE_TYPE]: mockService },
        useModel: createUseModelMock({ intent: "confirm", reason: "User agreed to deploy" }),
        cache: { "workflow_draft:user-001": draft },
      });

      const message = createMockMessage({
        content: { text: "Yes, deploy it" },
      });
      const callback = createMockCallback();

      const result = await createWorkflowAction.handler(
        runtime,
        message,
        createMockState(),
        {},
        callback
      );

      expect(result?.success).toBe(true);
      expect(result?.data).toBeDefined();
      expect(mockService.deployWorkflow).toHaveBeenCalledTimes(1);
      expect(mockService.generateWorkflowDraft).not.toHaveBeenCalled();

      // Should clear cache
      expect(runtime.deleteCache).toHaveBeenCalled();

      // Should show deployment data in callback
      const lastText = getLastCallbackResult(callback)?.text;
      expect(lastText).toContain("wf-001"); // workflow ID
      expect(lastText).toContain("Generated Workflow"); // workflow name
    });

    test("cancels draft on cancel intent", async () => {
      const draft = createDraftInCache();

      const runtime = createMockRuntime({
        services: { [N8N_WORKFLOW_SERVICE_TYPE]: createMockService() },
        useModel: createUseModelMock({ intent: "cancel", reason: "User rejected" }),
        cache: { "workflow_draft:user-001": draft },
      });

      const message = createMockMessage({
        content: { text: "No, cancel it" },
      });
      const callback = createMockCallback();

      const result = await createWorkflowAction.handler(
        runtime,
        message,
        createMockState(),
        {},
        callback
      );

      expect(result?.success).toBe(true);
      expect(runtime.deleteCache).toHaveBeenCalled();

      // Callback called with cancelled response containing workflow name
      const lastText = getLastCallbackResult(callback)?.text;
      expect(lastText).toContain("Stripe Gmail Summary");
    });

    test("modifies draft using existing workflow on modify intent", async () => {
      const draft = createDraftInCache();
      const mockService = createMockService();

      const runtime = createMockRuntime({
        services: { [N8N_WORKFLOW_SERVICE_TYPE]: mockService },
        useModel: createUseModelMock({
          intent: "modify",
          modificationRequest: "Use Outlook instead of Gmail",
          reason: "User wants different email service",
        }),
        cache: { "workflow_draft:user-001": draft },
      });

      const message = createMockMessage({
        content: { text: "Use Outlook instead of Gmail" },
      });
      const callback = createMockCallback();

      const result = await createWorkflowAction.handler(
        runtime,
        message,
        createMockState(),
        {},
        callback
      );

      expect(result?.success).toBe(true);
      expect(result?.data).toEqual({ awaitingUserInput: true });
      // Should call modifyWorkflowDraft (hybrid), NOT generateWorkflowDraft (from scratch)
      expect(mockService.modifyWorkflowDraft).toHaveBeenCalledTimes(1);
      expect(mockService.generateWorkflowDraft).not.toHaveBeenCalled();
      expect(mockService.deployWorkflow).not.toHaveBeenCalled();

      // Should pass existing workflow + modification request
      expect(mockService.modifyWorkflowDraft).toHaveBeenCalledWith(
        draft.workflow, // existing workflow
        "Use Outlook instead of Gmail" // modification
      );

      // Should show preview with modified workflow data
      const lastText = getLastCallbackResult(callback)?.text;
      expect(lastText).toContain("Modified Workflow"); // modified workflow name

      // Should store updated draft in cache
      expect(runtime.setCache).toHaveBeenCalled();
    });

    test("expired draft is cleared and treated as new", async () => {
      const draft = createDraftInCache();
      draft.createdAt = Date.now() - 31 * 60 * 1000;

      const mockService = createMockService();
      const runtime = createMockRuntime({
        services: { [N8N_WORKFLOW_SERVICE_TYPE]: mockService },
        cache: { "workflow_draft:user-001": draft },
      });

      const message = createMockMessage({
        content: { text: "Create a new workflow" },
      });
      const callback = createMockCallback();

      await createWorkflowAction.handler(runtime, message, createMockState(), {}, callback);

      expect(mockService.generateWorkflowDraft).toHaveBeenCalledTimes(1);
      expect(runtime.deleteCache).toHaveBeenCalled();
    });

    test("new intent with vague message restores draft on generation failure", async () => {
      const draft = createDraftInCache();
      const mockService = createMockService({
        generateWorkflowDraft: mock(() => Promise.reject(new Error("No relevant n8n nodes found"))),
      });

      const runtime = createMockRuntime({
        services: { [N8N_WORKFLOW_SERVICE_TYPE]: mockService },
        useModel: createUseModelMock({ intent: "new", reason: "User wants a different workflow" }),
        cache: { "workflow_draft:user-001": draft },
      });

      const message = createMockMessage({
        content: { text: "do something" },
      });
      const callback = createMockCallback();

      const result = await createWorkflowAction.handler(
        runtime,
        message,
        createMockState(),
        {},
        callback
      );

      expect(result?.success).toBe(true);
      expect(result?.data).toEqual({ awaitingUserInput: true });

      // Draft should be restored in cache
      expect(runtime.setCache).toHaveBeenCalled();

      // Should show the original draft data in the restored preview
      const lastText = getLastCallbackResult(callback)?.text;
      expect(lastText).toContain("Stripe Gmail Summary");
    });

    test("overrides confirm to modify when draft has pending clarifications", async () => {
      const draft = createDraftInCache();
      draft.workflow._meta = {
        assumptions: [],
        suggestions: [],
        requiresClarification: ["Which email address should receive the summary?"],
      };

      const mockService = createMockService();

      const runtime = createMockRuntime({
        services: { [N8N_WORKFLOW_SERVICE_TYPE]: mockService },
        useModel: createUseModelMock({ intent: "confirm", reason: "User said yes" }),
        cache: { "workflow_draft:user-001": draft },
      });

      const message = createMockMessage({
        content: { text: "Use john@example.com" },
      });
      const callback = createMockCallback();

      const result = await createWorkflowAction.handler(
        runtime,
        message,
        createMockState(),
        {},
        callback
      );

      expect(result?.success).toBe(true);
      // Should call modifyWorkflowDraft (override confirm → modify), NOT deployWorkflow
      expect(mockService.modifyWorkflowDraft).toHaveBeenCalledTimes(1);
      expect(mockService.deployWorkflow).not.toHaveBeenCalled();
    });

    test("blocks deploy when credentials are missing (no auth URL)", async () => {
      const draft = createDraftInCache();
      const mockService = createMockService({
        deployWorkflow: mock(() =>
          Promise.resolve({
            id: "wf-001",
            name: "Test",
            active: false,
            nodeCount: 2,
            missingCredentials: [{ credType: "gmailOAuth2Api" }, { credType: "stripeApi" }],
          })
        ),
      });

      const runtime = createMockRuntime({
        services: { [N8N_WORKFLOW_SERVICE_TYPE]: mockService },
        useModel: createUseModelMock({ intent: "confirm", reason: "User confirmed" }),
        cache: { "workflow_draft:user-001": draft },
      });

      const message = createMockMessage({
        content: { text: "Deploy it" },
      });
      const callback = createMockCallback();

      await createWorkflowAction.handler(runtime, message, createMockState(), {}, callback);

      const resultText = getLastCallbackResult(callback)?.text;
      expect(resultText).toContain("gmailOAuth2Api");
      expect(resultText).toContain("stripeApi");
    });

    test("blocks deploy and shows auth links when credentials need authentication", async () => {
      const draft = createDraftInCache();
      const mockService = createMockService({
        deployWorkflow: mock(() =>
          Promise.resolve({
            id: "",
            name: "Stripe Gmail Summary",
            active: false,
            nodeCount: 2,
            missingCredentials: [
              { credType: "gmailOAuth2Api", authUrl: "https://auth.example.com/gmail" },
              { credType: "stripeApi", authUrl: "https://auth.example.com/stripe" },
            ],
          })
        ),
      });

      const runtime = createMockRuntime({
        services: { [N8N_WORKFLOW_SERVICE_TYPE]: mockService },
        useModel: createUseModelMock({ intent: "confirm", reason: "User confirmed" }),
        cache: { "workflow_draft:user-001": draft },
      });

      const message = createMockMessage({
        content: { text: "Deploy it" },
      });
      const callback = createMockCallback();

      const result = await createWorkflowAction.handler(
        runtime,
        message,
        createMockState(),
        {},
        callback
      );

      expect(result?.success).toBe(true);

      // Should NOT clear cache — draft stays for retry after auth
      expect(runtime.deleteCache).not.toHaveBeenCalled();

      // Should show auth URLs in callback
      const resultText = getLastCallbackResult(callback)?.text;
      expect(resultText).toContain("https://auth.example.com/gmail");
      expect(resultText).toContain("https://auth.example.com/stripe");
      expect(resultText).toContain("gmailOAuth2Api");
      expect(resultText).toContain("stripeApi");
    });
  });

  // ==========================================================================
  // CALLBACK SUCCESS STATUS TESTS
  // ==========================================================================

  describe("callback success status", () => {
    test("empty prompt returns success: false in callback", async () => {
      const runtime = createMockRuntime({
        services: { [N8N_WORKFLOW_SERVICE_TYPE]: createMockService() },
      });
      const callback = createMockCallback();

      await createWorkflowAction.handler(
        runtime,
        createMockMessage({ content: { text: "" } }),
        createMockState(),
        {},
        callback
      );

      const lastResult = getLastCallbackResult(callback);
      expect(lastResult?.success).toBe(false);
    });

    test("service unavailable returns success: false in callback", async () => {
      const runtime = createMockRuntime();
      const callback = createMockCallback();

      await createWorkflowAction.handler(
        runtime,
        createMockMessage({ content: { text: "Create a workflow" } }),
        createMockState(),
        {},
        callback
      );

      const lastResult = getLastCallbackResult(callback);
      expect(lastResult?.success).toBe(false);
    });

    test("generation error returns success: false in callback", async () => {
      const mockService = createMockService({
        generateWorkflowDraft: mock(() => Promise.reject(new Error("LLM failed"))),
      });
      const runtime = createMockRuntime({
        services: { [N8N_WORKFLOW_SERVICE_TYPE]: mockService },
      });
      const callback = createMockCallback();

      await createWorkflowAction.handler(
        runtime,
        createMockMessage({ content: { text: "Create a workflow" } }),
        createMockState(),
        {},
        callback
      );

      const lastResult = getLastCallbackResult(callback);
      expect(lastResult?.success).toBe(false);
    });

    test("successful preview returns success: true in callback", async () => {
      const mockService = createMockService();
      const runtime = createMockRuntime({
        services: { [N8N_WORKFLOW_SERVICE_TYPE]: mockService },
      });
      const callback = createMockCallback();

      await createWorkflowAction.handler(
        runtime,
        createMockMessage({ content: { text: "Create a Stripe workflow" } }),
        createMockState(),
        {},
        callback
      );

      const lastResult = getLastCallbackResult(callback);
      expect(lastResult?.success).toBe(true);
    });

    test("successful deploy returns success: true in callback", async () => {
      const draft: WorkflowDraft = {
        workflow: {
          name: "Test",
          nodes: [
            {
              name: "Start",
              type: "n8n-nodes-base.start",
              typeVersion: 1,
              position: [0, 0],
              parameters: {},
            },
          ],
          connections: {},
        },
        prompt: "test",
        userId: "user-001",
        createdAt: Date.now(),
      };
      const mockService = createMockService();
      const runtime = createMockRuntime({
        services: { [N8N_WORKFLOW_SERVICE_TYPE]: mockService },
        useModel: createUseModelMock({ intent: "confirm", reason: "User confirmed" }),
        cache: { "workflow_draft:user-001": draft },
      });
      const callback = createMockCallback();

      await createWorkflowAction.handler(
        runtime,
        createMockMessage({ content: { text: "Yes deploy" } }),
        createMockState(),
        {},
        callback
      );

      const lastResult = getLastCallbackResult(callback);
      expect(lastResult?.success).toBe(true);
    });

    test("cancel returns success: true in callback", async () => {
      const draft: WorkflowDraft = {
        workflow: {
          name: "Test",
          nodes: [
            {
              name: "Start",
              type: "n8n-nodes-base.start",
              typeVersion: 1,
              position: [0, 0],
              parameters: {},
            },
          ],
          connections: {},
        },
        prompt: "test",
        userId: "user-001",
        createdAt: Date.now(),
      };
      const runtime = createMockRuntime({
        services: { [N8N_WORKFLOW_SERVICE_TYPE]: createMockService() },
        useModel: createUseModelMock({ intent: "cancel", reason: "User cancelled" }),
        cache: { "workflow_draft:user-001": draft },
      });
      const callback = createMockCallback();

      await createWorkflowAction.handler(
        runtime,
        createMockMessage({ content: { text: "Cancel" } }),
        createMockState(),
        {},
        callback
      );

      const lastResult = getLastCallbackResult(callback);
      expect(lastResult?.success).toBe(true);
    });
  });
});
