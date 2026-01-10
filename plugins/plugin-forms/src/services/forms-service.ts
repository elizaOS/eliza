import {
  asUUID,
  logger,
  IAgentRuntime,
  ModelType,
  Service,
  type Memory,
  type UUID,
  type IDatabaseAdapter,
  encryptStringValue,
  decryptStringValue,
  getSalt,
} from '@elizaos/core';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import type { Form, FormField, FormFieldType, FormStatus, FormTemplate, FormUpdateResult } from '../types';

const FORMS_CLEANUP_INTERVAL = 60 * 60 * 1000; // 1 hour

// Zod schemas for validation
const FormStatusSchema = z.enum(['active', 'completed', 'cancelled']);

const FormFieldTypeSchema = z.enum([
  'text', 'number', 'email', 'tel', 'url', 'textarea',
  'choice', 'checkbox', 'date', 'time', 'datetime'
]);

const FormStepSchema = z.object({
  id: z.string(),
  name: z.string(),
  completed: z.boolean().optional().default(false),
});

const DatabaseFormRowSchema = z.object({
  id: z.string().uuid(),
  agent_id: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable(),
  status: FormStatusSchema,
  current_step_index: z.number().int().min(0),
  steps: z.string().transform((val, ctx) => {
    try {
      const parsed = JSON.parse(val);
      const result = z.array(FormStepSchema).safeParse(parsed);
      if (!result.success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Invalid steps format',
        });
        return z.NEVER;
      }
      return result.data;
    } catch (e) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Invalid JSON in steps',
      });
      return z.NEVER;
    }
  }),
  created_at: z.union([z.string(), z.date()]).transform(val => new Date(val).getTime()),
  updated_at: z.union([z.string(), z.date()]).transform(val => new Date(val).getTime()),
  completed_at: z.union([z.string(), z.date()]).nullable().transform(val => val ? new Date(val).getTime() : undefined),
  metadata: z.string().nullable().transform((val, ctx) => {
    if (!val) return {};
    try {
      return JSON.parse(val);
    } catch (e) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Invalid JSON in metadata',
      });
      return {};
    }
  }),
});

// Raw schema for database rows (before decryption)
const DatabaseFieldRowSchema = z.object({
  field_id: z.string(),
  step_id: z.string(),
  label: z.string(),
  type: FormFieldTypeSchema,
  value: z.string().nullable(),
  is_secret: z.union([z.boolean(), z.number()]).transform(val => Boolean(val)),
  is_optional: z.union([z.boolean(), z.number()]).transform(val => Boolean(val)),
  description: z.string().nullable(),
  criteria: z.string().nullable(),
  error: z.string().nullable(),
  metadata: z.string().nullable().transform((val, ctx) => {
    if (!val) return undefined;
    try {
      return JSON.parse(val);
    } catch (_e) {
      return undefined;
    }
  }),
});

