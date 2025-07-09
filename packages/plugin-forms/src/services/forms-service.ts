import {
  asUUID,
  elizaLogger,
  IAgentRuntime,
  ModelType,
  Service,
  ServiceType,
  type Memory,
  type UUID,
} from '@elizaos/core';
import { v4 as uuidv4 } from 'uuid';
import type { Form, FormField, FormStatus, FormTemplate, FormUpdateResult } from '../types';

const FORMS_STORAGE_KEY = 'forms:state';
const FORMS_CLEANUP_INTERVAL = 60 * 60 * 1000; // 1 hour

/**
 * FormsService manages form lifecycle and state.
 * It provides methods to create, update, list, and cancel forms.
 */
export class FormsService extends Service {
  static serviceName = 'forms';
  static serviceType = 'forms';

  private forms: Map<UUID, Form> = new Map();
  private templates: Map<string, FormTemplate> = new Map();
  private persistenceTimer?: NodeJS.Timeout;
  private cleanupTimer?: NodeJS.Timeout;

  capabilityDescription = 'Form management service for collecting structured data from users';

  constructor(runtime: IAgentRuntime) {
    super(runtime);
    this.initialize(runtime);
  }

  static async start(runtime: IAgentRuntime): Promise<FormsService> {
    const service = new FormsService(runtime);
    return service;
  }

  async initialize(runtime: IAgentRuntime): Promise<void> {
    this.registerDefaultTemplates();

    // Restore persisted forms
    await this.restorePersistedForms();

    // Set up auto-persistence
    this.persistenceTimer = setInterval(() => {
      this.persistForms().catch((err) => elizaLogger.error('Failed to persist forms:', err));
    }, 30000); // Every 30 seconds

    // Set up cleanup of completed/expired forms
    this.cleanupTimer = setInterval(() => {
      this.cleanupOldForms().catch((err) => elizaLogger.error('Failed to cleanup forms:', err));
    }, FORMS_CLEANUP_INTERVAL);
  }

  private registerDefaultTemplates() {
    // Basic contact form template
    this.templates.set('contact', {
      name: 'contact',
      description: 'Basic contact information form',
      steps: [
        {
          id: 'basic-info',
          name: 'Basic Information',
          fields: [
            {
              id: 'name',
              label: 'Name',
              type: 'text',
              description: 'Your full name',
              criteria: 'First and last name',
            },
            {
              id: 'email',
              label: 'Email',
              type: 'email',
              description: 'Your email address',
              criteria: 'Valid email format',
            },
            {
              id: 'message',
              label: 'Message',
              type: 'textarea',
              description: 'Your message',
              optional: true,
            },
          ],
        },
      ],
    });
  }

  /**
   * Create a new form from a template or custom definition
   */
  async createForm(
    templateOrForm: string | Partial<Form>,
    metadata?: Record<string, unknown>
  ): Promise<Form> {
    let form: Form;

    if (typeof templateOrForm === 'string') {
      // Create from template
      const template = this.templates.get(templateOrForm);
      if (!template) {
        throw new Error(`Template "${templateOrForm}" not found`);
      }

      form = {
        id: asUUID(uuidv4()),
        agentId: this.runtime.agentId,
        name: template.name,
        description: template.description,
        steps: template.steps.map((step) => ({
          ...step,
          completed: false,
          fields: step.fields.map((field) => ({ ...field })), // Deep copy fields
        })),
        currentStepIndex: 0,
        status: 'active',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        metadata: metadata || {},
      };
    } else {
      // Create from custom form
      form = {
        id: asUUID(uuidv4()),
        agentId: this.runtime.agentId,
        status: 'active',
        currentStepIndex: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        ...templateOrForm,
        steps: templateOrForm.steps!.map((step) => ({
          ...step,
          completed: false,
        })),
      } as Form;
    }

    this.forms.set(form.id, form);
    elizaLogger.debug(`Created form ${form.id} (${form.name})`);

    return form;
  }

