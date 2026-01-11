import {
  asUUID,
  type Content,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
} from "@elizaos/core";
import { v4 as uuidv4 } from "uuid";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cancelFormAction, createFormAction, updateFormAction } from "../index";
import { formsProvider } from "../providers/forms-provider";
import { FormsService } from "../services/forms-service";
import { cleanupTestRuntime, createTestRuntime } from "./test-utils";

/**
 * Integration tests demonstrate how multiple components of the plugin work together.
 * Uses REAL AgentRuntime instances with vi.spyOn for specific method mocking.
 */

// Helper to create a test Memory object
const createTestMemory = (text: string, agentId?: string): Memory => ({
  id: asUUID(uuidv4()),
  entityId: asUUID(uuidv4()),
  roomId: asUUID(uuidv4()),
  agentId: asUUID(agentId || uuidv4()),
  content: {
    text,
    source: "test",
  },
  createdAt: Date.now(),
});

// Helper to create a test State object
const createTestState = (): State => ({
  values: {},
  data: {},
  text: "",
});

describe("Forms Plugin Integration Tests", () => {
  let runtime: IAgentRuntime;
  let formsService: FormsService;

  beforeEach(async () => {
    runtime = await createTestRuntime();

    // Spy on useModel for LLM calls
    vi.spyOn(runtime, "useModel").mockResolvedValue('{"name": "Test User"}');

    // Suppress logger output
    vi.spyOn(runtime.logger, "info").mockImplementation(() => {});
    vi.spyOn(runtime.logger, "warn").mockImplementation(() => {});
    vi.spyOn(runtime.logger, "error").mockImplementation(() => {});
    vi.spyOn(runtime.logger, "debug").mockImplementation(() => {});

    // Initialize the forms service
    formsService = (await FormsService.start(runtime)) as FormsService;

    // Register the service
    vi.spyOn(runtime, "getService").mockImplementation((name: string) => {
      if (name === "forms") return formsService;
      return null;
    });
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await cleanupTestRuntime(runtime);
  });

  describe("Form creation through action", () => {
    test("should handle CREATE_FORM action", async () => {
      const message = createTestMemory("I need to create a contact form");
      const state = createTestState();
      let responseReceived = false;
      let responseText = "";

      const callback: HandlerCallback = async (response: Content | Memory) => {
        responseReceived = true;
        responseText =
          typeof response === "object" && "content" in response
            ? (response as Memory).content.text || ""
            : (response as Content).text || "";
        return [];
      };

      // Create form through action handler
      await createFormAction.handler(
        runtime,
        message,
        state,
        { templateName: "contact" },
        callback
      );

      expect(responseReceived).toBe(true);
      expect(responseText).toContain("contact");

      // Verify form was created
      const forms = await formsService.listForms("active");
      expect(forms.length).toBeGreaterThan(0);
    });

    test("should handle UPDATE_FORM action", async () => {
      // First create a form
      const form = await formsService.createForm("contact");

      const message = createTestMemory("My name is John Doe");
      const state = createTestState();
      let responseReceived = false;

      const callback: HandlerCallback = async () => {
        responseReceived = true;
        return [];
      };

      vi.spyOn(runtime, "useModel").mockResolvedValueOnce('{"name": "John Doe"}');

      await updateFormAction.handler(
        runtime,
        message,
        state,
        { formId: form.id, userInput: "My name is John Doe" },
        callback
      );

      expect(responseReceived).toBe(true);

      // Verify field was updated
      const updatedForm = await formsService.getForm(form.id);
      const nameField = updatedForm?.steps[0].fields.find((f) => f.id === "name");
      expect(nameField?.value).toBe("John Doe");
    });

    test("should handle CANCEL_FORM action", async () => {
      // Create a form first
      const form = await formsService.createForm("contact");

      const message = createTestMemory("Cancel this form");
      const state = createTestState();
      let responseReceived = false;

      const callback: HandlerCallback = async () => {
        responseReceived = true;
        return [];
      };

      await cancelFormAction.handler(runtime, message, state, { formId: form.id }, callback);

      expect(responseReceived).toBe(true);

      // Verify form was cancelled
      const cancelledForm = await formsService.getForm(form.id);
      expect(cancelledForm?.status).toBe("cancelled");
    });
  });

  describe("Provider integration", () => {
    test("should provide active forms context", async () => {
      // Create some forms
      await formsService.createForm("contact");
      await formsService.createForm("contact");

      const message = createTestMemory("Show me my forms");
      const state = createTestState();

      const result = await formsProvider.get(runtime, message, state);

      expect(result).toBeDefined();
      expect(result.text).toContain("Active forms");
    });

    test("should reflect form state changes", async () => {
      const form = await formsService.createForm("contact");

      // Update form
      vi.spyOn(runtime, "useModel").mockResolvedValueOnce('{"name": "Jane Doe"}');
      await formsService.updateForm(form.id, createTestMemory("My name is Jane Doe"));

      const message = createTestMemory("Show forms");
      const state = createTestState();

      const result = await formsProvider.get(runtime, message, state);

      expect(result.text).toContain("Jane Doe");
    });
  });

  describe("Full form workflow", () => {
    test("should complete a full form workflow", async () => {
      // Create a contact form
      const form = await formsService.createForm("contact");
      expect(form.status).toBe("active");

      // Fill in name
      vi.spyOn(runtime, "useModel").mockResolvedValueOnce('{"name": "John Doe"}');
      let result = await formsService.updateForm(form.id, createTestMemory("My name is John Doe"));
      expect(result.success).toBe(true);

      // Fill in email
      vi.spyOn(runtime, "useModel").mockResolvedValueOnce('{"email": "john@example.com"}');
      result = await formsService.updateForm(
        form.id,
        createTestMemory("My email is john@example.com")
      );
      expect(result.success).toBe(true);

      // Form should now be completed (contact has: name, email, message - message is optional)
      const completedForm = await formsService.getForm(form.id);
      expect(completedForm?.status).toBe("completed");
    });

    test("should handle form cancellation mid-workflow", async () => {
      const form = await formsService.createForm("contact");

      // Start filling form
      vi.spyOn(runtime, "useModel").mockResolvedValueOnce('{"name": "John Doe"}');
      await formsService.updateForm(form.id, createTestMemory("My name is John Doe"));

      // Cancel the form
      const cancelled = await formsService.cancelForm(form.id);
      expect(cancelled).toBe(true);

      // Try to update cancelled form
      vi.spyOn(runtime, "useModel").mockResolvedValueOnce('{"email": "john@example.com"}');
      const result = await formsService.updateForm(form.id, createTestMemory("john@example.com"));
      expect(result.success).toBe(false);
      expect(result.message).toBe("Form is not active");
    });
  });

  describe("Multiple forms handling", () => {
    test("should manage multiple concurrent forms", async () => {
      // Create multiple forms
      const form1 = await formsService.createForm("contact");
      const form2 = await formsService.createForm("contact");

      // Update different forms
      vi.spyOn(runtime, "useModel").mockResolvedValueOnce('{"name": "Alice"}');
      await formsService.updateForm(form1.id, createTestMemory("I am Alice"));

      vi.spyOn(runtime, "useModel").mockResolvedValueOnce('{"name": "Bob"}');
      await formsService.updateForm(form2.id, createTestMemory("I am Bob"));

      // Verify each form has correct data
      const f1 = await formsService.getForm(form1.id);
      const f2 = await formsService.getForm(form2.id);

      expect(f1?.steps[0].fields.find((f) => f.id === "name")?.value).toBe("Alice");
      expect(f2?.steps[0].fields.find((f) => f.id === "name")?.value).toBe("Bob");
    });

    test("should list forms by status correctly", async () => {
      // Create forms in different states
      const activeForm = await formsService.createForm("contact");
      const cancelledForm = await formsService.createForm("contact");
      await formsService.cancelForm(cancelledForm.id);

      const activeForms = await formsService.listForms("active");
      const cancelledForms = await formsService.listForms("cancelled");

      expect(activeForms.length).toBe(1);
      expect(activeForms[0].id).toBe(activeForm.id);
      expect(cancelledForms.length).toBe(1);
      expect(cancelledForms[0].id).toBe(cancelledForm.id);
    });
  });
});
