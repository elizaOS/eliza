import type { IAgentRuntime, Memory, UUID } from "@elizaos/core";
import {
  asUUID,
  decryptStringValue,
  encryptStringValue,
  getSalt,
  logger,
  ModelType,
  parseKeyValueXml,
  Service,
} from "@elizaos/core";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import type {
  Form,
  FormField,
  FormFieldType,
  FormStatus,
  FormTemplate,
  FormUpdateResult,
} from "../types";
import { buildExtractionPrompt } from "../utils/prompt-builders.js";

const FORMS_CLEANUP_INTERVAL = 60 * 60 * 1000; // 1 hour

interface RuntimeWithDatabase {
  getDatabase?: () => Promise<unknown> | unknown;
}

function getDatabaseFromRuntime(runtime: IAgentRuntime): Promise<unknown> | unknown | null {
  const runtimeWithDb = runtime as RuntimeWithDatabase;
  if (!runtimeWithDb.getDatabase || typeof runtimeWithDb.getDatabase !== "function") {
    return null;
  }
  return runtimeWithDb.getDatabase();
}

const FormStatusSchema = z.enum(["active", "completed", "cancelled"]);

const FormFieldTypeSchema = z.enum([
  "text",
  "number",
  "email",
  "tel",
  "url",
  "textarea",
  "choice",
  "checkbox",
  "date",
  "time",
  "datetime",
]);

const FormStepSchema = z.object({
  id: z.string(),
  name: z.string(),
  completed: z.boolean().optional().default(false),
});

type DatabaseFormStep = z.infer<typeof FormStepSchema>;

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
          message: "Invalid steps format",
        });
        return z.NEVER;
      }
      return result.data;
    } catch (_e) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Invalid JSON in steps",
      });
      return z.NEVER;
    }
  }),
  created_at: z.union([z.string(), z.date()]).transform((val) => new Date(val).getTime()),
  updated_at: z.union([z.string(), z.date()]).transform((val) => new Date(val).getTime()),
  completed_at: z
    .union([z.string(), z.date()])
    .nullable()
    .transform((val) => (val ? new Date(val).getTime() : undefined)),
  metadata: z
    .string()
    .nullable()
    .transform((val, ctx) => {
      if (!val) return {};
      try {
        return JSON.parse(val);
      } catch (_e) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Invalid JSON in metadata",
        });
        return {};
      }
    }),
});

const DatabaseFieldRowSchema = z.object({
  field_id: z.string(),
  step_id: z.string(),
  label: z.string(),
  type: FormFieldTypeSchema,
  value: z.string().nullable(),
  is_secret: z.union([z.boolean(), z.number()]).transform((val) => Boolean(val)),
  is_optional: z.union([z.boolean(), z.number()]).transform((val) => Boolean(val)),
  description: z.string().nullable(),
  criteria: z.string().nullable(),
  error: z.string().nullable(),
  metadata: z
    .string()
    .nullable()
    .transform((val, _ctx) => {
      if (!val) return undefined;
      try {
        return JSON.parse(val);
      } catch (_e) {
        return undefined;
      }
    }),
});

const createFieldValueSchema = (type: FormFieldType) => {
  switch (type) {
    case "email":
      return z.string().email();
    case "url":
      return z.string().url();
    case "number":
      return z.number();
    case "checkbox":
      return z.boolean();
    case "tel":
      return z.string().min(7);
    case "date":
    case "time":
    case "datetime":
      return z.string().min(1);
    default:
      return z.union([z.string(), z.number(), z.boolean()]);
  }
};

export class FormsService extends Service {
  static serviceName = "forms";
  static serviceType = "forms";

  private forms: Map<UUID, Form> = new Map();
  private templates: Map<string, FormTemplate> = new Map();
  private persistenceTimer?: NodeJS.Timeout;
  private cleanupTimer?: NodeJS.Timeout;
  private tablesChecked = false;
  private tablesExist = false;

  capabilityDescription = "Form management service for collecting structured data from users";

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

    await this.checkDatabaseTables();

