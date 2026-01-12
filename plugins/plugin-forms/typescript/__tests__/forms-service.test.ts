import { asUUID, type IAgentRuntime, logger, type Memory } from "@elizaos/core";
import { v4 as uuidv4 } from "uuid";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { FormsService } from "../services/forms-service";
import type { Form, FormTemplate } from "../types";
import { cleanupTestRuntime, createTestRuntime } from "./test-utils";

// Mock the global logger to suppress warnings during tests
vi.spyOn(logger, "warn").mockImplementation(() => {});
vi.spyOn(logger, "info").mockImplementation(() => {});
vi.spyOn(logger, "debug").mockImplementation(() => {});
vi.spyOn(logger, "error").mockImplementation(() => {});

// Helper interface for accessing private properties
interface TestableFormsService {
  templates: Map<string, FormTemplate>;
  forms: Map<string, Form>;
}

function getTestableService(service: FormsService): TestableFormsService {
  return service as TestableFormsService;
}

// Helper to create a test Memory object
const createTestMemory = (text: string): Memory => ({
  id: asUUID(uuidv4()),
  entityId: asUUID(uuidv4()),
  roomId: asUUID(uuidv4()),
  agentId: asUUID(uuidv4()),
  content: {
    text,
    source: "test",
  },
  createdAt: Date.now(),
});

