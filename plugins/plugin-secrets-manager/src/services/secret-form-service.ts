import { Service, type IAgentRuntime, logger, type UUID } from "@elizaos/core";
import express, { Express, Request, Response } from "express";
import cors from "cors";
import helmet from "helmet";
import { nanoid } from "nanoid";
import { createServer, Server } from "http";

import { NgrokService } from "./ngrok-service";
import { EnhancedSecretManager } from "../enhanced-service";
import {
  type FormSchema,
  type FormSession,
  type FormSubmission,
  type SecretFormRequest,
  type FormField,
  type FormFieldType,
  FormFieldPresets,
} from "../types/form";
import type { SecretContext, SecretConfig } from "../types";

// HTML escaping function to prevent XSS
function escapeHtml(unsafe: string): string {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Service for creating and managing secret collection forms
 */
export class SecretFormService extends Service {
  static serviceType = "SECRET_FORMS";
  capabilityDescription =
    "Creates secure web forms for collecting secrets from users";

  private ngrokService: NgrokService;
  private secretsManager: EnhancedSecretManager;
  private sessions: Map<string, FormSession> = new Map();
  private servers: Map<number, { app: Express; server: Server }> = new Map();
  private nextPort = 10000; // Starting port for form servers

  constructor(runtime: IAgentRuntime) {
    super(runtime);
  }

  async start(): Promise<void> {
    logger.info("[SecretFormService] Starting secret form service");

    // Get required services
    this.ngrokService = this.runtime.getService("NGROK") as NgrokService;
    if (!this.ngrokService) {
      throw new Error("NgrokService is required for SecretFormService");
    }

    this.secretsManager = this.runtime.getService(
      "SECRETS",
    ) as EnhancedSecretManager;
    if (!this.secretsManager) {
      throw new Error(
        "EnhancedSecretManager is required for SecretFormService",
      );
    }

    // Start cleanup interval
    setInterval(() => {
      this.cleanupExpiredSessions();
    }, 60 * 1000); // Every minute

    logger.info("[SecretFormService] Secret form service started");
  }

  /**
   * Create a form for collecting secrets
   */
  async createSecretForm(
    request: SecretFormRequest,
    context: SecretContext,
    callback?: (submission: FormSubmission) => Promise<void>,
  ): Promise<{ url: string; sessionId: string }> {
    try {
      logger.info("[SecretFormService] Creating secret form", {
        secretCount: request.secrets.length,
        mode: request.mode || "requester",
      });

      // Generate form schema
      const schema = this.generateFormSchema(request);

      // Create Express app for this form
      const port = this.getAvailablePort();
      const { app, server } = this.createFormServer(port);

      // Create ngrok tunnel
      const tunnel = await this.ngrokService.createTunnel(
        port,
        `secret-form-${schema.id}`,
        request.expiresIn,
      );

      // Create session
      const session: FormSession = {
        id: nanoid(),
        formId: schema.id,
        tunnelId: tunnel.id,
        port,
        url: tunnel.url,
        schema,
        request,
        createdAt: Date.now(),
        expiresAt: schema.expiresAt!,
        submissions: [],
        status: "active",
        callback,
      };

      this.sessions.set(session.id, session);

      // Setup routes for this form
      this.setupFormRoutes(app, session, context);

      // Start the server
      await new Promise<void>((resolve) => {
        server.listen(port, () => {
          logger.info(
            `[SecretFormService] Form server started on port ${port}`,
          );
          resolve();
        });
      });

      this.servers.set(port, { app, server });

      const formUrl = `${tunnel.url}/form/${session.id}`;
      logger.info(`[SecretFormService] Form created: ${formUrl}`);

      return {
        url: formUrl,
        sessionId: session.id,
      };
    } catch (error) {
      logger.error("[SecretFormService] Failed to create form:", error);
      throw error;
    }
  }

  /**
   * Generate form schema from request
   */
  private generateFormSchema(request: SecretFormRequest): FormSchema {
    const fields: FormField[] = [];

    // Convert each secret request into form fields
    for (const secret of request.secrets) {
      const field = this.createFormField(
        secret.key,
        secret.config,
        secret.field,
      );
      fields.push(field);
    }

    const schema: FormSchema = {
      id: nanoid(),
      title: request.title || "Secure Information Request",
      description:
        request.description ||
        "Please provide the following information securely.",
      fields,
      submitLabel: "Submit Securely",
      mode: request.mode || "requester",
      theme: "auto",
      expiresAt: Date.now() + (request.expiresIn || 30 * 60 * 1000),
      maxSubmissions: request.maxSubmissions || 1,
      successMessage: "Thank you! Your information has been securely received.",
      styling: {
        width: request.mode === "inline" ? "md" : "lg",
      },
    };

    return schema;
  }

  /**
   * Create a form field from secret configuration
   */
  private createFormField(
    key: string,
    config: Partial<SecretConfig>,
    fieldOverrides?: Partial<FormField>,
  ): FormField {
    // Check if we have a preset for this type
    const preset = FormFieldPresets[config.type || "text"] || {};

    // Determine field type based on secret type
    let fieldType: FormFieldType = "password"; // Default for secrets
    if (config.type === "url") fieldType = "url";
    if (config.type === "config") fieldType = "textarea"; // Use textarea for JSON config
    if (config.type === "credential") fieldType = "password";

    const field: FormField = {
      name: key,
      label:
        config.description ||
        key.replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase()),
      type: fieldType,
      required: config.required ?? true,
      sensitive: true,
      ...preset,
      ...fieldOverrides,
    };

    return field;
  }

  /**
   * Create Express server for form
   */
  private createFormServer(port: number): { app: Express; server: Server } {
    const app = express();

    // Middleware
    app.use(
      helmet({
        contentSecurityPolicy: {
          directives: {
            defaultSrc: ["'self'"],
            styleSrc: [
              "'self'",
              "'unsafe-inline'",
              "https://unpkg.com",
              "https://cdn.jsdelivr.net",
            ],
            scriptSrc: [
              "'self'",
              "'unsafe-inline'",
              "https://unpkg.com",
              "https://cdn.jsdelivr.net",
            ],
            imgSrc: ["'self'", "data:", "https:"],
            connectSrc: ["'self'"],
            fontSrc: ["'self'", "https:", "data:"],
          },
        },
      }),
    );
    app.use(cors());
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));

    // Health check
    app.get("/health", (req, res) => {
      res.json({ status: "ok", port });
    });

    const server = createServer(app);
    return { app, server };
  }

  /**
   * Setup routes for a specific form
   */
  private setupFormRoutes(
    app: Express,
    session: FormSession,
    context: SecretContext,
  ): void {
    // Serve the form HTML
    app.get(`/form/${session.id}`, (req, res) => {
      if (session.status !== "active") {
        res.status(410).send("This form has expired or been completed.");
        return;
      }

      res.send(this.generateFormHTML(session));
    });

    // Handle form submission
    app.post(`/api/form/${session.id}/submit`, async (req, res) => {
      try {
        if (session.status !== "active") {
          res.status(410).json({ error: "Form expired or completed" });
          return;
        }

        // Validate submission
        const validation = this.validateSubmission(session.schema, req.body);
        if (!validation.valid) {
          res.status(400).json({ errors: validation.errors });
          return;
        }

        // Create submission record
        const submission: FormSubmission = {
          formId: session.formId,
          sessionId: session.id,
          data: req.body,
          submittedAt: Date.now(),
          ipAddress: req.ip,
          userAgent: req.get("user-agent"),
        };

        session.submissions.push(submission);

        // Store secrets
        await this.storeSubmittedSecrets(session, submission, context);

        // Check if we've reached max submissions
        if (
          session.submissions.length >= (session.schema.maxSubmissions || 1)
        ) {
          session.status = "completed";
          this.closeSession(session.id);
        }

        // Call callback if provided
        if (session.callback) {
          await session.callback(submission);
        }

        res.json({
          success: true,
          message: session.schema.successMessage,
        });
      } catch (error) {
        logger.error("[SecretFormService] Error handling submission:", error);
        res.status(500).json({ error: "Failed to process submission" });
      }
    });

    // Get form status
    app.get(`/api/form/${session.id}/status`, (req, res) => {
      res.json({
        status: session.status,
        submissionsCount: session.submissions.length,
        maxSubmissions: session.schema.maxSubmissions,
        expiresAt: session.expiresAt,
      });
    });
  }

  /**
   * Generate HTML for the form
   */
  private generateFormHTML(session: FormSession): string {
    const { schema } = session;

    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(schema.title)}</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://cdn.jsdelivr.net/npm/@tailwindcss/forms@0.5.3/dist/forms.min.css" rel="stylesheet">
    <style>
        .form-container {
            animation: fadeIn 0.3s ease-in;
        }
        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(10px); }
            to { opacity: 1; transform: translateY(0); }
        }
        .success-message {
            animation: slideIn 0.3s ease-out;
        }
        @keyframes slideIn {
            from { opacity: 0; transform: translateX(-20px); }
            to { opacity: 1; transform: translateX(0); }
        }
    </style>
