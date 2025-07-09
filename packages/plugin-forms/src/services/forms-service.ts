import {
  asUUID,
  logger,
  IAgentRuntime,
  ModelType,
  Service,
  ServiceType,
  type Memory,
  type UUID,
  type IDatabaseAdapter,
  encryptStringValue,
  decryptStringValue,
  getSalt,
} from '@elizaos/core';
import { v4 as uuidv4 } from 'uuid';
import type { Form, FormField, FormFieldType, FormStatus, FormTemplate, FormUpdateResult } from '../types';

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

  async initialize(runtime: IAgentRuntime): Promise<void> {
    this.registerDefaultTemplates();

    // Check if database tables exist
    await this.checkDatabaseTables();

    // Restore persisted forms only if tables exist
    if (this.tablesExist) {
      await this.restorePersistedForms();
    } else {
      logger.warn('Forms database tables not found. Persistence disabled until tables are created.');
    }

    // Set up auto-persistence
    this.persistenceTimer = setInterval(() => {
      this.persistForms().catch((err) => logger.error('Failed to persist forms:', err));
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

      // Validate JSON parsing
      let values: Record<string, any> = {};
      try {
        const parsed = JSON.parse(jsonStr);
        
        // Validate that parsed result is an object
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          logger.warn('LLM response is not a valid object');
          return { values: {} };
        }
        
        // Validate and sanitize each field
        for (const [fieldId, value] of Object.entries(parsed)) {
          // Check if fieldId is one of the expected fields
          const expectedField = fields.find(f => f.id === fieldId);
          if (!expectedField) {
            logger.warn(`Unexpected field ID in LLM response: ${fieldId}`);
            continue;
          }
          
          // Validate value type based on field type
          if (value !== null && value !== undefined) {
            switch (expectedField.type) {
              case 'number':
                // Try to convert to number
                const numValue = Number(value);
                if (!isNaN(numValue)) {
                  values[fieldId] = numValue;
                } else {
                  logger.warn(`Invalid number value for field ${fieldId}: ${value}`);
                }
                break;
                
              case 'checkbox':
                // Convert to boolean
                values[fieldId] = value === true || value === 'true' || value === 1 || value === '1';
                break;
                
              case 'email':
                // Basic email validation
                if (typeof value === 'string' && value.includes('@')) {
                  values[fieldId] = value.trim();
                } else {
                  logger.warn(`Invalid email value for field ${fieldId}: ${value}`);
                }
                break;
                
              case 'url':
                // Basic URL validation
                if (typeof value === 'string' && (value.startsWith('http://') || value.startsWith('https://'))) {
                  values[fieldId] = value.trim();
                } else {
                  logger.warn(`Invalid URL value for field ${fieldId}: ${value}`);
                }
                break;
                
              case 'date':
              case 'time':
              case 'datetime':
                // Accept string dates/times
                if (typeof value === 'string' && value.length > 0) {
                  values[fieldId] = value.trim();
                } else {
                  logger.warn(`Invalid date/time value for field ${fieldId}: ${value}`);
                }
                break;
                
              default:
                // For text, textarea, tel, and other string types
                if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
                  values[fieldId] = String(value).trim();
                } else {
                  logger.warn(`Invalid value type for field ${fieldId}: ${typeof value}`);
                }
            }
          }
        }
        
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
    // Persist forms before stopping
    await this.persistForms();

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
      const db = this.runtime as IDatabaseAdapter;
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

      const db = this.runtime as IDatabaseAdapter;
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
        
        try {
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
        } catch (error) {
          logger.error(`Error persisting form ${formId}:`, error);
        }
      }

      logger.debug(`Persisted ${this.forms.size} forms to database`);
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

      const db = this.runtime as IDatabaseAdapter;
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
          // Parse steps
          const steps = JSON.parse(formRow.steps);
          
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

          // Reconstruct form with fields
          const form: Form = {
            id: formRow.id as UUID,
            agentId: formRow.agent_id as UUID,
            name: formRow.name,
            description: formRow.description || undefined,
            status: formRow.status as FormStatus,
            currentStepIndex: formRow.current_step_index,
            steps: steps.map((step: any) => ({
              id: step.id,
              name: step.name,
              completed: step.completed || false,
              fields: (fieldsByStep.get(step.id) || []).map((fieldRow: any) => ({
                id: fieldRow.field_id,
                label: fieldRow.label,
                type: fieldRow.type as FormFieldType,
                description: fieldRow.description || undefined,
                criteria: fieldRow.criteria || undefined,
                optional: fieldRow.is_optional,
                secret: fieldRow.is_secret,
                value: fieldRow.value !== null ? this.parseFieldValue(fieldRow.value, fieldRow.type, fieldRow.is_secret) : undefined,
                error: fieldRow.error || undefined,
                metadata: fieldRow.metadata ? JSON.parse(fieldRow.metadata) : undefined,
              })),
            })),
            createdAt: new Date(formRow.created_at).getTime(),
            updatedAt: new Date(formRow.updated_at).getTime(),
            completedAt: formRow.completed_at ? new Date(formRow.completed_at).getTime() : undefined,
            metadata: formRow.metadata ? JSON.parse(formRow.metadata) : {},
          };

          this.forms.set(form.id, form);
          logger.debug(`Restored form ${form.id} (${form.name}) from database`);
        } catch (error) {
          logger.error(`Error restoring form ${formRow.id}:`, error);
        }
      }

      logger.info(`Restored ${this.forms.size} forms from database`);
    } catch (error) {
      logger.error('Error restoring forms:', error);
    }
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
    // Use the public cleanup method with default 24 hour expiration
    await this.cleanup(24 * 60 * 60 * 1000);
  }
}