    if (this.tablesExist) {
      await this.restorePersistedForms();
    } else {
      logger.warn(
        "Forms database tables not found. Persistence disabled until tables are created."
      );
    }

    this.persistenceTimer = setInterval(() => {
      this.persistFormsBatch().catch((err) => logger.error("Failed to persist forms:", err));
    }, 30000);

    this.cleanupTimer = setInterval(() => {
      this.cleanupOldForms().catch((err) => logger.error("Failed to cleanup forms:", err));
    }, FORMS_CLEANUP_INTERVAL);
  }

  private registerDefaultTemplates() {
    this.templates.set("contact", {
      name: "contact",
      description: "Basic contact information form",
      steps: [
        {
          id: "basic-info",
          name: "Basic Information",
          fields: [
            {
              id: "name",
              label: "Name",
              type: "text",
              description: "Your full name",
              criteria: "First and last name",
            },
            {
              id: "email",
              label: "Email",
              type: "email",
              description: "Your email address",
              criteria: "Valid email format",
            },
            {
              id: "message",
              label: "Message",
              type: "textarea",
              description: "Your message",
              optional: true,
            },
          ],
        },
      ],
    });
  }

  async forcePersist(): Promise<void> {
    if (this.tablesExist) {
      await this.persistFormsBatch();
    }
  }

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
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        this.tablesChecked = false;
      }
    }

    logger.warn("Forms tables not available after waiting");
    return false;
  }

  isPersistenceAvailable(): boolean {
    return this.tablesExist;
  }

  async createForm(
    templateOrForm: string | Partial<Form>,
    metadata?: Record<string, unknown>
  ): Promise<Form> {
    let form: Form;

    if (typeof templateOrForm === "string") {
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
          fields: step.fields.map((field) => ({ ...field })),
        })),
        currentStepIndex: 0,
        status: "active",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        metadata: metadata || {},
      };
    } else {
      form = {
        id: asUUID(uuidv4()),
        agentId: this.runtime.agentId,
        status: "active",
        currentStepIndex: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        ...templateOrForm,
        steps: templateOrForm.steps?.map((step) => ({
          ...step,
          completed: false,
        })),
      } as Form;
    }

    this.forms.set(form.id, form);
    logger.debug(`Created form ${form.id} (${form.name})`);

    return form;
  }

  async updateForm(formId: UUID, message: Memory): Promise<FormUpdateResult> {
    const form = this.forms.get(formId);
    if (!form) {
      return {
        success: false,
        message: "Form not found",
      };
    }

    if (form.status !== "active") {
      return {
        success: false,
        message: "Form is not active",
      };
    }

    const currentStep = form.steps[form.currentStepIndex];
    if (!currentStep) {
      return {
        success: false,
        message: "No current step",
      };
    }

    const extractionResult = await this.extractFormValues(
      message.content.text || "",
      currentStep.fields.filter((f) => {
        const hasValue = f.value !== undefined && f.value !== null && f.value !== "";
        if (hasValue) return false;

        if (f.optional) {
          const messageText = message.content.text?.toLowerCase() || "";
          const fieldLabel = f.label.toLowerCase();
          return (
            messageText.includes(fieldLabel) ||
            messageText.includes(fieldLabel.replace(/\s+/g, "")) ||
            messageText.includes(fieldLabel.replace(/\s+/g, "_"))
          );
        }

        return true;
      })
    );

    const updatedFields: string[] = [];
    const errors: Array<{ fieldId: string; message: string }> = [];

    for (const [fieldId, value] of Object.entries(extractionResult.values)) {
      const field = currentStep.fields.find((f) => f.id === fieldId);
      if (field) {
        if (value !== null && value !== undefined) {
          const validatedValue = this.validateFieldValue(value, field);
          if (validatedValue.isValid) {
            if (field.secret && typeof validatedValue.value === "string") {
              const salt = getSalt();
              field.value = encryptStringValue(validatedValue.value, salt);
            } else {
              field.value = validatedValue.value;
            }
            field.error = undefined;
            updatedFields.push(fieldId);
            logger.debug(
              `Updated field ${fieldId} with value:`,
              field.secret ? "[REDACTED]" : String(validatedValue.value)
            );
          } else {
            field.error = validatedValue.error;
            errors.push({
              fieldId,
              message: validatedValue.error || "Invalid value",
            });
            logger.warn(`Invalid value for field ${fieldId}: ${validatedValue.error}`);
          }
        }
      }
    }

    const requiredFields = currentStep.fields.filter((f) => !f.optional);
    const filledRequiredFields = requiredFields.filter(
      (f) => f.value !== undefined && f.value !== null
    );
    const stepCompleted = filledRequiredFields.length === requiredFields.length;

    let formCompleted = false;
    let responseMessage = "";

    if (stepCompleted) {
      currentStep.completed = true;

      if (currentStep.onComplete) {
        await currentStep.onComplete(form, currentStep.id);
      }

      if (form.currentStepIndex < form.steps.length - 1) {
        form.currentStepIndex++;
        responseMessage = `Step "${currentStep.name}" completed. Moving to step "${form.steps[form.currentStepIndex].name}".`;
      } else {
        form.status = "completed";
        formCompleted = true;
        responseMessage = "Form completed successfully!";

        if (form.onComplete) {
          await form.onComplete(form);
        }
      }
    } else {
      const missingRequired = requiredFields.filter((f) => !f.value);
      if (missingRequired.length > 0) {
        responseMessage = `Please provide: ${missingRequired.map((f) => f.label).join(", ")}`;
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

  private async extractFormValues(
    text: string,
    fields: FormField[]
  ): Promise<{ values: Record<string, string | number | boolean> }> {
    if (fields.length === 0) {
      return { values: {} };
    }

    const prompt = buildExtractionPrompt(
      text,
      fields.map((f) => ({
        id: f.id,
        type: f.type,
        label: f.label,
        description: f.description,
        criteria: f.criteria,
      }))
    );

    try {
      const response = await this.runtime.useModel(ModelType.TEXT_SMALL, {
        prompt,
      });

      const parsedXml = parseKeyValueXml<Record<string, string>>(response);

      if (!parsedXml) {
        logger.warn("Failed to parse XML response for form extraction");
        return { values: {} };
      }

      const values: Record<string, string | number | boolean> = {};

      for (const field of fields) {
        const rawValue = parsedXml[field.id];
        if (rawValue === undefined || rawValue === null || rawValue === "") {
          continue;
        }

        switch (field.type) {
          case "number": {
            const numVal = Number(rawValue);
            if (!Number.isNaN(numVal)) {
              values[field.id] = numVal;
            }
            break;
          }
          case "checkbox": {
            const boolStr = String(rawValue).toLowerCase();
            values[field.id] = boolStr === "true" || boolStr === "1" || boolStr === "yes";
            break;
          }
          case "email": {
            const emailVal = String(rawValue).trim();
            if (emailVal.includes("@") && emailVal.includes(".")) {
              values[field.id] = emailVal;
            }
            break;
          }
          case "url": {
            const urlVal = String(rawValue).trim();
            if (urlVal.startsWith("http://") || urlVal.startsWith("https://")) {
              values[field.id] = urlVal;
            }
            break;
          }
          default:
            values[field.id] = String(rawValue).trim();
        }
      }

      logger.debug(`Extracted form values from XML: ${JSON.stringify(values)}`);
      return { values };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.warn(`Error extracting form values: ${errorMessage}`);
      return { values: {} };
    }
  }

  async listForms(status?: FormStatus): Promise<Form[]> {
    const forms: Form[] = [];

    for (const form of this.forms.values()) {
      if (form.agentId === this.runtime.agentId) {
        if (!status || form.status === status) {
          forms.push(form);
        }
      }
    }

    return forms;
  }

  async getForm(formId: UUID): Promise<Form | null> {
    const form = this.forms.get(formId);
    return form && form.agentId === this.runtime.agentId ? form : null;
  }

  async cancelForm(formId: UUID): Promise<boolean> {
    const form = this.forms.get(formId);
    if (!form || form.agentId !== this.runtime.agentId) {
      return false;
    }

    form.status = "cancelled";
    form.updatedAt = Date.now();
    logger.debug(`Cancelled form ${formId}`);

    return true;
  }

  registerTemplate(template: FormTemplate): void {
    this.templates.set(template.name, template);
    logger.debug(`Registered form template: ${template.name}`);
  }

  getTemplates(): FormTemplate[] {
    return Array.from(this.templates.values());
  }

  async cleanup(olderThanMs: number = 24 * 60 * 60 * 1000): Promise<number> {
    const now = Date.now();
    let removed = 0;

    for (const [id, form] of this.forms.entries()) {
      const age = now - form.updatedAt;

      if (form.status === "completed" && age > 60 * 60 * 1000) {
        this.forms.delete(id);
        removed++;
        logger.info(`Cleaned up completed form ${id}`);
      } else if (form.status !== "active" && age > olderThanMs) {
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
    await this.persistFormsBatch();

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

    const databaseGetter = getDatabaseFromRuntime(this.runtime);
    if (!databaseGetter) {
      logger.debug("Database adapter not available");
      return;
    }

    const database = typeof databaseGetter === "function" ? await databaseGetter() : databaseGetter;
    if (!database) {
      logger.debug("Database not available");
      return;
    }

    try {
      const result = await database.get(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_name = 'forms'
        ) as exists
      `);

      this.tablesExist = result?.exists || false;

      if (!this.tablesExist) {
        const schemaResult = await database.get(`
          SELECT EXISTS (
            SELECT FROM information_schema.tables 
            WHERE table_schema LIKE '%forms%' AND table_name = 'forms'
          ) as exists
        `);
        this.tablesExist = schemaResult?.exists || false;
      }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.debug("Could not check for forms tables:", errorMessage);
      this.tablesExist = false;
    }

    this.tablesChecked = true;
    logger.info(`Forms database tables ${this.tablesExist ? "found" : "not found"}`);
  }

  private async persistFormsBatch(): Promise<void> {
    if (!this.tablesExist) {
      return;
    }

    const databaseGetter = getDatabaseFromRuntime(this.runtime);
    if (!databaseGetter) {
      return;
    }

    const database = typeof databaseGetter === "function" ? await databaseGetter() : databaseGetter;
    if (!database) {
      return;
    }

    const formsToPersist: Array<{ form: Form; formId: UUID }> = [];
    for (const [formId, form] of this.forms.entries()) {
      if (form.agentId === this.runtime.agentId) {
        formsToPersist.push({ form, formId });
      }
    }

    if (formsToPersist.length === 0) {
      return;
    }

    try {
      await database.run("BEGIN");

      for (const { form } of formsToPersist) {
        const formData = {
          id: form.id,
          agentId: form.agentId,
          name: form.name,
          description: form.description || null,
          status: form.status,
          currentStepIndex: form.currentStepIndex,
          steps: JSON.stringify(
            form.steps.map((step) => ({
              id: step.id,
              name: step.name,
              completed: step.completed,
            }))
          ),
          createdAt: new Date(form.createdAt),
          updatedAt: new Date(form.updatedAt),
          completedAt: form.completedAt ? new Date(form.completedAt) : null,
          metadata: JSON.stringify(form.metadata || {}),
        };

        await database.run(
          `
          INSERT INTO forms (id, agent_id, name, description, status, current_step_index, steps, created_at, updated_at, completed_at, metadata)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            status = EXCLUDED.status,
            current_step_index = EXCLUDED.current_step_index,
            steps = EXCLUDED.steps,
            updated_at = EXCLUDED.updated_at,
            completed_at = EXCLUDED.completed_at,
            metadata = EXCLUDED.metadata
        `,
          [
            formData.id,
            formData.agentId,
            formData.name,
            formData.description,
            formData.status,
            formData.currentStepIndex,
            formData.steps,
            formData.createdAt,
            formData.updatedAt,
            formData.completedAt,
            formData.metadata,
          ]
        );

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

            await database.run(
              `
              INSERT INTO form_fields (form_id, step_id, field_id, label, type, value, is_secret, is_optional, description, criteria, error, metadata, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
              ON CONFLICT(form_id, step_id, field_id) DO UPDATE SET
                value = EXCLUDED.value,
                error = EXCLUDED.error,
                updated_at = datetime('now')
            `,
              [
                fieldData.formId,
                fieldData.stepId,
                fieldData.fieldId,
                fieldData.label,
                fieldData.type,
                fieldData.value,
                fieldData.isSecret,
                fieldData.isOptional,
                fieldData.description,
                fieldData.criteria,
                fieldData.error,
                fieldData.metadata,
              ]
            );
          }
        }
      }

      await database.run("COMMIT");
      logger.debug(`Successfully persisted ${formsToPersist.length} forms in batch`);
    } catch (error: unknown) {
      await database.run("ROLLBACK");

      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes("does not exist") || errorMessage.includes("no such table")) {
        logger.warn("Forms tables do not exist. Marking tables as not found.");
        this.tablesExist = false;
        return;
      }

      logger.warn(
        "Batch persistence failed, falling back to individual transactions:",
        errorMessage
      );
      await this.persistForms();
    }
  }

  private async persistForms(): Promise<void> {
    try {
      if (!this.tablesExist) {
        if (!this.tablesChecked || Math.random() < 0.1) {
          await this.checkDatabaseTables();
        }
        if (!this.tablesExist) {
          return;
        }
      }

      const databaseGetter = getDatabaseFromRuntime(this.runtime);
      if (!databaseGetter) {
        logger.warn("Database adapter not available for form persistence");
        return;
      }

      const database =
        typeof databaseGetter === "function" ? await databaseGetter() : databaseGetter;
      if (!database) {
        logger.warn("Database not available for form persistence");
        return;
      }

      for (const [formId, form] of this.forms.entries()) {
        if (form.agentId !== this.runtime.agentId) continue;

        try {
          await database.run("BEGIN");

          const formData = {
            id: form.id,
            agentId: form.agentId,
            name: form.name,
            description: form.description || null,
            status: form.status,
            currentStepIndex: form.currentStepIndex,
            steps: JSON.stringify(
              form.steps.map((step) => ({
                id: step.id,
                name: step.name,
                completed: step.completed,
                // Don't serialize callbacks
              }))
            ),
            createdAt: new Date(form.createdAt),
            updatedAt: new Date(form.updatedAt),
            completedAt: form.completedAt ? new Date(form.completedAt) : null,
            metadata: JSON.stringify(form.metadata || {}),
          };

          try {
            await database.run(
              `
              INSERT INTO forms (id, agent_id, name, description, status, current_step_index, steps, created_at, updated_at, completed_at, metadata)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET
                status = EXCLUDED.status,
                current_step_index = EXCLUDED.current_step_index,
                steps = EXCLUDED.steps,
                updated_at = EXCLUDED.updated_at,
                completed_at = EXCLUDED.completed_at,
                metadata = EXCLUDED.metadata
            `,
              [
                formData.id,
                formData.agentId,
                formData.name,
                formData.description,
                formData.status,
                formData.currentStepIndex,
                formData.steps,
                formData.createdAt,
                formData.updatedAt,
                formData.completedAt,
                formData.metadata,
              ]
            );
          } catch (dbError: unknown) {
            const dbErrorMsg = dbError instanceof Error ? dbError.message : String(dbError);
            if (dbErrorMsg.includes("does not exist") || dbErrorMsg.includes("no such table")) {
              logger.warn("Forms table does not exist. Marking tables as not found.");
              this.tablesExist = false;
              return;
            }
            throw dbError;
          }

          for (const step of form.steps) {
            for (const field of step.fields) {
              const fieldData = {
                formId: form.id,
                stepId: step.id,
                fieldId: field.id,
                label: field.label,
                type: field.type,
                value:
                  field.value !== undefined && field.value !== null ? String(field.value) : null,
                isSecret: field.secret || false,
                isOptional: field.optional || false,
                description: field.description || null,
                criteria: field.criteria || null,
                error: field.error || null,
                metadata: JSON.stringify(field.metadata || {}),
              };

              try {
                await database.run(
                  `
                  INSERT INTO form_fields (form_id, step_id, field_id, label, type, value, is_secret, is_optional, description, criteria, error, metadata, created_at, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
                  ON CONFLICT(form_id, step_id, field_id) DO UPDATE SET
                    value = EXCLUDED.value,
                    error = EXCLUDED.error,
                    updated_at = datetime('now')
                `,
                  [
                    fieldData.formId,
                    fieldData.stepId,
                    fieldData.fieldId,
                    fieldData.label,
                    fieldData.type,
                    fieldData.value,
                    fieldData.isSecret,
                    fieldData.isOptional,
                    fieldData.description,
                    fieldData.criteria,
                    fieldData.error,
                    fieldData.metadata,
                  ]
                );
              } catch (dbError: unknown) {
                const dbErrorMsg = dbError instanceof Error ? dbError.message : String(dbError);
                if (dbErrorMsg.includes("does not exist") || dbErrorMsg.includes("no such table")) {
                  logger.warn("Form fields table does not exist. Marking tables as not found.");
                  this.tablesExist = false;
                  return;
                }
                throw dbError;
              }
            }
          }

          await database.run("COMMIT");
        } catch (error: unknown) {
          await database.run("ROLLBACK");
          const errorMsg = error instanceof Error ? error.message : String(error);
          logger.error(`Error persisting form ${formId}:`, errorMsg);
        }
      }

      logger.debug(`Persisted forms to database`);
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(`Error persisting forms:`, errorMsg);
    }
  }

  private async restorePersistedForms(): Promise<void> {
    // Skip if tables don't exist
    if (!this.tablesExist) {
      return;
    }

    const databaseGetter = getDatabaseFromRuntime(this.runtime);
    if (!databaseGetter) {
      logger.warn("Database adapter not available for form restoration");
      return;
    }

    const database = typeof databaseGetter === "function" ? await databaseGetter() : databaseGetter;
    if (!database) {
      logger.warn("Database not available for form restoration");
      return;
    }

    let formsResult: Array<Record<string, unknown>>;
    try {
      formsResult = await database.all(
        `
        SELECT * FROM forms 
        WHERE agent_id = ? AND status != 'completed'
        ORDER BY updated_at DESC
      `,
        [this.runtime.agentId]
      );
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes("does not exist") || errorMessage.includes("no such table")) {
        logger.debug("Forms table does not exist during restoration");
        this.tablesExist = false;
        return;
      }
      throw error;
    }

    if (!formsResult || formsResult.length === 0) {
      logger.debug("No forms to restore from database");
      return;
    }

    for (const formRow of formsResult) {
      const validatedForm = this.validateAndSanitizeFormData(formRow);
      if (!validatedForm) {
        logger.warn(`Skipping invalid form ${formRow.id}`);
        continue;
      }

      const steps = validatedForm.steps;

      let fieldsResult: Array<Record<string, unknown>>;
      try {
        fieldsResult = await database.all(
          `
          SELECT * FROM form_fields 
          WHERE form_id = ?
          ORDER BY step_id, field_id
        `,
          [formRow.id]
        );
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (errorMessage.includes("does not exist") || errorMessage.includes("no such table")) {
          logger.debug("Form fields table does not exist during restoration");
          this.tablesExist = false;
          return;
        }
        throw error;
      }

      const fieldsByStep = new Map<string, typeof fieldsResult>();
      for (const fieldRow of fieldsResult) {
        const stepId = String(fieldRow.step_id);
        if (!fieldsByStep.has(stepId)) {
          fieldsByStep.set(stepId, []);
        }
        fieldsByStep.get(stepId)?.push(fieldRow);
      }

      const form: Form = {
        ...validatedForm,
        steps: steps.map((step: DatabaseFormStep) => ({
          id: step.id,
          name: step.name,
          completed: step.completed || false,
          fields: (fieldsByStep.get(step.id) || [])
            .map((fieldRow: Record<string, unknown>): FormField | null => {
              const validatedField = this.validateAndSanitizeFieldData(fieldRow);
              if (!validatedField) {
                logger.warn(`Skipping invalid field ${fieldRow.field_id} in form ${formRow.id}`);
                return null;
              }

              let fieldValue: string | number | boolean | undefined =
                fieldRow.value !== null
                  ? this.parseFieldValue(
                      String(fieldRow.value),
                      String(fieldRow.type),
                      Boolean(fieldRow.is_secret)
                    )
                  : undefined;

              if (fieldValue !== undefined) {
                const valueSchema = createFieldValueSchema(validatedField.type);
                const valueResult = valueSchema.safeParse(fieldValue);

                if (!valueResult.success) {
                  logger.warn(
                    `Invalid field value after decryption for ${fieldRow.field_id}:`,
                    JSON.stringify(valueResult.error.format())
                  );
                  fieldValue = undefined;
                } else {
                  fieldValue = valueResult.data as string | number | boolean;
                }
              }

              return {
                ...validatedField,
                value: fieldValue,
              };
            })
            .filter((field: FormField | null): field is FormField => field !== null),
        })),
      };

      const hasValidSteps = form.steps.some((step) => step.fields.length > 0);
      if (hasValidSteps) {
        this.forms.set(form.id, form);
        logger.debug(`Restored form ${form.id} (${form.name}) from database`);
      } else {
        logger.warn(`Form ${form.id} has no valid steps/fields, skipping`);
      }
    }

    logger.info(`Restored ${this.forms.size} forms from database`);
  }

  private validateAndSanitizeFormData(
    formRow: Record<string, unknown>
  ): (Omit<Form, "steps"> & { steps: DatabaseFormStep[] }) | null {
    const result = DatabaseFormRowSchema.safeParse(formRow);

    if (!result.success) {
      logger.warn(`Invalid form data for ${formRow.id}:`, JSON.stringify(result.error.format()));
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

  private validateAndSanitizeFieldData(
    fieldRow: Record<string, unknown>
  ): Omit<FormField, "value"> | null {
    const result = DatabaseFieldRowSchema.safeParse(fieldRow);

    if (!result.success) {
      logger.warn(`Invalid field data:`, JSON.stringify(result.error.format()));
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

  private parseFieldValue(
    value: string,
    type: string,
    isSecret: boolean = false
  ): string | number | boolean {
    let processedValue = value;
    if (isSecret && type !== "number" && type !== "checkbox") {
      const salt = getSalt();
      processedValue = decryptStringValue(value, salt);
    }

    switch (type) {
      case "number":
        return Number(processedValue);
      case "checkbox":
        return processedValue === "true";
      default:
        return processedValue;
    }
  }

  private validateFieldValue(
    value: unknown,
    field: FormField
  ): { isValid: boolean; value?: string | number | boolean; error?: string } {
    switch (field.type) {
      case "number": {
        const num = Number(value);
        if (Number.isNaN(num)) {
          return { isValid: false, error: "Must be a valid number" };
        }
        return { isValid: true, value: num };
      }

      case "email":
        if (typeof value !== "string" || !value.includes("@") || !value.includes(".")) {
          return { isValid: false, error: "Must be a valid email address" };
        }
        return { isValid: true, value: value.trim() };

      case "url":
        if (
          typeof value !== "string" ||
          (!value.startsWith("http://") && !value.startsWith("https://"))
        ) {
          return {
            isValid: false,
            error: "Must be a valid URL starting with http:// or https://",
          };
        }
        return { isValid: true, value: value.trim() };

      case "tel":
        if (typeof value !== "string" || value.length < 7) {
          return { isValid: false, error: "Must be a valid phone number" };
        }
        return { isValid: true, value: value.trim() };

      case "date":
      case "time":
      case "datetime":
        if (typeof value !== "string" || !value) {
          return { isValid: false, error: `Must be a valid ${field.type}` };
        }
        return { isValid: true, value: value.trim() };

      case "checkbox":
        return { isValid: true, value: Boolean(value) };

      default:
        if (value === null || value === undefined) {
          return { isValid: false, error: "Value is required" };
        }
        return { isValid: true, value: String(value) };
    }
  }

  private async cleanupOldForms(): Promise<void> {
    await this.cleanup(24 * 60 * 60 * 1000);
  }
}