</head>
<body class="min-h-screen bg-gray-50 dark:bg-gray-900 py-12 px-4 sm:px-6 lg:px-8">
    <div class="max-w-${escapeHtml(schema.styling?.width || "md")} mx-auto">
        <div class="form-container bg-white dark:bg-gray-800 rounded-lg shadow-xl p-8">
            <h1 class="text-2xl font-bold text-gray-900 dark:text-white mb-2">${escapeHtml(schema.title)}</h1>
            ${schema.description ? `<p class="text-gray-600 dark:text-gray-400 mb-8">${escapeHtml(schema.description)}</p>` : ""}
            
            <form id="secretForm" class="space-y-6">
                ${schema.fields.map((field) => this.renderFormField(field)).join("")}
                
                <div class="pt-4">
                    <button type="submit" 
                        class="w-full flex justify-center py-3 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed">
                        ${escapeHtml(schema.submitLabel || "Submit")}
                    </button>
                </div>
            </form>
            
            <div id="successMessage" class="hidden mt-6 p-4 bg-green-50 dark:bg-green-900/20 rounded-md">
                <p class="text-green-800 dark:text-green-200 success-message">
                    ${escapeHtml(schema.successMessage || "Success!")}
                </p>
            </div>
            
            <div id="errorMessage" class="hidden mt-6 p-4 bg-red-50 dark:bg-red-900/20 rounded-md">
                <p class="text-red-800 dark:text-red-200"></p>
            </div>
        </div>
        
        <div class="mt-4 text-center text-sm text-gray-500 dark:text-gray-400">
            This form will expire in <span id="countdown"></span>
        </div>
    </div>
    
    <script>
        // Form submission
        document.getElementById('secretForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const form = e.target;
            const submitButton = form.querySelector('button[type="submit"]');
            const formData = new FormData(form);
            const data = Object.fromEntries(formData);
            
            // Disable form
            submitButton.disabled = true;
            submitButton.textContent = 'Submitting...';
            
            try {
                const response = await fetch('/api/form/${session.id}/submit', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify(data)
                });
                
                const result = await response.json();
                
                if (response.ok) {
                    // Show success message
                    document.getElementById('successMessage').classList.remove('hidden');
                    form.style.display = 'none';
                    
                    // Clear form data from memory
                    form.reset();
                    
                    // Redirect after 3 seconds
                    setTimeout(() => {
                        window.location.href = 'about:blank';
                    }, 3000);
                } else {
                    // Show error
                    const errorEl = document.getElementById('errorMessage');
                    errorEl.querySelector('p').textContent = result.error || 'Submission failed';
                    errorEl.classList.remove('hidden');
                    
                    submitButton.disabled = false;
                    submitButton.textContent = '${escapeHtml(schema.submitLabel || "Submit")}';
                }
            } catch (error) {
                console.error('Submission error:', error);
                const errorEl = document.getElementById('errorMessage');
                errorEl.querySelector('p').textContent = 'Network error. Please try again.';
                errorEl.classList.remove('hidden');
                
                submitButton.disabled = false;
                submitButton.textContent = '${escapeHtml(schema.submitLabel || "Submit")}';
            }
        });
        
        // Countdown timer
        const expiresAt = ${schema.expiresAt};
        function updateCountdown() {
            const now = Date.now();
            const remaining = expiresAt - now;
            
            if (remaining <= 0) {
                document.getElementById('countdown').textContent = 'expired';
                document.getElementById('secretForm').style.display = 'none';
                return;
            }
            
            const minutes = Math.floor(remaining / 60000);
            const seconds = Math.floor((remaining % 60000) / 1000);
            document.getElementById('countdown').textContent = 
                minutes + ':' + seconds.toString().padStart(2, '0');
        }
        
        updateCountdown();
        setInterval(updateCountdown, 1000);
    </script>