describe("FormsService", () => {
  let service: FormsService;
  let runtime: IAgentRuntime;

  beforeEach(async () => {
    runtime = await createTestRuntime();

    // Default mock returns empty XML response
    vi.spyOn(runtime, "useModel").mockResolvedValue("<response></response>");

    vi.spyOn(runtime.logger, "info").mockImplementation(() => {});
    vi.spyOn(runtime.logger, "warn").mockImplementation(() => {});
    vi.spyOn(runtime.logger, "error").mockImplementation(() => {});
    vi.spyOn(runtime.logger, "debug").mockImplementation(() => {});

    service = new FormsService(runtime);
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await cleanupTestRuntime(runtime);
  });

  describe("Service initialization", () => {
    test("should have correct service type", () => {
      expect(FormsService.serviceType).toBeDefined();
    });

    test("should start properly", async () => {
      const startedService = await FormsService.start(runtime);
      expect(startedService).toBeInstanceOf(FormsService);
    });

    test("should register default contact template on creation", () => {
      const testService = getTestableService(service);
      expect(testService.templates.has("contact")).toBe(true);

      const contactTemplate = testService.templates.get("contact");
      expect(contactTemplate).toBeDefined();
      expect(contactTemplate?.name).toBe("contact");
      expect(contactTemplate?.steps).toHaveLength(1);
      expect(contactTemplate?.steps[0].fields).toHaveLength(3);
    });
  });

  describe("Form creation", () => {
    test("should create a form from template", async () => {
      const form = await service.createForm("contact");

      expect(form).toBeDefined();
      expect(form.id).toBeDefined();
      expect(form.agentId).toBe(runtime.agentId);
      expect(form.status).toBe("active");
      expect(form.name).toBe("contact");
      expect(form.steps).toHaveLength(1);
      expect(form.currentStepIndex).toBe(0);
      expect(form.createdAt).toBeDefined();
    });

    test("should create a custom form", async () => {
      const customForm = {
        name: "custom-form",
        agentId: runtime.agentId,
        steps: [
          {
            id: "step1",
            name: "Step 1",
            fields: [
              {
                id: "field1",
                label: "Field 1",
                type: "text" as const,
              },
            ],
          },
        ],
      };

      const form = await service.createForm(customForm);

      expect(form).toBeDefined();
      expect(form.name).toBe("custom-form");
      expect(form.steps).toHaveLength(1);
      expect(form.steps[0].fields).toHaveLength(1);
    });

    test("should throw error for non-existent template", async () => {
      await expect(service.createForm("non-existent")).rejects.toThrow(
        'Template "non-existent" not found'
      );
    });
  });

  describe("Form updates", () => {
    let testForm: Form;

    beforeEach(async () => {
      testForm = await service.createForm("contact");
    });

    test("should update form fields with extracted values", async () => {
      const message = createTestMemory("My name is John Doe");

      // Mock the LLM to return specific values in XML format
      vi.spyOn(runtime, "useModel").mockResolvedValueOnce(
        "<response><name>John Doe</name></response>"
      );

      const result = await service.updateForm(testForm.id, message);

      expect(result.success).toBe(true);
      expect(result.updatedFields).toContain("name");

      const updatedForm = await service.getForm(testForm.id);
      const nameField = updatedForm?.steps[0].fields.find((f) => f.id === "name");
      expect(nameField?.value).toBe("John Doe");
    });

    test("should progress to next step when all required fields are filled", async () => {
      const multiStepForm = await service.createForm({
        name: "multi-step",
        agentId: runtime.agentId,
        steps: [
          {
            id: "step1",
            name: "Step 1",
            fields: [
              {
                id: "field1",
                label: "Field 1",
                type: "text" as const,
              },
            ],
          },
          {
            id: "step2",
            name: "Step 2",
            fields: [
              {
                id: "field2",
                label: "Field 2",
                type: "text" as const,
              },
            ],
          },
        ],
      });

      // Update first step field with XML format
      vi.spyOn(runtime, "useModel").mockResolvedValueOnce(
        "<response><field1>value1</field1></response>"
      );
      const result = await service.updateForm(multiStepForm.id, createTestMemory("value1"));

      expect(result.success).toBe(true);
      expect(result.stepCompleted).toBe(true);

      const updatedForm = await service.getForm(multiStepForm.id);
      expect(updatedForm?.currentStepIndex).toBe(1);
    });

    test("should mark form as completed when all steps are done", async () => {
      // Mock LLM to return XML formatted responses
      vi.spyOn(runtime, "useModel")
        .mockResolvedValueOnce("<response><name>John Doe</name></response>")
        .mockResolvedValueOnce("<response><email>john@example.com</email></response>");

      await service.updateForm(testForm.id, createTestMemory("John Doe"));
      await service.updateForm(testForm.id, createTestMemory("john@example.com"));

      const completedForm = await service.getForm(testForm.id);
      expect(completedForm?.status).toBe("completed");
    });

    test("should handle form not found", async () => {
      const result = await service.updateForm(asUUID(uuidv4()), createTestMemory("test"));
      expect(result.success).toBe(false);
      expect(result.message).toBe("Form not found");
    });

    test("should handle already completed forms", async () => {
      const testService = getTestableService(service);
      const formData = testService.forms.get(testForm.id);
      if (formData) {
        formData.status = "completed";
      }

      const result = await service.updateForm(testForm.id, createTestMemory("test"));
      expect(result.success).toBe(false);
      expect(result.message).toBe("Form is not active");
    });
  });

  describe("Form cancellation", () => {
    test("should cancel an active form", async () => {
      const form = await service.createForm("contact");
      const result = await service.cancelForm(form.id);

      expect(result).toBe(true);

      const cancelledForm = await service.getForm(form.id);
      expect(cancelledForm?.status).toBe("cancelled");
    });

    test("should return false for non-existent form", async () => {
      const result = await service.cancelForm(asUUID(uuidv4()));
      expect(result).toBe(false);
    });
  });

  describe("Form listing", () => {
    beforeEach(async () => {
      await service.createForm("contact");
      const form2 = await service.createForm("contact");
      await service.cancelForm(form2.id);

      // Create and complete a form
      const form3 = await service.createForm("contact");
      const testService = getTestableService(service);
      const form3Data = testService.forms.get(form3.id);
      if (form3Data) {
        form3Data.status = "completed";
      }
    });

    test("should list forms by status", async () => {
      const activeForms = await service.listForms("active");
      const cancelledForms = await service.listForms("cancelled");
      const completedForms = await service.listForms("completed");

      expect(activeForms).toHaveLength(1);
      expect(cancelledForms).toHaveLength(1);
      expect(completedForms).toHaveLength(1);
    });

    test("should list all forms when no status specified", async () => {
      const allForms = await service.listForms();
      expect(allForms).toHaveLength(3);
    });
  });

  describe("Template management", () => {
    test("should register a new template", () => {
      const template: FormTemplate = {
        name: "custom-template",
        steps: [
          {
            id: "step1",
            name: "Step 1",
            fields: [
              {
                id: "field1",
                label: "Field 1",
                type: "text" as const,
              },
            ],
          },
        ],
      };

      service.registerTemplate(template);

      const testService = getTestableService(service);
      const registeredTemplate = testService.templates.get("custom-template");
      expect(registeredTemplate).toEqual(template);
    });
  });

  describe("Cleanup", () => {
    test("should remove old completed and cancelled forms", async () => {
      const form1 = await service.createForm("contact");
      const form2 = await service.createForm("contact");

      const oldTimestamp = Date.now() - 25 * 60 * 60 * 1000;

      const testService = getTestableService(service);

      const form1Data = testService.forms.get(form1.id);
      if (form1Data) {
        form1Data.status = "completed";
        form1Data.updatedAt = oldTimestamp;
      }

      const form2Data = testService.forms.get(form2.id);
      if (form2Data) {
        form2Data.status = "cancelled";
        form2Data.updatedAt = oldTimestamp;
      }

      const form3 = await service.createForm("contact");
      const form3Data = testService.forms.get(form3.id);
      if (form3Data) {
        form3Data.status = "completed";
      }

      const cleanedCount = await service.cleanup();

      expect(cleanedCount).toBe(2);
      expect(await service.getForm(form1.id)).toBeNull();
      expect(await service.getForm(form2.id)).toBeNull();
      expect(await service.getForm(form3.id)).toBeDefined();
    });
  });

  describe("Secret field handling", () => {
    test("should extract values for secret fields", async () => {
      const formWithSecret = await service.createForm({
        name: "api-form",
        agentId: runtime.agentId,
        steps: [
          {
            id: "credentials",
            name: "Credentials",
            fields: [
              {
                id: "apiKey",
                label: "API Key",
                type: "text" as const,
                secret: true,
              },
            ],
          },
        ],
      });

      vi.spyOn(runtime, "useModel").mockResolvedValueOnce(
        "<response><apiKey>sk-12345</apiKey></response>"
      );

      const result = await service.updateForm(
        formWithSecret.id,
        createTestMemory("My API key is sk-12345")
      );

      expect(result.success).toBe(true);
      expect(runtime.useModel).toHaveBeenCalled();

      const updatedForm = await service.getForm(formWithSecret.id);
      const apiKeyField = updatedForm?.steps[0].fields.find((f) => f.id === "apiKey");
      expect(apiKeyField?.value).toBeTruthy();
      expect(typeof apiKeyField?.value).toBe("string");
      expect((apiKeyField?.value as string).includes(":")).toBe(true);
      expect(apiKeyField?.value).not.toBe("sk-12345");
    });
  });

  describe("Zod validation", () => {
    test("should validate field values according to type", async () => {
      const form = await service.createForm({
        name: "validation-test",
        agentId: runtime.agentId,
        steps: [
          {
            id: "step1",
            name: "Validation Test",
            fields: [
              {
                id: "email",
                label: "Email",
                type: "email" as const,
              },
              {
                id: "age",
                label: "Age",
                type: "number" as const,
              },
              {
                id: "website",
                label: "Website",
                type: "url" as const,
              },
            ],
          },
        ],
      });

      vi.spyOn(runtime, "useModel").mockResolvedValueOnce(
        "<response><email>not-an-email</email></response>"
      );

      const result1 = await service.updateForm(
        form.id,
        createTestMemory("My email is not-an-email")
      );

      expect(result1.success).toBe(true);
      expect(runtime.useModel).toHaveBeenCalled();

      vi.spyOn(runtime, "useModel").mockResolvedValueOnce(
        "<response><email>test@example.com</email><age>25</age><website>https://example.com</website></response>"
      );

      const result2 = await service.updateForm(
        form.id,
        createTestMemory("Email test@example.com, age 25, website https://example.com")
      );

      expect(result2.errors).toHaveLength(0);
      expect(result2.updatedFields).toHaveLength(3);
    });

    test("should handle falsy values correctly", async () => {
      const form = await service.createForm({
        name: "falsy-test",
        agentId: runtime.agentId,
        steps: [
          {
            id: "step1",
            name: "Falsy Test",
            fields: [
              {
                id: "enabled",
                label: "Enabled",
                type: "checkbox" as const,
              },
              {
                id: "count",
                label: "Count",
                type: "number" as const,
              },
              {
                id: "message",
                label: "Message",
                type: "text" as const,
                optional: true,
              },
            ],
          },
        ],
      });

      vi.spyOn(runtime, "useModel").mockResolvedValueOnce(
        "<response><enabled>false</enabled><count>0</count><message></message></response>"
      );

      const result = await service.updateForm(
        form.id,
        createTestMemory("Disabled, count 0, no message")
      );

      expect(result.success).toBe(true);
      // Note: empty strings are intentionally skipped, so only 'enabled' and 'count' are updated
      expect(result.updatedFields).toHaveLength(2);

      const updatedForm = await service.getForm(form.id);
      const enabledField = updatedForm?.steps[0].fields.find((f) => f.id === "enabled");
      const countField = updatedForm?.steps[0].fields.find((f) => f.id === "count");
      const messageField = updatedForm?.steps[0].fields.find((f) => f.id === "message");

      expect(enabledField?.value).toBe(false);
      expect(countField?.value).toBe(0);
      // Empty strings are intentionally skipped, so messageField remains undefined
      expect(messageField?.value).toBeUndefined();
    });
  });
});