// Schema for validating decrypted field values
const createFieldValueSchema = (type: FormFieldType) => {
  switch (type) {
    case 'email':
      return z.string().email();
    case 'url':
      return z.string().url();
    case 'number':
      return z.number();
    case 'checkbox':
      return z.boolean();
    case 'tel':
      return z.string().min(7);
    case 'date':
    case 'time':
    case 'datetime':
      return z.string().min(1);
    default:
      return z.union([z.string(), z.number(), z.boolean()]);
  }
};

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
  private tablesChecked = false;
  private tablesExist = false;

  capabilityDescription = 'Form management service for collecting structured data from users';

  constructor(runtime: IAgentRuntime) {
    super(runtime);
    this.initialize(runtime);
  }

  static async start(runtime: IAgentRuntime): Promise<FormsService> {
    const service = new FormsService(runtime);
    return service;
  }

  async initialize(_runtime: IAgentRuntime): Promise<void> {
    this.registerDefaultTemplates();

    // Check if database tables exist
    await this.checkDatabaseTables();

    // Restore persisted forms only if tables exist
    if (this.tablesExist) {
      await this.restorePersistedForms();
    } else {
      logger.warn('Forms database tables not found. Persistence disabled until tables are created.');
    }

    // Set up auto-persistence with batch processing
    this.persistenceTimer = setInterval(() => {
      this.persistFormsBatch().catch((err) => logger.error('Failed to persist forms:', err));
    }, 30000); // Every 30 seconds

    // Set up cleanup of completed/expired forms
    this.cleanupTimer = setInterval(() => {
      this.cleanupOldForms().catch((err) => logger.error('Failed to cleanup forms:', err));
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
   * Force immediate persistence of all forms
   * Uses batch transaction for efficiency and safety
   */
  async forcePersist(): Promise<void> {
    if (this.tablesExist) {
      await this.persistFormsBatch();
    }
  }

  /**
   * Wait for database tables to be available
   * This can be called by plugins that depend on forms persistence
   */
  async waitForTables(maxAttempts = 10, delayMs = 1000): Promise<boolean> {
    for (let i = 0; i < maxAttempts; i++) {
      if (!this.tablesChecked) {
        await this.checkDatabaseTables();
      }
      
      if (this.tablesExist) {
        return true;
      }
      
      if (i < maxAttempts - 1) {
        logger.debug(`Waiting for forms tables... attempt ${i + 1}/${maxAttempts}`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
        this.tablesChecked = false; // Force recheck
      }
    }
    
    logger.warn('Forms tables not available after waiting');
    return false;
  }

  /**
   * Check if persistence is available
   */
  isPersistenceAvailable(): boolean {
    return this.tablesExist;
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
    logger.debug(`Created form ${form.id} (${form.name})`);

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
        (f) => {
          // Check if field already has a valid value
          const hasValue = f.value !== undefined && f.value !== null && f.value !== '';
          if (hasValue) return false;
          
          // For optional fields, only process if mentioned in message
          if (f.optional) {
            const messageText = message.content.text?.toLowerCase() || '';
            const fieldLabel = f.label.toLowerCase();
            // More flexible matching for optional fields
            return messageText.includes(fieldLabel) || 
                   messageText.includes(fieldLabel.replace(/\s+/g, '')) ||
                   messageText.includes(fieldLabel.replace(/\s+/g, '_'));
          }
          
          // Required fields should always be processed
          return true;
        }
      )
    );

    const updatedFields: string[] = [];
    const errors: Array<{ fieldId: string; message: string }> = [];

    // Update field values
    for (const [fieldId, value] of Object.entries(extractionResult.values)) {
      const field = currentStep.fields.find((f) => f.id === fieldId);
      if (field) {
        // Accept all values including falsy ones (false, 0, empty string)
        if (value !== null && value !== undefined) {
          // Additional type validation
          const validatedValue = this.validateFieldValue(value, field);
          if (validatedValue.isValid) {
            // Encrypt secret fields before storing
            if (field.secret && typeof validatedValue.value === 'string') {
              const salt = getSalt();
              field.value = encryptStringValue(validatedValue.value, salt);
            } else {
              field.value = validatedValue.value;
            }
            field.error = undefined;
            updatedFields.push(fieldId);
            logger.debug(`Updated field ${fieldId} with value:`, field.secret ? '[REDACTED]' : validatedValue.value);
          } else {
            field.error = validatedValue.error;
            errors.push({ fieldId, message: validatedValue.error || 'Invalid value' });
            logger.warn(`Invalid value for field ${fieldId}: ${validatedValue.error}`);
          }
        }
      }
    }

    // Check if all required fields in current step are filled
    const requiredFields = currentStep.fields.filter((f) => !f.optional);
    const filledRequiredFields = requiredFields.filter(
      (f) => f.value !== undefined && f.value !== null
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
          logger.error(`Error in step callback for ${currentStep.id}:`, error);
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
            logger.error('Error in form completion callback:', error);
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

      // Validate JSON parsing with Zod
      let values: Record<string, any> = {};
      
      // Create dynamic Zod schema based on expected fields
      const fieldSchemas: Record<string, z.ZodTypeAny> = {};
      for (const field of fields) {
        switch (field.type) {
          case 'number':
            fieldSchemas[field.id] = z.union([z.number(), z.string()]).transform(val => Number(val)).optional();
            break;
          case 'checkbox':
            fieldSchemas[field.id] = z.union([z.boolean(), z.string(), z.number()]).transform(val => 
              val === true || val === 'true' || val === 1 || val === '1'
            ).optional();
            break;
          case 'email':
            fieldSchemas[field.id] = z.string().email().optional();
            break;
          case 'url':
            fieldSchemas[field.id] = z.string().url().optional();
            break;
          default:
            fieldSchemas[field.id] = z.string().optional();
        }
      }
      
      const LLMResponseSchema = z.object(fieldSchemas).passthrough();
      
      try {
        const parsed = JSON.parse(jsonStr);
        const result = LLMResponseSchema.safeParse(parsed);
        
        if (!result.success) {
          logger.warn('Invalid LLM response format:', result.error.format());
          return { values: {} };
        }
        
        // Use validated and transformed values
        values = result.data;
      } catch (parseError) {
        logger.error('Failed to parse LLM JSON response:', parseError);
        return { values: {} };
      }

      logger.debug('Validated and extracted form values:', values);
      return { values };
    } catch (error) {
      logger.error('Error extracting form values:', error);
      return { values: {} };
    }
  }

  /**
   * List all forms
   */
  async listForms(status?: FormStatus): Promise<Form[]> {
    const forms: Form[] = [];
    
    // Directly iterate over the Map instead of converting to array first
    for (const form of this.forms.values()) {
      if (form.agentId === this.runtime.agentId) {
        if (!status || form.status === status) {
          forms.push(form);
        }
      }
    }

    return forms;
  }

  /**
   * Get a specific form
   */
  async getForm(formId: UUID): Promise<Form | null> {
    const form = this.forms.get(formId);
    return (form && form.agentId === this.runtime.agentId) ? form : null;
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
    logger.debug(`Cancelled form ${formId}`);

    return true;
  }

  /**
   * Register a form template
   */
  registerTemplate(template: FormTemplate): void {
    this.templates.set(template.name, template);
    logger.debug(`Registered form template: ${template.name}`);
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
      const age = now - form.updatedAt;
      
      // Remove completed forms older than 1 hour
      if (form.status === 'completed' && age > 60 * 60 * 1000) {
        this.forms.delete(id);
        removed++;
        logger.info(`Cleaned up completed form ${id}`);
      }
      // Remove cancelled or other non-active forms older than specified time
      else if (form.status !== 'active' && age > olderThanMs) {
        this.forms.delete(id);
        removed++;
        logger.info(`Cleaned up old form ${id}`);
      }
    }

    if (removed > 0) {
      logger.debug(`Cleaned up ${removed} old forms`);
      await this.persistForms();
    }

    return removed;
  }

  async stop(): Promise<void> {
    // Persist forms before stopping using batch method
    await this.persistFormsBatch();

    // Clear timers
    if (this.persistenceTimer) {
      clearInterval(this.persistenceTimer);
      this.persistenceTimer = undefined;
    }
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
  }

  private async checkDatabaseTables(): Promise<void> {
    if (this.tablesChecked) return;
    
    try {
      const db = this.runtime as any;
      if (!db.getDatabase) {
        logger.debug('Database adapter not available');
        return;
      }

      const database = await db.getDatabase();
      if (!database) {
        logger.debug('Database not available');
        return;
      }

      // Check if forms table exists
      try {
        const result = await database.get(`
          SELECT EXISTS (
            SELECT FROM information_schema.tables 
            WHERE table_name = 'forms'
          ) as exists
        `);
        
        this.tablesExist = result?.exists || false;
        
        if (!this.tablesExist) {
          // Try with schema prefix
          const schemaResult = await database.get(`
            SELECT EXISTS (
              SELECT FROM information_schema.tables 
              WHERE table_schema LIKE '%forms%' AND table_name = 'forms'
            ) as exists
          `);
          this.tablesExist = schemaResult?.exists || false;
        }
      } catch (error) {
        // If the query fails, assume tables don't exist
        logger.debug('Could not check for forms tables:', error);
        this.tablesExist = false;
      }
      
      this.tablesChecked = true;
      logger.info(`Forms database tables ${this.tablesExist ? 'found' : 'not found'}`);
    } catch (error) {
      logger.error('Error checking database tables:', error);
      this.tablesChecked = true;
      this.tablesExist = false;
    }
  }

  private async persistFormsBatch(): Promise<void> {
    try {
      // Skip if tables don't exist
      if (!this.tablesExist) {
        return;
      }

      const db = this.runtime as any;
      if (!db.getDatabase) {
        return;
      }

      const database = await db.getDatabase();
      if (!database) {
        return;
      }

      // Collect all forms to persist
      const formsToPersist: Array<{ form: Form; formId: UUID }> = [];
      for (const [formId, form] of this.forms.entries()) {
        if (form.agentId === this.runtime.agentId) {
          formsToPersist.push({ form, formId });
        }
      }

      if (formsToPersist.length === 0) {
        return;
      }

      // Use a single transaction for all forms
      try {
        await database.run('BEGIN');

        // Batch insert/update all forms
        for (const { form } of formsToPersist) {
          const formData = {
            id: form.id,
            agentId: form.agentId,
            name: form.name,
            description: form.description || null,
            status: form.status,
            currentStepIndex: form.currentStepIndex,
            steps: JSON.stringify(form.steps.map(step => ({
              id: step.id,
              name: step.name,
              completed: step.completed,
            }))),
            createdAt: new Date(form.createdAt),
            updatedAt: new Date(form.updatedAt),
            completedAt: form.completedAt ? new Date(form.completedAt) : null,
            metadata: JSON.stringify(form.metadata || {}),
          };

          await database.run(`
            INSERT INTO forms (id, agent_id, name, description, status, current_step_index, steps, created_at, updated_at, completed_at, metadata)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              status = EXCLUDED.status,
              current_step_index = EXCLUDED.current_step_index,
              steps = EXCLUDED.steps,
              updated_at = EXCLUDED.updated_at,
              completed_at = EXCLUDED.completed_at,
              metadata = EXCLUDED.metadata
          `, [formData.id, formData.agentId, formData.name, formData.description, formData.status,
              formData.currentStepIndex, formData.steps, formData.createdAt, formData.updatedAt,
              formData.completedAt, formData.metadata]);

          // Batch insert/update all fields for this form
          for (const step of form.steps) {
            for (const field of step.fields) {
              const fieldData = {
                formId: form.id,
                stepId: step.id,
                fieldId: field.id,
                label: field.label,
                type: field.type,
                value: field.value !== undefined && field.value !== null ? String(field.value) : null,
                isSecret: field.secret || false,
                isOptional: field.optional || false,
                description: field.description || null,
                criteria: field.criteria || null,
                error: field.error || null,
                metadata: JSON.stringify(field.metadata || {}),
              };

              await database.run(`
                INSERT INTO form_fields (form_id, step_id, field_id, label, type, value, is_secret, is_optional, description, criteria, error, metadata, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
                ON CONFLICT(form_id, step_id, field_id) DO UPDATE SET
                  value = EXCLUDED.value,
                  error = EXCLUDED.error,
                  updated_at = datetime('now')
              `, [fieldData.formId, fieldData.stepId, fieldData.fieldId, fieldData.label,
                  fieldData.type, fieldData.value, fieldData.isSecret, fieldData.isOptional,
                  fieldData.description, fieldData.criteria, fieldData.error, fieldData.metadata]);
            }
          }
        }

        // Commit all changes at once
        await database.run('COMMIT');
        logger.debug(`Successfully persisted ${formsToPersist.length} forms in batch`);
      } catch (error: any) {
        // Rollback entire batch on any error
        try {
          await database.run('ROLLBACK');
        } catch (rollbackError) {
          logger.error('Error rolling back batch transaction:', rollbackError);
        }
        
        if (error.message?.includes('does not exist') || error.message?.includes('no such table')) {
          logger.warn('Forms tables do not exist. Marking tables as not found.');
          this.tablesExist = false;
          return;
        }
        
        // If batch fails, fall back to individual transactions
        logger.warn('Batch persistence failed, falling back to individual transactions:', error);
        await this.persistFormsIndividual();
      }
    } catch (error) {
      logger.error('Error in batch persistence:', error);
    }
  }

  private async persistFormsIndividual(): Promise<void> {
    // Original implementation with individual transactions
    await this.persistForms();
  }

  private async persistForms(): Promise<void> {
    try {
      // Skip if tables don't exist
      if (!this.tablesExist) {
        // Periodically recheck in case tables were created
        if (!this.tablesChecked || Math.random() < 0.1) { // Check 10% of the time
          await this.checkDatabaseTables();
        }
        if (!this.tablesExist) {
          return;
        }
      }

      const db = this.runtime as any;
      if (!db.getDatabase) {
        logger.warn('Database adapter not available for form persistence');
        return;
      }

      const database = await db.getDatabase();
      if (!database) {
        logger.warn('Database not available for form persistence');
        return;
      }

      // Persist each form to the database
      for (const [formId, form] of this.forms.entries()) {
        if (form.agentId !== this.runtime.agentId) continue;
        
        // Wrap each form's persistence in a transaction
        try {
          await database.run('BEGIN');
          
          // Serialize form data for database storage
          const formData = {
            id: form.id,
            agentId: form.agentId,
            name: form.name,
            description: form.description || null,
            status: form.status,
            currentStepIndex: form.currentStepIndex,
            steps: JSON.stringify(form.steps.map(step => ({
              id: step.id,
              name: step.name,
              completed: step.completed,
              // Don't serialize callbacks
            }))),
            createdAt: new Date(form.createdAt),
            updatedAt: new Date(form.updatedAt),
            completedAt: form.completedAt ? new Date(form.completedAt) : null,
            metadata: JSON.stringify(form.metadata || {}),
          };

          // Use raw SQL for compatibility with different database adapters
          try {
            await database.run(`
              INSERT INTO forms (id, agent_id, name, description, status, current_step_index, steps, created_at, updated_at, completed_at, metadata)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET
                status = EXCLUDED.status,
                current_step_index = EXCLUDED.current_step_index,
                steps = EXCLUDED.steps,
                updated_at = EXCLUDED.updated_at,
                completed_at = EXCLUDED.completed_at,
                metadata = EXCLUDED.metadata
            `, [formData.id, formData.agentId, formData.name, formData.description, formData.status, 
                formData.currentStepIndex, formData.steps, formData.createdAt, formData.updatedAt, 
                formData.completedAt, formData.metadata]);
          } catch (dbError: any) {
            if (dbError.message?.includes('does not exist') || dbError.message?.includes('no such table')) {
              logger.warn('Forms table does not exist. Marking tables as not found.');
              this.tablesExist = false;
              return;
            }
            throw dbError;
          }

          // Persist form fields
          for (const step of form.steps) {
            for (const field of step.fields) {
              const fieldData = {
                formId: form.id,
                stepId: step.id,
                fieldId: field.id,
                label: field.label,
                type: field.type,
                value: field.value !== undefined && field.value !== null ? String(field.value) : null,
                isSecret: field.secret || false,
                isOptional: field.optional || false,
                description: field.description || null,
                criteria: field.criteria || null,
                error: field.error || null,
                metadata: JSON.stringify(field.metadata || {}),
              };

              try {
                await database.run(`
                  INSERT INTO form_fields (form_id, step_id, field_id, label, type, value, is_secret, is_optional, description, criteria, error, metadata, created_at, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
                  ON CONFLICT(form_id, step_id, field_id) DO UPDATE SET
                    value = EXCLUDED.value,
                    error = EXCLUDED.error,
                    updated_at = datetime('now')
                `, [fieldData.formId, fieldData.stepId, fieldData.fieldId, fieldData.label, 
                    fieldData.type, fieldData.value, fieldData.isSecret, fieldData.isOptional, 
                    fieldData.description, fieldData.criteria, fieldData.error, fieldData.metadata]);
              } catch (dbError: any) {
                if (dbError.message?.includes('does not exist') || dbError.message?.includes('no such table')) {
                  logger.warn('Form fields table does not exist. Marking tables as not found.');
                  this.tablesExist = false;
                  return;
                }
                throw dbError;
              }
            }
          }
          
          // Commit the transaction if all operations succeeded
          await database.run('COMMIT');
        } catch (error) {
          // Rollback on any error
          try {
            await database.run('ROLLBACK');
          } catch (rollbackError) {
            logger.error(`Error rolling back transaction for form ${formId}:`, rollbackError);
          }
          logger.error(`Error persisting form ${formId}:`, error);
        }
      }

      logger.debug(`Persisted forms to database`);
    } catch (error) {
      logger.error('Error persisting forms:', error);
    }
  }

  private async restorePersistedForms(): Promise<void> {
    try {
      // Skip if tables don't exist
      if (!this.tablesExist) {
        return;
      }

      const db = this.runtime as any;
      if (!db.getDatabase) {
        logger.warn('Database adapter not available for form restoration');
        return;
      }

      const database = await db.getDatabase();
      if (!database) {
        logger.warn('Database not available for form restoration');
        return;
      }

      // Restore forms from database
      let formsResult;
      try {
        formsResult = await database.all(`
          SELECT * FROM forms 
          WHERE agent_id = ? AND status != 'completed'
          ORDER BY updated_at DESC
        `, [this.runtime.agentId]);
      } catch (error: any) {
        if (error.message?.includes('does not exist') || error.message?.includes('no such table')) {
          logger.debug('Forms table does not exist during restoration');
          this.tablesExist = false;
          return;
        }
        throw error;
      }

      if (!formsResult || formsResult.length === 0) {
        logger.debug('No forms to restore from database');
        return;
      }

      for (const formRow of formsResult) {
        try {
          // Validate and sanitize form data
          const validatedForm = this.validateAndSanitizeFormData(formRow);
          if (!validatedForm) {
            logger.warn(`Skipping invalid form ${formRow.id}`);
            continue;
          }

          // Parse steps from validated form
          const steps = validatedForm.steps;
          
          // Restore form fields
          let fieldsResult;
          try {
            fieldsResult = await database.all(`
              SELECT * FROM form_fields 
              WHERE form_id = ?
              ORDER BY step_id, field_id
            `, [formRow.id]);
          } catch (error: any) {
            if (error.message?.includes('does not exist') || error.message?.includes('no such table')) {
              logger.debug('Form fields table does not exist during restoration');
              this.tablesExist = false;
              return;
            }
            throw error;
          }

          // Group fields by step
          const fieldsByStep = new Map<string, typeof fieldsResult>();
          for (const fieldRow of fieldsResult) {
            if (!fieldsByStep.has(fieldRow.step_id)) {
              fieldsByStep.set(fieldRow.step_id, []);
            }
            fieldsByStep.get(fieldRow.step_id)!.push(fieldRow);
          }

          // Reconstruct form with validated fields
          const form: Form = {
            ...validatedForm,
            steps: steps.map((step: any) => ({
              id: step.id,
              name: step.name,
              completed: step.completed || false,
              fields: (fieldsByStep.get(step.id) || []).map((fieldRow: any) => {
                const validatedField = this.validateAndSanitizeFieldData(fieldRow);
                if (!validatedField) {
                  logger.warn(`Skipping invalid field ${fieldRow.field_id} in form ${formRow.id}`);
                  return null;
                }
                
                // Decrypt first if needed
                let fieldValue = fieldRow.value !== null 
                  ? this.parseFieldValue(fieldRow.value, fieldRow.type, fieldRow.is_secret) 
                  : undefined;
                
                // Validate decrypted value
                if (fieldValue !== undefined) {
                  const valueSchema = createFieldValueSchema(validatedField.type);
                  const valueResult = valueSchema.safeParse(fieldValue);
                  
                  if (!valueResult.success) {
                    logger.warn(`Invalid field value after decryption for ${fieldRow.field_id}:`, valueResult.error.format());
                    fieldValue = undefined; // Clear invalid values
                  } else {
                    fieldValue = valueResult.data; // Use validated value
                  }
                }
                
                return {
                  ...validatedField,
                  value: fieldValue,
                };
              }).filter(field => field !== null),
            })),
          };

          // Only add form if it has at least one valid step with fields
          const hasValidSteps = form.steps.some(step => step.fields.length > 0);
          if (hasValidSteps) {
            this.forms.set(form.id, form);
            logger.debug(`Restored form ${form.id} (${form.name}) from database`);
          } else {
            logger.warn(`Form ${form.id} has no valid steps/fields, skipping`);
          }
        } catch (error) {
          logger.error(`Error restoring form ${formRow.id}:`, error);
        }
      }

      logger.info(`Restored ${this.forms.size} forms from database`);
    } catch (error) {
      logger.error('Error restoring forms:', error);
    }
  }

  private validateAndSanitizeFormData(formRow: any): Omit<Form, 'steps'> & { steps: any[] } | null {
    const result = DatabaseFormRowSchema.safeParse(formRow);
    
    if (!result.success) {
      logger.warn(`Invalid form data for ${formRow.id}:`, result.error.format());
      return null;
    }

    const validated = result.data;
    return {
      id: validated.id as UUID,
      agentId: validated.agent_id as UUID,
      name: validated.name,
      description: validated.description || undefined,
      status: validated.status,
      currentStepIndex: validated.current_step_index,
      steps: validated.steps,
      createdAt: validated.created_at,
      updatedAt: validated.updated_at,
      completedAt: validated.completed_at,
      metadata: validated.metadata,
    };
  }

  private validateAndSanitizeFieldData(fieldRow: any): Omit<FormField, 'value'> | null {
    const result = DatabaseFieldRowSchema.safeParse(fieldRow);
    
    if (!result.success) {
      logger.warn(`Invalid field data:`, result.error.format());
      return null;
    }

    const validated = result.data;
    return {
      id: validated.field_id,
      label: validated.label,
      type: validated.type,
      description: validated.description || undefined,
      criteria: validated.criteria || undefined,
      optional: validated.is_optional,
      secret: validated.is_secret,
      error: validated.error || undefined,
      metadata: validated.metadata,
    };
  }

  private parseFieldValue(value: string, type: string, isSecret: boolean = false): string | number | boolean {
    // Decrypt secret values first
    let processedValue = value;
    if (isSecret && type !== 'number' && type !== 'checkbox') {
      const salt = getSalt();
      processedValue = decryptStringValue(value, salt);
    }
    
    switch (type) {
      case 'number':
        return Number(processedValue);
      case 'checkbox':
        return processedValue === 'true';
      default:
        return processedValue;
    }
  }

  private validateFieldValue(value: any, field: FormField): { isValid: boolean; value?: any; error?: string } {
    switch (field.type) {
      case 'number':
        const num = Number(value);
        if (isNaN(num)) {
          return { isValid: false, error: 'Must be a valid number' };
        }
        return { isValid: true, value: num };
        
      case 'email':
        if (typeof value !== 'string' || !value.includes('@') || !value.includes('.')) {
          return { isValid: false, error: 'Must be a valid email address' };
        }
        return { isValid: true, value: value.trim() };
        
      case 'url':
        if (typeof value !== 'string' || (!value.startsWith('http://') && !value.startsWith('https://'))) {
          return { isValid: false, error: 'Must be a valid URL starting with http:// or https://' };
        }
        return { isValid: true, value: value.trim() };
        
      case 'tel':
        if (typeof value !== 'string' || value.length < 7) {
          return { isValid: false, error: 'Must be a valid phone number' };
        }
        return { isValid: true, value: value.trim() };
        
      case 'date':
      case 'time':
      case 'datetime':
        if (typeof value !== 'string' || !value) {
          return { isValid: false, error: `Must be a valid ${field.type}` };
        }
        return { isValid: true, value: value.trim() };
        
      case 'checkbox':
        return { isValid: true, value: Boolean(value) };
        
      default:
        // For text, textarea, choice - accept strings
        if (value === null || value === undefined) {
          return { isValid: false, error: 'Value is required' };
        }
        return { isValid: true, value: String(value) };
    }
  }

  private _serializeForm(form: Form): any {
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

  private _deserializeForm(data: any): Form {
    // Restore form structure (callbacks will be re-registered by the creating plugin)
    return {
      ...data,
      createdAt: new Date(data.createdAt).getTime(),
      updatedAt: new Date(data.updatedAt).getTime(),
      completedAt: data.completedAt ? new Date(data.completedAt).getTime() : undefined,
    };
  }

  private async cleanupOldForms(): Promise<void> {
    // Use the public cleanup method with default 24 hour expiration
    await this.cleanup(24 * 60 * 60 * 1000);
  }
}
