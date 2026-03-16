import {
  type Action,
  type IAgentRuntime,
  type Memory,
  type HandlerCallback,
  logger,
  elizaLogger,
  parseJSONObjectFromText,
} from "@elizaos/core";
import { SecretFormService } from "../services/secret-form-service";
import type { SecretFormRequest, FormSubmission } from "../types/form";
import type { SecretContext, SecretConfig, EnvVarType } from "../types";

interface RequestSecretFormParams {
  secrets: Array<{
    key: string;
    description?: string;
    type?: string;
    required?: boolean;
  }>;
  title?: string;
  description?: string;
  mode?: "requester" | "inline";
  expiresIn?: number;
}

export const requestSecretFormAction: Action = {
  name: "REQUEST_SECRET_FORM",
  description: "Create a secure web form for collecting secrets from users",

  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    const hasService = !!runtime.getService("SECRET_FORMS");
    if (!hasService) {
      logger.warn("[RequestSecretForm] Secret form service not available");
      return false;
    }

    const text = message.content.text.toLowerCase();
    const keywords = [
      "request secret",
      "need information",
      "collect secret",
      "create form",
      "ask for api key",
      "request credentials",
    ];

    return keywords.some((keyword) => text.includes(keyword));
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: any,
    options: any,
    callback?: HandlerCallback,
  ): Promise<boolean> => {
    elizaLogger.info("[RequestSecretForm] Starting secret form request");

    const formService = runtime.getService("SECRET_FORMS") as SecretFormService;
    if (!formService) {
      if (callback) {
        callback({
          text: "Secret form service is not available.",
          error: true,
        });
      }
      return false;
    }

    try {
      // Parse parameters from message or state
      const params =
        (parseJSONObjectFromText(
          message.content.text,
        ) as RequestSecretFormParams) ||
        extractRequestParams(message.content.text);

      if (!params.secrets || params.secrets.length === 0) {
        if (callback) {
          callback({
            text: "Please specify what secrets you need to collect.",
            error: true,
          });
        }
        return false;
      }

      // Build secret form request
      const request: SecretFormRequest = {
        secrets: params.secrets.map((s) => ({
          key: s.key.toUpperCase().replace(/\s+/g, "_"),
          config: {
            type: (s.type as EnvVarType) || "secret",
            description: s.description || s.key,
            required: s.required ?? true,
          } as Partial<SecretConfig>,
        })),
        title: params.title || "Secure Information Request",
        description:
          params.description ||
          "Please provide the following information. This form uses a secure connection and your data will be encrypted.",
        mode: params.mode || "requester",
        expiresIn: params.expiresIn || 30 * 60 * 1000, // 30 minutes default
        maxSubmissions: 1,
      };

      // Build context based on message
      const context: SecretContext = {
        level: "user",
        userId: message.entityId,
        agentId: runtime.agentId,
        requesterId: runtime.agentId,
      };

      // Create callback to handle submission
      const submissionCallback = async (submission: FormSubmission) => {
        elizaLogger.info("[RequestSecretForm] Form submitted", {
          sessionId: submission.sessionId,
          keys: Object.keys(submission.data),
        });

        // The secrets are already stored by the form service
        // This callback can be used for additional notifications
      };

      // Create the form
      const { url, sessionId } = await formService.createSecretForm(
        request,
        context,
        submissionCallback,
      );

      elizaLogger.info("[RequestSecretForm] Form created", { url, sessionId });

      // Generate response message
      const responseText = generateResponseMessage(
        url,
        params.secrets.length,
        request.expiresIn!,
      );

      if (callback) {
        callback({
          text: responseText,
          data: {
            formUrl: url,
            sessionId,
            expiresAt: Date.now() + request.expiresIn!,
          },
        });
      }

      return true;
    } catch (error) {
      elizaLogger.error("[RequestSecretForm] Error:", error);

      if (callback) {
        callback({
          text: `Error creating secret form: ${error.message}`,
          error: true,
        });
      }

      return false;
    }
  },

  examples: [
    [
      {
        name: "user",
        content: {
          text: "I need you to collect my API keys",
        },
      },
      {
        name: "assistant",
        content: {
          text: "I'll create a secure form for you to provide your API keys.",
          action: "REQUEST_SECRET_FORM",
        },
      },
    ],
    [
      {
        name: "user",
        content: {
          text: "Request my OpenAI and Anthropic API keys",
        },
      },
      {
        name: "assistant",
        content: {
          text: "I'll create a secure form to collect your OpenAI and Anthropic API keys.",
          action: "REQUEST_SECRET_FORM",
        },
      },
    ],
    [
      {
        name: "user",
        content: {
          text: "Can you create a form for webhook configuration?",
        },
      },
      {
        name: "assistant",
        content: {
          text: "I'll create a secure form for webhook configuration.",
          action: "REQUEST_SECRET_FORM",
        },
      },
    ],
  ],
};

