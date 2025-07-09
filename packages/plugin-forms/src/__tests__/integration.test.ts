import {
  asUUID,
  type Content,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
} from '@elizaos/core';
import { v4 as uuidv4 } from 'uuid';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { cancelFormAction, createFormAction, formsPlugin, updateFormAction } from '../index';
import { formsProvider } from '../providers/forms-provider';
import { FormsService } from '../services/forms-service';

/**
 * Integration tests demonstrate how multiple components of the plugin work together.
 * Unlike unit tests that test individual functions in isolation, integration tests
 * examine how components interact with each other.
 *
 * For example, this file shows how the HelloWorld action and HelloWorld provider
 * interact with the StarterService and the plugin's core functionality.
 */

// Create a more complete mock runtime for integration tests
function createMockRuntime(): IAgentRuntime & { useModel: Mock } {
  const services = new Map<string, unknown>();
  const mockRuntime = {
    agentId: asUUID(uuidv4()),
    character: {
      name: 'TestAgent',
      bio: ['Test agent bio'],
      system: 'You are a test agent',
      plugins: ['forms'],
    },
    actions: [createFormAction, updateFormAction, cancelFormAction],
    providers: [formsProvider],
    logger: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
    useModel: vi.fn().mockResolvedValue('{"name": "Test User"}'),
    getService: (name: string) => services.get(name),
    registerService: (name: string, service: unknown) => services.set(name, service),
  };

  return mockRuntime as unknown as IAgentRuntime & { useModel: Mock };
}

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

// Helper to create a mock State object
const createMockState = (): State => ({
  values: {},
  data: {},
  text: '',
});

