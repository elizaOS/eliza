import { asUUID, IAgentRuntime, type Memory } from '@elizaos/core';
import { v4 as uuidv4 } from 'uuid';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FormsService } from '../services/forms-service';
import type { Form, FormTemplate } from '../types';

// Helper to create a mock Memory object
const createMockMemory = (text: string): Memory => ({
  id: asUUID(uuidv4()),
  entityId: asUUID(uuidv4()),
  roomId: asUUID(uuidv4()),
  agentId: asUUID(uuidv4()),
  content: {
    text,
    source: 'test',
  },
  createdAt: Date.now(),
});

// Helper to create a properly typed mock runtime
const createTypedMockRuntime = (): IAgentRuntime => {
  const testAgentId = asUUID(uuidv4());
  
  const runtime = {
    agentId: testAgentId,
    providers: [],
    actions: [],
    evaluators: [],
    plugins: [],
    services: new Map(),
    clients: [],
    messageManager: null,
    descriptionManager: null,
    documentsManager: null,
    knowledgeManager: null,
    ragKnowledgeManager: null,
    loreManager: null,
    serverUrl: 'http://localhost:3000',
    databaseAdapter: null,
    token: null,
    modelProvider: 'openai',
    imageModelProvider: 'openai',
    imageVisionModelProvider: 'openai',
    character: { name: 'Test Agent', modelProvider: 'openai' },
    cacheManager: {
      get: vi.fn(),
      set: vi.fn(),
      delete: vi.fn(),
    },
    fetch: null,
    initialize: vi.fn().mockResolvedValue(undefined),
    registerMemoryManager: vi.fn(),
    getMemoryManager: vi.fn(),
    getService: vi.fn(),
    registerService: vi.fn(),
    getSetting: vi.fn(),
    getConversationLength: vi.fn().mockReturnValue(0),
    processActions: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue(null),
    ensureParticipantExists: vi.fn().mockResolvedValue(undefined),
    ensureUserExists: vi.fn().mockResolvedValue(undefined),
    registerAction: vi.fn(),
    ensureConnection: vi.fn().mockResolvedValue(undefined),
    ensureParticipantInRoom: vi.fn().mockResolvedValue(undefined),
    ensureRoomExists: vi.fn().mockResolvedValue(undefined),
    composeState: vi.fn().mockResolvedValue({}),
    updateRecentMessageState: vi.fn().mockResolvedValue({}),
    useModel: vi.fn().mockResolvedValue('Mock response'),
  };

  return runtime as unknown as IAgentRuntime;
};