// Helper function to extract parameters from natural language
function extractRequestParams(text: string): RequestSecretFormParams {
  const params: RequestSecretFormParams = {
    secrets: [],
    mode: "requester",
  };

  // Extract common secret types - MOST SPECIFIC FIRST
  const secretPatterns = [
    {
      pattern: /openai\s*(?:api\s*)?key/gi,
      key: "OPENAI_API_KEY",
      type: "api_key",
      description: "OpenAI API Key",
    },
    {
      pattern: /anthropic\s*(?:api\s*)?key/gi,
      key: "ANTHROPIC_API_KEY",
      type: "api_key",
      description: "Anthropic API Key",
    },
    {
      pattern: /groq\s*(?:api\s*)?key/gi,
      key: "GROQ_API_KEY",
      type: "api_key",
      description: "Groq API Key",
    },
    {
      pattern: /webhook\s*(?:url)?/gi,
      key: "WEBHOOK_URL",
      type: "url",
      description: "Webhook URL",
    },
    {
      pattern: /credit\s*card/gi,
      key: "CREDIT_CARD",
      type: "creditcard",
      description: "Credit Card Number",
    },
    {
      pattern: /private\s*key/gi,
      key: "PRIVATE_KEY",
      type: "private_key",
      description: "Private Key",
    },
    {
      pattern: /api\s*key/gi,
      key: "API_KEY",
      type: "api_key",
      description: "API Key",
    },
    {
      pattern: /password/gi,
      key: "PASSWORD",
      type: "credential",
      description: "Password",
    },
    {
      pattern: /token/gi,
      key: "TOKEN",
      type: "api_key",
      description: "Access Token",
    },
    {
      pattern: /secret/gi,
      key: "SECRET",
      type: "secret",
      description: "Secret Value",
    },
  ];

  // Find all unique matching secrets in the text
  for (const secretPattern of secretPatterns) {
    if (secretPattern.pattern.test(text)) {
      const exists = params.secrets.some((s) => s.key === secretPattern.key);
      if (!exists) {
        params.secrets.push({
          key: secretPattern.key,
          type: secretPattern.type,
          description: secretPattern.description,
          required: true,
        });
      }
    }
  }

  // If no specific secrets found after checking all patterns, add a generic one
  if (
    params.secrets.length === 0 &&
    text.match(/secret|key|token|password|credential/i)
  ) {
    params.secrets.push({
      key: "SECRET_VALUE",
      type: "secret",
      description: "Secret Information",
      required: true,
    });
  }

  // Check for inline mode indicators
  if (
    text.includes("inline") ||
    text.includes("quick") ||
    text.includes("simple")
  ) {
    params.mode = "inline";
  }

  // Extract expiration time if mentioned
  const timeMatch = text.match(/(\d+)\s*(minute|hour)/i);
  if (timeMatch) {
    const amount = parseInt(timeMatch[1]);
    const unit = timeMatch[2].toLowerCase();
    params.expiresIn = unit.includes("hour")
      ? amount * 60 * 60 * 1000
      : amount * 60 * 1000;
  }

  return params;
}

// Generate a user-friendly response message
function generateResponseMessage(
  url: string,
  secretCount: number,
  expiresIn: number,
): string {
  const expirationMinutes = Math.floor(expiresIn / 60000);
  const secretText = secretCount === 1 ? "secret" : "secrets";

  return (
    `I've created a secure form to collect your ${secretText}. Please visit the following link to provide the information:\n\n` +
    `🔒 ${url}\n\n` +
    `This form will expire in ${expirationMinutes} minutes and can only be submitted once. ` +
    `Your information will be encrypted and stored securely.\n\n` +
    `After submission, the form will automatically close and your data will be cleared from the browser.`
  );
}