describe('Forms Plugin Integration Tests', () => {
  let mockRuntime: IAgentRuntime & { useModel: Mock };
  let formsService: FormsService;

  beforeEach(async () => {
    mockRuntime = createMockRuntime();

    // Initialize the forms service
    formsService = (await FormsService.start(mockRuntime)) as FormsService;
    (
      mockRuntime as unknown as { registerService: (name: string, service: unknown) => void }
    ).registerService('forms', formsService);
  });

  describe('Form creation through action', () => {
    it('should handle CREATE_FORM action', async () => {
      const message = createMockMemory('I need to create a contact form');
      const state = createMockState();
      let responseReceived = false;
      let responseText = '';

      const callback: HandlerCallback = async (response: Content) => {
        responseReceived = true;
        responseText = response.text || '';
        return [];
      };

      // Validate the action
      const isValid = await createFormAction.validate(mockRuntime, message, state);
      expect(isValid).toBe(true);

      // Execute the action
      await createFormAction.handler(mockRuntime, message, state, {}, callback);

      expect(responseReceived).toBe(true);
      expect(responseText).toContain('created');
      expect(responseText.toLowerCase()).toContain('contact');

      // Verify form was created
      const forms = await formsService.listForms('active');
      expect(forms).toHaveLength(1);
      expect(forms[0].name).toBe('contact');
    });

    it('should handle form creation with provider context', async () => {
      // Create a form first
      const form = await formsService.createForm('contact');

      // Get provider data
      const message = createMockMemory('test');
      const state = createMockState();

      const providerResult = await formsProvider.get(mockRuntime, message, state);

      expect(providerResult.text).toContain('[FORMS]');
      expect(providerResult.text).toContain('contact');
      expect(providerResult.data?.forms).toHaveLength(1);
      expect(providerResult.data?.forms[0].id).toBe(form.id);
    });
  });

  describe('Form updates through action', () => {
    let testForm: Awaited<ReturnType<FormsService['createForm']>>;

    beforeEach(async () => {
      testForm = await formsService.createForm('contact');
    });

    it('should handle UPDATE_FORM action', async () => {
      const message = createMockMemory('My name is John Doe');
      const state = createMockState();
      let responseReceived = false;
      let responseText = '';

      const callback: HandlerCallback = async (response: Content) => {
        responseReceived = true;
        responseText = response.text || '';
        return [];
      };

      // Mock the LLM response
      mockRuntime.useModel.mockResolvedValueOnce('{"name": "John Doe"}');

      // Validate the action
      const isValid = await updateFormAction.validate(mockRuntime, message, state);
      expect(isValid).toBe(true);

      // Execute the action
      await updateFormAction.handler(mockRuntime, message, state, {}, callback);

      expect(responseReceived).toBe(true);
      expect(responseText).toContain('Updated');

      // Verify form was updated
      const updatedForm = await formsService.getForm(testForm.id);
      const nameField = updatedForm?.steps[0].fields.find((f) => f.id === 'name');
      expect(nameField?.value).toBe('John Doe');
    });

    it('should complete form when all fields are filled', async () => {
      const messages = ['My name is John Doe', 'My email is john@example.com'];

      let completionMessage = '';

      for (const text of messages) {
        const message = createMockMemory(text);
        const state = createMockState();

        const callback: HandlerCallback = async (response: Content) => {
          completionMessage = response.text || '';
          return [];
        };

        // Mock appropriate responses
        if (text.includes('name')) {
          mockRuntime.useModel.mockResolvedValueOnce('{"name": "John Doe"}');
        } else if (text.includes('email')) {
          mockRuntime.useModel.mockResolvedValueOnce('{"email": "john@example.com"}');
        }

        await updateFormAction.handler(mockRuntime, message, state, {}, callback);
      }

      // Check that form is completed
      const completedForm = await formsService.getForm(testForm.id);
      expect(completedForm?.status).toBe('completed');
      expect(completionMessage).toContain('completed');
    });
  });

  describe('Form cancellation through action', () => {
    let testForm: Awaited<ReturnType<FormsService['createForm']>>;

    beforeEach(async () => {
      testForm = await formsService.createForm('contact');
    });

    it('should handle CANCEL_FORM action', async () => {
      const message = createMockMemory('Cancel the form');
      const state = createMockState();
      let responseReceived = false;
      let responseText = '';

      const callback: HandlerCallback = async (response: Content) => {
        responseReceived = true;
        responseText = response.text || '';
        return [];
      };

      // Validate the action
      const isValid = await cancelFormAction.validate(mockRuntime, message, state);
      expect(isValid).toBe(true);

      // Execute the action
      await cancelFormAction.handler(mockRuntime, message, state, {}, callback);

      expect(responseReceived).toBe(true);
      expect(responseText).toContain('cancelled');

      // Verify form was cancelled
      const cancelledForm = await formsService.getForm(testForm.id);
      expect(cancelledForm?.status).toBe('cancelled');
    });
  });

  describe('Plugin initialization', () => {
    it('should register all components correctly', () => {
      expect(formsPlugin.services).toContain(FormsService);
      expect(formsPlugin.actions).toContain(createFormAction);
      expect(formsPlugin.actions).toContain(updateFormAction);
      expect(formsPlugin.actions).toContain(cancelFormAction);
      expect(formsPlugin.providers).toContain(formsProvider);
    });

    it('should have correct plugin metadata', () => {
      expect(formsPlugin.name).toBe('@elizaos/plugin-forms');
      expect(formsPlugin.description).toBeTruthy();
    });
  });

  describe('Secret field handling in integration', () => {
    it('should mask secret fields in provider output', async () => {
      // Create a form with a secret field and another required field to keep it active
      const form = await formsService.createForm({
        name: 'api-config',
        agentId: mockRuntime.agentId,
        steps: [
          {
            id: 'credentials',
            name: 'API Credentials',
            fields: [
              {
                id: 'apiKey',
                label: 'API Key',
                type: 'text' as const,
                secret: true,
              },
              {
                id: 'endpoint',
                label: 'API Endpoint',
                type: 'text' as const,
                description: 'The API endpoint URL',
              },
            ],
          },
        ],
      });

      // Update with secret value (but not the endpoint, so form stays active)
      mockRuntime.useModel.mockResolvedValueOnce('{"apiKey": "sk-12345"}');
      await formsService.updateForm(form.id, createMockMemory('My API key is sk-12345'));

      // Get provider output
      const providerResult = await formsProvider.get(
        mockRuntime,
        createMockMemory('test'),
        createMockState()
      );

      // Check that secret is masked
      expect(providerResult.text).toContain('[SECRET]');
      expect(providerResult.text).not.toContain('sk-12345');
    });
  });
});
