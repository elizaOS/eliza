import {
  logger,
  type IAgentRuntime,
  type Memory,
  type Provider,
  type ProviderResult,
  type State,
  type UUID,
} from "@elizaos/core";
import type { EnvVarMetadata, EnvVarConfig } from "../types";
import { EnvManagerService } from "../service";

/**
 * Formats environment variable status for display
 * NEVER shows actual values for security
 */
function formatEnvVarStatus(config: EnvVarConfig): string {
  const statusIcon = {
    missing: "❌",
    generating: "⏳",
    validating: "🔍",
    invalid: "⚠️",
    valid: "✅",
  }[config.status];

  const typeLabel = config.type.replace("_", " ").toUpperCase();
  const requiredLabel = config.required ? "Required" : "Optional";

  let statusText = `${statusIcon} **${config.description || "Environment Variable"}**\n`;
  statusText += `   Type: ${typeLabel} (${requiredLabel})\n`;
  statusText += `   Status: ${config.status.toUpperCase()}\n`;

  if (config.canGenerate && config.status === "missing") {
    statusText += `   🤖 Can be auto-generated\n`;
  }

  if (config.lastError) {
    statusText += `   Error: ${config.lastError}\n`;
  }

  return statusText;
}

/**
 * Generates a comprehensive status message for all environment variables
 * NEVER shows actual values for security
 */
function generateEnvStatusMessage(envVars: EnvVarMetadata): string {
  const plugins = Object.keys(envVars);

  if (plugins.length === 0) {
    return "No environment variables configured yet.";
  }

  // Count variables by status
  let totalVars = 0;
  let missingRequired = 0;
  let generatable = 0;
  let needsUserInput = 0;
  let validVars = 0;

  for (const plugin of Object.values(envVars)) {
    for (const config of Object.values(plugin)) {
      totalVars++;
      if (config.status === "valid") {
        validVars++;
      } else if (config.required && config.status === "missing") {
        missingRequired++;
        if (config.canGenerate) {
          generatable++;
        } else {
          needsUserInput++;
        }
      }
    }
  }

  let statusMessage = `# Environment Variables Status\n\n`;
  statusMessage += `**Summary:** ${validVars}/${totalVars} variables configured\n`;

  if (missingRequired > 0) {
    statusMessage += `**Missing Required:** ${missingRequired} variables\n`;
    if (generatable > 0) {
      statusMessage += `**Auto-generatable:** ${generatable} variables\n`;
    }
    if (needsUserInput > 0) {
      statusMessage += `**Needs User Input:** ${needsUserInput} variables\n`;
    }
  }

  statusMessage += "\n";

  // Group by plugin
  for (const [pluginName, plugin] of Object.entries(envVars)) {
    statusMessage += `## ${pluginName.charAt(0).toUpperCase() + pluginName.slice(1)} Plugin\n\n`;

    for (const [varName, config] of Object.entries(plugin)) {
      statusMessage += `### ${varName}\n`;
      statusMessage += formatEnvVarStatus(config);
      statusMessage += "\n";
    }
  }

  // Add action recommendations
  if (missingRequired > 0) {
    statusMessage += "\n## Recommended Actions\n\n";

    if (generatable > 0) {
      statusMessage += `1. **Generate Variables**: I can automatically generate ${generatable} variables for you.\n`;
    }

    if (needsUserInput > 0) {
      statusMessage += `2. **User Input Required**: ${needsUserInput} variables need to be provided by you.\n`;
    }

    statusMessage +=
      "\nUse the SET_ENV_VAR action to configure variables or GENERATE_ENV_VAR to auto-generate them.\n";
  }

  return statusMessage;
}

/**
 * Environment status provider that shows current state of all environment variables
 * NEVER shows actual values for security
 */
export const envStatusProvider: Provider = {
  name: "ENV_STATUS",
  description: "Current status of environment variables for all plugins",

  get: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
  ): Promise<ProviderResult> => {
    try {
      const envService = runtime.getService("ENV_MANAGER") as EnvManagerService;

      if (!envService) {
        logger.debug("[EnvStatus] No environment manager service found");
        return {
          data: { envVars: {} },
          values: {
            envStatus: "Environment variable management not available.",
            hasMissing: false,
            hasGeneratable: false,
            needsUserInput: false,
          },
          text: "Environment variable management not available.",
        };
      }

      const envVars = await envService.getAllEnvVars();

      if (!envVars || Object.keys(envVars).length === 0) {
        logger.debug("[EnvStatus] No environment variables configured yet");
        return {
          data: { envVars: {} },
          values: {
            envStatus: "No environment variables configured yet.",
            hasMissing: false,
            hasGeneratable: false,
            needsUserInput: false,
          },
          text: "No environment variables configured yet.",
        };
      }

      // Calculate status flags
      let hasMissing = false;
      let hasGeneratable = false;
      let needsUserInput = false;

      for (const plugin of Object.values(envVars)) {
        for (const config of Object.values(plugin)) {
          if (config.required && config.status === "missing") {
            hasMissing = true;
            if (config.canGenerate) {
              hasGeneratable = true;
            } else {
              needsUserInput = true;
            }
          }
        }
      }

      const statusText = generateEnvStatusMessage(envVars);

      return {
        data: {
          envVars,
          summary: {
            total: Object.values(envVars).reduce(
              (sum, plugin) => sum + Object.keys(plugin).length,
              0,
            ),
            missing: Object.values(envVars).reduce(
              (sum, plugin) =>
                sum +
                Object.values(plugin).filter(
                  (c) => c.required && c.status === "missing",
                ).length,
              0,
            ),
            valid: Object.values(envVars).reduce(
              (sum, plugin) =>
                sum +
                Object.values(plugin).filter((c) => c.status === "valid")
                  .length,
              0,
            ),
          },
        },
        values: {
          envStatus: statusText,
          hasMissing,
          hasGeneratable,
          needsUserInput,
        },
        text: statusText,
      };
    } catch (error) {
      logger.error("[EnvStatus] Error in environment status provider:", error);
      return {
        data: { envVars: {} },
        values: {
          envStatus: "Error retrieving environment variable status.",
          hasMissing: false,
          hasGeneratable: false,
          needsUserInput: false,
        },
        text: "Error retrieving environment variable status.",
      };
    }
  },
};

export default envStatusProvider;