  /**
   * Update form with extracted values from user message
   */
  async updateForm(formId: UUID, message: Memory): Promise<FormUpdateResult> {
    const form = this.forms.get(formId);
    if (!form) {
      return {
        success: false,
        message: 'Form not found',
      };
    }

    if (form.status !== 'active') {
      return {
        success: false,
        message: 'Form is not active',
      };
    }

    const currentStep = form.steps[form.currentStepIndex];
    if (!currentStep) {
      return {
        success: false,
        message: 'No current step',
      };
    }

    // Extract values from message using LLM
    const extractionResult = await this.extractFormValues(
      message.content.text || '',
      currentStep.fields.filter(
        (f) =>
          !f.value &&
          (!f.optional || message.content.text?.toLowerCase().includes(f.label.toLowerCase()))
      )
    );

    const updatedFields: string[] = [];
    const errors: Array<{ fieldId: string; message: string }> = [];

    // Update field values
    for (const [fieldId, value] of Object.entries(extractionResult.values)) {
      const field = currentStep.fields.find((f) => f.id === fieldId);
      if (field) {
        if (value !== null && value !== undefined && value !== '') {
          field.value = value;
          field.error = undefined;
          updatedFields.push(fieldId);
          elizaLogger.debug(`Updated field ${fieldId} with value:`, value);
        }
      }
    }

    // Check if all required fields in current step are filled
    const requiredFields = currentStep.fields.filter((f) => !f.optional);
    const filledRequiredFields = requiredFields.filter(
      (f) => f.value !== undefined && f.value !== null && f.value !== ''
    );
    const stepCompleted = filledRequiredFields.length === requiredFields.length;

    let formCompleted = false;
    let responseMessage = '';

    if (stepCompleted) {
      currentStep.completed = true;

      // Execute step callback if defined
      if (currentStep.onComplete) {
        try {
          await currentStep.onComplete(form, currentStep.id);
        } catch (error) {
          elizaLogger.error(`Error in step callback for ${currentStep.id}:`, error);
        }
      }

      // Move to next step or complete form
      if (form.currentStepIndex < form.steps.length - 1) {
        form.currentStepIndex++;
        responseMessage = `Step "${currentStep.name}" completed. Moving to step "${form.steps[form.currentStepIndex].name}".`;
      } else {
        // All steps completed
        form.status = 'completed';
        formCompleted = true;
        responseMessage = 'Form completed successfully!';

        // Execute form completion callback if defined
        if (form.onComplete) {
          try {
            await form.onComplete(form);
          } catch (error) {
            elizaLogger.error('Error in form completion callback:', error);
          }
        }
      }
    } else {
      // Prepare message about missing fields
      const missingRequired = requiredFields.filter((f) => !f.value);
      if (missingRequired.length > 0) {
        responseMessage = `Please provide: ${missingRequired.map((f) => f.label).join(', ')}`;
      }
    }

    form.updatedAt = Date.now();

    return {
      success: true,
      form,
      updatedFields,
      errors,
      stepCompleted,
      formCompleted,
      message: responseMessage,
    };
  }

