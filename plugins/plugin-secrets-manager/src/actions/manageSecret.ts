import {
  type Action,
  type IAgentRuntime,
  type Memory,
  type HandlerCallback,
  type UUID,
  logger,
  elizaLogger,
  parseJSONObjectFromText,
} from "@elizaos/core";
import { EnhancedSecretManager } from "../enhanced-service";
import type { SecretContext, SecretConfig, EnvVarType } from "../types";

interface ManageSecretParams {
  operation: "get" | "set" | "delete" | "list";
  key?: string;
  value?: string;
  level: "global" | "world" | "user";
  worldId?: string;
  userId?: string;
  config?: {
    type?: string;
    description?: string;
    required?: boolean;
    encrypted?: boolean;
  };
}

export const manageSecretAction: Action = {
  name: "MANAGE_SECRET",
  description:
    "Manage secrets at different levels (global, world, user) with get, set, delete, and list operations",

  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    const hasService = !!runtime.getService("SECRETS");
    if (!hasService) {
      logger.warn("[ManageSecret] Secrets service not available");
      return false;
    }

    const text = message.content.text.toLowerCase();
    const keywords = [
      "secret",
      "setting",
      "configure",
      "set secret",
      "get secret",
      "delete secret",
      "list secrets",
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
    elizaLogger.info("[ManageSecret] Starting secret management action");

    const secretsService = runtime.getService(
      "SECRETS",
    ) as EnhancedSecretManager;
    if (!secretsService) {
      if (callback) {
        callback({
          text: "Secret management service is not available.",
          error: true,
        });
      }
      return false;
    }

    try {
      // Parse parameters from message
      const params =
        (parseJSONObjectFromText(message.content.text) as ManageSecretParams) ||
        extractParams(message.content.text);

      if (!params.operation) {
        if (callback) {
          callback({
            text: "Please specify an operation: get, set, delete, or list",
            error: true,
          });
        }
        return false;
      }

      // Build context
      const context: SecretContext = {
        level: params.level || "user",
        worldId: params.worldId || message.roomId,
        userId: params.userId || message.entityId,
        agentId: runtime.agentId,
        requesterId: message.entityId,
      };

      let result: string;

      switch (params.operation) {
        case "get":
          if (!params.key) {
            result = "Please provide a key to retrieve";
            break;
          }

          const value = await secretsService.get(params.key, context);
          if (value === null) {
            result = `Secret "${params.key}" not found or access denied`;
          } else {
            // Don't expose the actual value in the response for security
            result = `Secret "${params.key}" exists and is accessible`;
          }
          break;

        case "set":
          if (!params.key || !params.value) {
            result = "Please provide both key and value to set";
            break;
          }

          const config: Partial<SecretConfig> = {
            type: (params.config?.type as EnvVarType) || "secret",
            description: params.config?.description || `Secret: ${params.key}`,
            required: params.config?.required ?? false,
            encrypted: params.config?.encrypted ?? true,
          };

          const success = await secretsService.set(
            params.key,
            params.value,
            context,
            config,
          );
          if (success) {
            result = `Successfully set ${context.level}-level secret "${params.key}"`;
          } else {
            result = `Failed to set secret "${params.key}" - check permissions`;
          }
          break;

        case "delete":
          if (!params.key) {
            result = "Please provide a key to delete";
            break;
          }

          // For delete, we set the value to null
          const deleteSuccess = await secretsService.set(
            params.key,
            null,
            context,
          );
          if (deleteSuccess) {
            result = `Successfully deleted ${context.level}-level secret "${params.key}"`;
          } else {
            result = `Failed to delete secret "${params.key}" - check permissions`;
          }
          break;

        case "list":
          const secrets = await secretsService.list(context);
          const secretKeys = Object.keys(secrets);

          if (secretKeys.length === 0) {
            result = `No ${context.level}-level secrets found`;
          } else {
            result = `Found ${secretKeys.length} ${context.level}-level secrets:\n`;
            result += secretKeys
              .map((key) => {
                const config = secrets[key];
                return `- ${key}: ${config.description || "No description"} (${config.type || "secret"})`;
              })
              .join("\n");
          }
          break;

        default:
          result = `Unknown operation: ${params.operation}`;
      }

      if (callback) {
        callback({ text: result });
      }

      return true;
    } catch (error) {
      elizaLogger.error("[ManageSecret] Error:", error);

      if (callback) {
        callback({
          text: `Error managing secret: ${error.message}`,
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
          text: "Set my API key as abc123",
        },
      },
      {
        name: "assistant",
        content: {
          text: "I'll set your personal API key.",
          action: "MANAGE_SECRET",
        },
      },
    ],
    [
      {
        name: "user",
        content: {
          text: "List all world-level secrets",
        },
      },
      {
        name: "assistant",
        content: {
          text: "I'll list the secrets configured for this world.",
          action: "MANAGE_SECRET",
        },
      },
    ],
    [
      {
        name: "user",
        content: {
          text: "Delete the webhook URL secret",
        },
      },
      {
        name: "assistant",
        content: {
          text: "I'll delete the webhook URL secret.",
          action: "MANAGE_SECRET",
        },
      },
    ],
  ],
};

// Helper function to extract parameters from natural language
function extractParams(text: string): ManageSecretParams {
  const lowerText = text.toLowerCase();

  // Determine operation
  let operation: "get" | "set" | "delete" | "list" = "get";
  if (
    lowerText.includes("set") ||
    lowerText.includes("save") ||
    lowerText.includes("store")
  ) {
    operation = "set";
  } else if (lowerText.includes("delete") || lowerText.includes("remove")) {
    operation = "delete";
  } else if (lowerText.includes("list") || lowerText.includes("show all")) {
    operation = "list";
  }

  // Determine level
  let level: "global" | "world" | "user" = "user";
  if (lowerText.includes("global") || lowerText.includes("agent")) {
    level = "global";
  } else if (
    lowerText.includes("world") ||
    lowerText.includes("server") ||
    lowerText.includes("channel")
  ) {
    level = "world";
  }

  // Extract key and value (basic extraction)
  let key: string | undefined;
  let value: string | undefined;

  if (operation === "set") {
    // Look for patterns like "set X as Y" or "set X to Y"
    const setMatch = text.match(
      /set\s+(?:my\s+)?(\w+[\w\s]*?)\s+(?:as|to|=)\s+(.+)/i,
    );
    if (setMatch) {
      key = setMatch[1].trim().replace(/\s+/g, "_").toUpperCase();
      value = setMatch[2].trim();
    }
  } else if (operation === "get" || operation === "delete") {
    // Look for the key after the operation word
    const opMatch = text.match(
      new RegExp(
        `${operation}\\s+(?:the\\s+)?(?:my\\s+)?([\\w\\s]+?)(?:\\s+secret)?$`,
        "i",
      ),
    );
    if (opMatch) {
      key = opMatch[1].trim().replace(/\s+/g, "_").toUpperCase();
    }
  }

  return {
    operation,
    level,
    key,
    value,
  };
}