describe('FormsService', () => {
  let service: FormsService;
  let mockRuntime: IAgentRuntime;

  beforeEach(() => {
    mockRuntime = createTypedMockRuntime();
    service = new FormsService(mockRuntime);
  });

  describe('Service initialization', () => {
    it('should have correct service type', () => {
      expect(FormsService.serviceType).toBeDefined();
    });

    it('should start properly', async () => {
      const startedService = await FormsService.start(mockRuntime);
      expect(startedService).toBeInstanceOf(FormsService);
    });

    it('should register default contact template on creation', () => {
      const templates = (service as unknown as { templates: Map<string, FormTemplate> }).templates;
      expect(templates.has('contact')).toBe(true);

      const contactTemplate = templates.get('contact');
      expect(contactTemplate).toBeDefined();
      expect(contactTemplate?.name).toBe('contact');
      expect(contactTemplate?.steps).toHaveLength(1);
      expect(contactTemplate?.steps[0].fields).toHaveLength(3);
    });
  });

  describe('Form creation', () => {
    it('should create a form from template', async () => {
      const form = await service.createForm('contact');

      expect(form).toBeDefined();
      expect(form.id).toBeDefined();
      expect(form.agentId).toBe(mockRuntime.agentId);
      expect(form.status).toBe('active');
      expect(form.name).toBe('contact');
      expect(form.steps).toHaveLength(1);
      expect(form.currentStepIndex).toBe(0);
      expect(form.createdAt).toBeDefined();
    });

    it('should create a custom form', async () => {
      const customForm = {
        name: 'custom-form',
        agentId: mockRuntime.agentId,
        steps: [
          {
            id: 'step1',
            name: 'Step 1',
            fields: [
              {
                id: 'field1',
                label: 'Field 1',
                type: 'text' as const,
              },
            ],
          },
        ],
      };

      const form = await service.createForm(customForm);

      expect(form).toBeDefined();
      expect(form.name).toBe('custom-form');
      expect(form.steps).toHaveLength(1);
      expect(form.steps[0].fields).toHaveLength(1);
    });

    it('should throw error for non-existent template', async () => {
      await expect(service.createForm('non-existent')).rejects.toThrow(
        'Template "non-existent" not found'
      );
    });
  });

  describe('Form updates', () => {
    let testForm: Form;

    beforeEach(async () => {
      testForm = await service.createForm('contact');
    });

    it('should update form fields with extracted values', async () => {
      const message = createMockMemory('My name is John Doe');

      // Mock the LLM to return specific values
      (mockRuntime.useModel as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        '{"name": "John Doe"}'
      );

      const result = await service.updateForm(testForm.id, message);

      expect(result.success).toBe(true);
      expect(result.updatedFields).toContain('name');

      const updatedForm = await service.getForm(testForm.id);
      const nameField = updatedForm?.steps[0].fields.find((f) => f.id === 'name');
      expect(nameField?.value).toBe('John Doe');
    });

    it('should progress to next step when all required fields are filled', async () => {
      // Create a multi-step form
      const multiStepForm = await service.createForm({
        name: 'multi-step',
        agentId: mockRuntime.agentId,
        steps: [
          {
            id: 'step1',
            name: 'Step 1',
            fields: [
              {
                id: 'field1',
                label: 'Field 1',
                type: 'text' as const,
              },
            ],
          },
          {
            id: 'step2',
            name: 'Step 2',
            fields: [
              {
                id: 'field2',
                label: 'Field 2',
                type: 'text' as const,
              },
            ],
          },
        ],
      });

      // Update first step field
      (mockRuntime.useModel as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        '{"field1": "value1"}'
      );
      const result = await service.updateForm(multiStepForm.id, createMockMemory('value1'));

      expect(result.success).toBe(true);
      expect(result.stepCompleted).toBe(true);

      // Check that form progressed to next step
      const updatedForm = await service.getForm(multiStepForm.id);
      expect(updatedForm?.currentStepIndex).toBe(1);
    });

    it('should mark form as completed when all steps are done', async () => {
      // Fill all fields of contact form
      (mockRuntime.useModel as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce('{"name": "John Doe"}')
        .mockResolvedValueOnce('{"email": "john@example.com"}');

      await service.updateForm(testForm.id, createMockMemory('John Doe'));
      await service.updateForm(testForm.id, createMockMemory('john@example.com'));

      const completedForm = await service.getForm(testForm.id);
      expect(completedForm?.status).toBe('completed');
    });

    it('should handle form not found', async () => {
      const result = await service.updateForm(asUUID(uuidv4()), createMockMemory('test'));
      expect(result.success).toBe(false);
      expect(result.message).toBe('Form not found');
    });

    it('should handle already completed forms', async () => {
      // Complete the form first
      const forms = (service as unknown as { forms: Map<string, Form> }).forms;
      const formData = forms.get(testForm.id);
      if (formData) {
        formData.status = 'completed';
      }

      const result = await service.updateForm(testForm.id, createMockMemory('test'));
      expect(result.success).toBe(false);
      expect(result.message).toBe('Form is not active');
    });
  });

  describe('Form cancellation', () => {
    it('should cancel an active form', async () => {
      const form = await service.createForm('contact');
      const result = await service.cancelForm(form.id);

      expect(result).toBe(true);

      const cancelledForm = await service.getForm(form.id);
      expect(cancelledForm?.status).toBe('cancelled');
    });

    it('should return false for non-existent form', async () => {
      const result = await service.cancelForm(asUUID(uuidv4()));
      expect(result).toBe(false);
    });
  });

  describe('Form listing', () => {
    beforeEach(async () => {
      // Create multiple forms
      await service.createForm('contact');
      const form2 = await service.createForm('contact');
      await service.cancelForm(form2.id);

      // Create and complete a form
      const form3 = await service.createForm('contact');
      const forms = (service as unknown as { forms: Map<string, Form> }).forms;
      const form3Data = forms.get(form3.id);
      if (form3Data) {
        form3Data.status = 'completed';
      }
    });

    it('should list forms by status', async () => {
      const activeForms = await service.listForms('active');
      const cancelledForms = await service.listForms('cancelled');
      const completedForms = await service.listForms('completed');

      expect(activeForms).toHaveLength(1);
      expect(cancelledForms).toHaveLength(1);
      expect(completedForms).toHaveLength(1);
    });

    it('should list all forms when no status specified', async () => {
      const allForms = await service.listForms();
      expect(allForms).toHaveLength(3);
    });
  });

  describe('Template management', () => {
    it('should register a new template', () => {
      const template: FormTemplate = {
        name: 'custom-template',
        steps: [
          {
            id: 'step1',
            name: 'Step 1',
            fields: [
              {
                id: 'field1',
                label: 'Field 1',
                type: 'text' as const,
              },
            ],
          },
        ],
      };

      service.registerTemplate(template);

      const registeredTemplate = (
        service as unknown as { templates: Map<string, FormTemplate> }
      ).templates.get('custom-template');
      expect(registeredTemplate).toEqual(template);
    });
  });

  describe('Cleanup', () => {
    it('should remove old completed and cancelled forms', async () => {
      // Create forms
      const form1 = await service.createForm('contact');
      const form2 = await service.createForm('contact');

      // Set old timestamps
      const oldTimestamp = Date.now() - 25 * 60 * 60 * 1000; // 25 hours ago

      const forms = (service as unknown as { forms: Map<string, Form> }).forms;

      // Complete and age form1
      const form1Data = forms.get(form1.id);
      if (form1Data) {
        form1Data.status = 'completed';
        form1Data.updatedAt = oldTimestamp;
      }

      // Cancel and age form2
      const form2Data = forms.get(form2.id);
      if (form2Data) {
        form2Data.status = 'cancelled';
        form2Data.updatedAt = oldTimestamp;
      }

      // Create a recent completed form
      const form3 = await service.createForm('contact');
      const form3Data = forms.get(form3.id);
      if (form3Data) {
        form3Data.status = 'completed';
      }

      // Run cleanup
      const cleanedCount = await service.cleanup();

      // Check results
      expect(cleanedCount).toBe(2);
      expect(await service.getForm(form1.id)).toBeNull();
      expect(await service.getForm(form2.id)).toBeNull();
      expect(await service.getForm(form3.id)).toBeDefined();
    });
  });

  describe('Secret field handling', () => {
    it('should extract values for secret fields', async () => {
      const formWithSecret = await service.createForm({
        name: 'api-form',
        agentId: mockRuntime.agentId,
        steps: [
          {
            id: 'credentials',
            name: 'Credentials',
            fields: [
              {
                id: 'apiKey',
                label: 'API Key',
                type: 'text' as const,
                secret: true,
              },
            ],
          },
        ],
      });

      // The service should still set the value even for secret fields
      // but it would be masked in the provider
      (mockRuntime.useModel as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        '{"apiKey": "sk-12345"}'
      );

      const result = await service.updateForm(
        formWithSecret.id,
        createMockMemory('My API key is sk-12345')
      );

      expect(result.success).toBe(true);
      expect(mockRuntime.useModel).toHaveBeenCalled();

      const updatedForm = await service.getForm(formWithSecret.id);
      const apiKeyField = updatedForm?.steps[0].fields.find((f) => f.id === 'apiKey');
      expect(apiKeyField?.value).toBe('sk-12345');
    });
  });
});