</body>
</html>`;
  }

  /**
   * Render a form field as HTML
   */
  private renderFormField(field: FormField): string {
    const baseClasses =
      "mt-1 block w-full rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm";

    let input = "";

    switch (field.type) {
      case "textarea":
      case "code":
      case "json":
        input = `
                    <textarea
                        id="${escapeHtml(field.name)}"
                        name="${escapeHtml(field.name)}"
                        rows="${field.rows || 4}"
                        class="${baseClasses} font-mono"
                        placeholder="${escapeHtml(field.placeholder || "")}"
                        ${field.required ? "required" : ""}
                    >${escapeHtml(field.defaultValue || "")}</textarea>
                `;
        break;

      case "select":
        input = `
                    <select
                        id="${escapeHtml(field.name)}"
                        name="${escapeHtml(field.name)}"
                        class="${baseClasses}"
                        ${field.required ? "required" : ""}
                    >
                        <option value="">Choose...</option>
                        ${(field.options || [])
                          .map(
                            (opt) =>
                              `<option value="${escapeHtml(opt.value)}">${escapeHtml(opt.label)}</option>`,
                          )
                          .join("")}
                    </select>
                `;
        break;

      case "creditcard":
        input = `
                    <input
                        type="text"
                        id="${escapeHtml(field.name)}"
                        name="${escapeHtml(field.name)}"
                        class="${baseClasses}"
                        placeholder="${escapeHtml(field.placeholder || "1234 5678 9012 3456")}"
                        pattern="[0-9\\s]{13,19}"
                        maxlength="19"
                        autocomplete="${escapeHtml(field.autoComplete || "cc-number")}"
                        ${field.required ? "required" : ""}
                        oninput="this.value = this.value.replace(/[^0-9]/g, '').replace(/(.{4})/g, '$1 ').trim()"
                    />
                `;
        break;

      default:
        input = `
                    <input
                        type="${escapeHtml(field.type)}"
                        id="${escapeHtml(field.name)}"
                        name="${escapeHtml(field.name)}"
                        class="${baseClasses}"
                        placeholder="${escapeHtml(field.placeholder || "")}"
                        value="${escapeHtml(field.defaultValue || "")}"
                        ${field.autoComplete ? `autocomplete="${escapeHtml(field.autoComplete)}"` : ""}
                        ${field.required ? "required" : ""}
                    />
                `;
    }

    return `
            <div>
                <label for="${escapeHtml(field.name)}" class="block text-sm font-medium text-gray-700 dark:text-gray-300">
                    ${escapeHtml(field.label)}
                    ${field.required ? '<span class="text-red-500">*</span>' : ""}
                </label>
                ${field.description ? `<p class="mt-1 text-sm text-gray-500 dark:text-gray-400">${escapeHtml(field.description)}</p>` : ""}
                ${input}
            </div>
        `;
  }

  /**
   * Validate form submission
   */
  private validateSubmission(
    schema: FormSchema,
    data: Record<string, any>,
  ): { valid: boolean; errors?: Record<string, string> } {
    const errors: Record<string, string> = {};

    for (const field of schema.fields) {
      const value = data[field.name];

      // Check required
      if (field.required && !value) {
        errors[field.name] = `${field.label} is required`;
        continue;
      }

      // Run validations
      if (field.validation && value) {
        for (const rule of field.validation) {
          let isValid = true;

          switch (rule.type) {
            case "required":
              isValid = !!value;
              break;
            case "minLength":
              isValid = value.length >= rule.value;
              break;
            case "maxLength":
              isValid = value.length <= rule.value;
              break;
            case "pattern":
              isValid = rule.value.test(value);
              break;
            case "custom":
              isValid = rule.validator ? rule.validator(value) : true;
              break;
          }

          if (!isValid) {
            errors[field.name] = rule.message;
            break;
          }
        }
      }
    }

    return {
      valid: Object.keys(errors).length === 0,
      errors: Object.keys(errors).length > 0 ? errors : undefined,
    };
  }

  /**
   * Store submitted secrets using the secrets manager
   */
  private async storeSubmittedSecrets(
    session: FormSession,
    submission: FormSubmission,
    context: SecretContext,
  ): Promise<void> {
    for (const secret of session.request.secrets) {
      const value = submission.data[secret.key];
      if (!value) continue;

      try {
        await this.secretsManager.set(
          secret.key,
          value,
          context,
          secret.config,
        );

        logger.info(`[SecretFormService] Stored secret: ${secret.key}`);
      } catch (error) {
        logger.error(
          `[SecretFormService] Failed to store secret ${secret.key}:`,
          error,
        );
        throw error;
      }
    }
  }

  /**
   * Get available port for new server
   */
  private getAvailablePort(): number {
    let port = this.nextPort;
    while (this.servers.has(port)) {
      port++;
    }
    this.nextPort = port + 1;
    return port;
  }

  /**
   * Close a form session
   */
  async closeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    logger.info(`[SecretFormService] Closing session ${sessionId}`);

    // Close ngrok tunnel
    await this.ngrokService.closeTunnel(session.tunnelId);

    // Stop Express server
    const server = this.servers.get(session.port);
    if (server) {
      await new Promise<void>((resolve) => {
        server.server.close(() => resolve());
      });
      this.servers.delete(session.port);
    }

    // Remove session
    this.sessions.delete(sessionId);
  }

  /**
   * Clean up expired sessions
   */
  private async cleanupExpiredSessions(): Promise<void> {
    const now = Date.now();
    const expiredSessions: string[] = [];

    for (const [id, session] of this.sessions) {
      if (now >= session.expiresAt || session.status === "completed") {
        expiredSessions.push(id);
      }
    }

    for (const id of expiredSessions) {
      await this.closeSession(id);
    }

    if (expiredSessions.length > 0) {
      logger.info(
        `[SecretFormService] Cleaned up ${expiredSessions.length} expired sessions`,
      );
    }
  }

  /**
   * Get session status
   */
  getSession(sessionId: string): FormSession | null {
    return this.sessions.get(sessionId) || null;
  }

  /**
   * Stop the service
   */
  async stop(): Promise<void> {
    logger.info("[SecretFormService] Stopping secret form service");

    // Close all sessions
    const sessionIds = Array.from(this.sessions.keys());
    for (const id of sessionIds) {
      await this.closeSession(id);
    }

    logger.info("[SecretFormService] Secret form service stopped");
  }
}