  /**
   * Extract form values from text using LLM
   */
  private async extractFormValues(
    text: string,
    fields: FormField[]
  ): Promise<{ values: Record<string, string | number | boolean> }> {
    if (fields.length === 0) {
      return { values: {} };
    }

    const prompt = `Extract values for the following form fields from the user's message.
Return a JSON object with field IDs as keys and extracted values.
If a value is not found, omit it from the result.

User message: "${text}"

Fields to extract:
${fields.map((f) => `- ${f.id} (${f.label}): ${f.description || f.type}${f.criteria ? ` - Criteria: ${f.criteria}` : ''}`).join('\n')}

Return only valid JSON with extracted values. Be precise and extract only what is explicitly stated.`;

    try {
      const response = await this.runtime.useModel(ModelType.TEXT_SMALL, {
        messages: [
          {
            role: 'system',
            content:
              'You are a precise form field extractor. Extract only values that are explicitly stated in the text.',
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
        temperature: 0.1,
        max_tokens: 500,
      });

      // The response is directly a string for TEXT_SMALL model
      const content = typeof response === 'string' ? response.trim() : '{}';

      // Extract JSON from response
      let jsonStr = content;
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        jsonStr = jsonMatch[0];
      }

      const values = JSON.parse(jsonStr);
      elizaLogger.debug('Extracted form values:', values);

      return { values };
    } catch (error) {
      elizaLogger.error('Error extracting form values:', error);
      return { values: {} };
    }
  }

  /**
   * List all forms
   */
  async listForms(status?: FormStatus): Promise<Form[]> {
    const forms = Array.from(this.forms.values()).filter(
      (form) => form.agentId === this.runtime.agentId
    );

    if (status) {
      return forms.filter((f) => f.status === status);
    }

    return forms;
  }

  /**
   * Get a specific form
   */
  async getForm(formId: UUID): Promise<Form | null> {
    const form = this.forms.get(formId);
    if (form && form.agentId === this.runtime.agentId) {
      return form;
    }
    return null;
  }

  /**
   * Cancel a form
   */
  async cancelForm(formId: UUID): Promise<boolean> {
    const form = this.forms.get(formId);
    if (!form || form.agentId !== this.runtime.agentId) {
      return false;
    }

    form.status = 'cancelled';
    form.updatedAt = Date.now();
    elizaLogger.debug(`Cancelled form ${formId}`);

    return true;
  }

  /**
   * Register a form template
   */
  registerTemplate(template: FormTemplate): void {
    this.templates.set(template.name, template);
    elizaLogger.debug(`Registered form template: ${template.name}`);
  }

  /**
   * Get all registered templates
   */
  getTemplates(): FormTemplate[] {
    return Array.from(this.templates.values());
  }

  /**
   * Clean up old completed/cancelled forms
   */
  async cleanup(olderThanMs: number = 24 * 60 * 60 * 1000): Promise<number> {
    const now = Date.now();
    let removed = 0;

    for (const [id, form] of this.forms.entries()) {
      if (
        (form.status === 'completed' || form.status === 'cancelled') &&
        now - form.updatedAt > olderThanMs
      ) {
        this.forms.delete(id);
        removed++;
      }
    }

    if (removed > 0) {
      elizaLogger.debug(`Cleaned up ${removed} old forms`);
    }

    return removed;
  }

  async stop(): Promise<void> {
    // Persist forms before stopping
    await this.persistForms();

    // Clear timers
    if (this.persistenceTimer) {
      clearInterval(this.persistenceTimer);
    }
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
  }

  private async persistForms(): Promise<void> {
    try {
      // For now, we'll keep using in-memory storage
      // TODO: Implement database persistence using formsTable and formFieldsTable
      elizaLogger.debug('Forms persistence is currently in-memory only');
    } catch (error) {
      elizaLogger.error('Error persisting forms:', error);
    }
  }

  private async restorePersistedForms(): Promise<void> {
    try {
      // For now, we'll keep using in-memory storage
      // TODO: Implement database restoration using formsTable and formFieldsTable
      elizaLogger.debug('Forms restoration from database not yet implemented');
    } catch (error) {
      elizaLogger.error('Error restoring forms:', error);
    }
  }

  private serializeForm(form: Form): any {
    // Convert functions to null for JSON serialization
    return {
      ...form,
      onComplete: undefined,
      steps: form.steps.map((step) => ({
        ...step,
        onComplete: undefined,
      })),
    };
  }

  private deserializeForm(data: any): Form {
    // Restore form structure (callbacks will be re-registered by the creating plugin)
    return {
      ...data,
      createdAt: new Date(data.createdAt).getTime(),
      updatedAt: new Date(data.updatedAt).getTime(),
      completedAt: data.completedAt ? new Date(data.completedAt).getTime() : undefined,
    };
  }

  private async cleanupOldForms(): Promise<void> {
    const now = Date.now();
    const expirationTime = 24 * 60 * 60 * 1000; // 24 hours

    for (const [id, form] of this.forms.entries()) {
      const age = now - form.updatedAt;

      // Remove completed forms older than 1 hour
      if (form.status === 'completed' && age > 60 * 60 * 1000) {
        this.forms.delete(id);
        elizaLogger.info(`Cleaned up completed form ${id}`);
      }
      // Remove cancelled or inactive forms older than 24 hours
      else if (form.status !== 'active' && age > expirationTime) {
        this.forms.delete(id);
        elizaLogger.info(`Cleaned up old form ${id}`);
      }
    }

    await this.persistForms();
  }
}
