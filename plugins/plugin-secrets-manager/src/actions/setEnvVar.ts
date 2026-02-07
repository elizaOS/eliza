import {
  type Action,
  type ActionExample,
  composePrompt,
  type HandlerCallback,
  type IAgentRuntime,
  logger,
  type Memory,
  ModelType,
  parseJSONObjectFromText,
  type State,
  type UUID,
} from "@elizaos/core";
import type { EnvVarMetadata, EnvVarUpdate, EnvVarConfig } from "../types";
import { validateEnvVar } from "../validation";
import { EnvManagerService } from "../service";

/**
 * Template for extracting environment variable assignments from user input
 */
const extractionTemplate = `# Task: Extract Environment Variable Assignments from User Input

I need to extract environment variable assignments that the user wants to set based on their message.

Available Environment Variables:
{{envVarsContext}}

User message: {{content}}

For each environment variable mentioned in the user's input, extract the variable name and its new value.
Format your response as a JSON array of objects, each with 'pluginName', 'variableName', and 'value' properties.

Example response:
\`\`\`json
[
  { "pluginName": "openai", "variableName": "OPENAI_API_KEY", "value": "sk-..." },
  { "pluginName": "groq", "variableName": "GROQ_API_KEY", "value": "gsk_..." }
]
\`\`\`

IMPORTANT: Only include environment variables from the Available Environment Variables list above. Ignore any other potential variables.`;

/**
 * Template for success responses when environment variables are updated
 */
const successTemplate = `# Task: Generate a response for successful environment variable updates

# Environment Variables Status:
{{envStatus}}

# Update Information:
- Updated Variables: {{updateMessages}}
- Next Missing Variable: {{nextMissing}}
- Remaining Missing Variables: {{remainingMissing}}

# Instructions:
1. Acknowledge the successful update of environment variables
2. Maintain {{agentName}}'s personality and tone
3. If there are more missing variables, provide guidance on the next one that needs to be configured
4. Explain what the next variable is for and how to set it
5. If appropriate, mention how many required variables remain

Write a natural, conversational response that {{agentName}} would send about the successful update and next steps.
Include the actions array ["ENV_VAR_UPDATED"] in your response.

Response format should be formatted in a valid JSON block like this:
\`\`\`json
{ "text": "<string>", "actions": ["ENV_VAR_UPDATED"] }
\`\`\``;

/**
 * Template for failure responses when environment variables couldn't be updated
 */
const failureTemplate = `# Task: Generate a response for failed environment variable updates

# About {{agentName}}:
{{bio}}

# Environment Variables Status:
{{envStatus}}

# Recent Conversation:
{{recentMessages}}

# Instructions:
1. Express that you couldn't understand or process the environment variable update
2. Maintain {{agentName}}'s personality and tone
3. Provide clear guidance on what environment variables need to be configured
4. Explain what the variables are for and how to set them properly
5. Use a helpful, patient tone

Write a natural, conversational response that {{agentName}} would send about the failed update and how to proceed.
Include the actions array ["ENV_VAR_UPDATE_FAILED"] in your response.

Response format should be formatted in a valid JSON block like this:
\`\`\`json
{ "text": "<string>", "actions": ["ENV_VAR_UPDATE_FAILED"] }
\`\`\``;

/**
 * Extracts environment variable values from user message
 */
async function extractEnvVarValues(
  runtime: IAgentRuntime,
  message: Memory,
  state: State,
  envVars: EnvVarMetadata,
): Promise<EnvVarUpdate[]> {
  // Generate context for available environment variables
  const envVarsContext = Object.entries(envVars)
    .map(([pluginName, plugin]) => {
      return Object.entries(plugin)
        .filter(
          ([, config]) =>
            config.status === "missing" || config.status === "invalid",
        )
        .map(([varName, config]) => {
          const requiredStr = config.required ? "Required." : "Optional.";
          return `${pluginName}.${varName}: ${config.description} ${requiredStr}`;
        })
        .join("\n");
    })
    .filter(Boolean)
    .join("\n");

  if (!envVarsContext) {
    return [];
  }

  const prompt = composePrompt({
    state: {
      envVarsContext,
      content: state.text,
    },
    template: extractionTemplate,
  });

  try {
    const result = await runtime.useModel(ModelType.TEXT_LARGE, {
      prompt,
      stopSequences: [],
    });

    // Custom parsing for arrays since parseJSONObjectFromText only handles objects
    let parsed: any;
    const jsonBlockMatch = result.match(/```json\n([\s\S]*?)\n```/);

    try {
      if (jsonBlockMatch) {
        parsed = JSON.parse(jsonBlockMatch[1].trim());
      } else {
        parsed = JSON.parse(result.trim());
      }
    } catch (parseError) {
      logger.error("Error parsing JSON from model response:", parseError);
      return [];
    }

    if (!Array.isArray(parsed)) {
      return [];
    }

    // Validate extracted assignments
    const validAssignments: EnvVarUpdate[] = [];

    for (const assignment of parsed) {
      if (
        assignment.pluginName &&
        assignment.variableName &&
        assignment.value
      ) {
        // Check if the variable exists in our metadata
        if (envVars[assignment.pluginName]?.[assignment.variableName]) {
          validAssignments.push({
            pluginName: assignment.pluginName,
            variableName: assignment.variableName,
            value: assignment.value,
          });
        }
      }
    }

    return validAssignments;
  } catch (error) {
    logger.error("Error extracting environment variable values:", error);
    return [];
  }
}

/**
 * Processes multiple environment variable updates
 */
async function processEnvVarUpdates(
  runtime: IAgentRuntime,
  updates: EnvVarUpdate[],
): Promise<{ updatedAny: boolean; messages: string[] }> {
  if (!updates.length) {
    return { updatedAny: false, messages: [] };
  }

  const messages: string[] = [];
  let updatedAny = false;

  try {
    const envService = runtime.getService("ENV_MANAGER") as EnvManagerService;
    if (!envService) {
      throw new Error("Environment manager service not available");
    }

    // Process all updates
    for (const update of updates) {
      const { pluginName, variableName, value } = update;

      const envVars = await envService.getAllEnvVars();
      if (!envVars?.[pluginName]?.[variableName]) {
        messages.push(
          `Environment variable ${variableName} not found for plugin ${pluginName}`,
        );
        continue;
      }

      const config = envVars[pluginName][variableName];

      // Validate the environment variable
      const validationResult = await validateEnvVar(
        variableName,
        value,
        config.type,
        config.validationMethod,
      );

      const updateData: Partial<EnvVarConfig> = {
        value,
        status: validationResult.isValid ? "valid" : "invalid",
        attempts: config.attempts + 1,
        validatedAt: validationResult.isValid ? Date.now() : undefined,
        lastError: validationResult.isValid
          ? undefined
          : validationResult.error,
      };

      const updated = await envService.updateEnvVar(
        pluginName,
        variableName,
        updateData,
      );

      if (updated) {
        if (validationResult.isValid) {
          messages.push(`✅ ${variableName} validated successfully`);
        } else {
          messages.push(
            `❌ ${variableName} validation failed: ${validationResult.error}`,
          );
        }
        updatedAny = true;
      } else {
        messages.push(`Failed to update ${variableName}`);
      }
    }

    return { updatedAny, messages };
  } catch (error) {
    logger.error("Error processing environment variable updates:", error);
    return {
      updatedAny: false,
      messages: ["Error occurred while updating environment variables"],
    };
  }
}

/**
 * Gets the next missing environment variable that needs to be configured
 */
function getNextMissingEnvVar(
  envVars: EnvVarMetadata,
): { plugin: string; varName: string; config: EnvVarConfig } | null {
  for (const [pluginName, plugin] of Object.entries(envVars)) {
    for (const [varName, config] of Object.entries(plugin)) {
      if (config.required && config.status === "missing") {
        return { plugin: pluginName, varName, config };
      }
    }
  }
  return null;
}

/**
 * Set environment variable action
 */
export const setEnvVarAction: Action = {
  name: "SET_ENV_VAR",
  similes: [
    "UPDATE_ENV_VAR",
    "CONFIGURE_ENV",
    "SET_ENVIRONMENT",
    "UPDATE_ENVIRONMENT",
  ],
  description: "Sets environment variables for plugins based on user input",

  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
  ): Promise<boolean> => {
    try {
      const envService = runtime.getService("ENV_MANAGER") as EnvManagerService;
      if (!envService) return false;

      const envVars = await envService.getAllEnvVars();
      if (!envVars) return false;

      // Check if there are any missing or invalid environment variables
      for (const plugin of Object.values(envVars)) {
        for (const config of Object.values(plugin)) {
          if (config.status === "missing" || config.status === "invalid") {
            return true;
          }
        }
      }

      return false;
    } catch (error) {
      logger.error("Error validating SET_ENV_VAR action:", error);
      return false;
    }
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: any,
    callback?: HandlerCallback,
  ): Promise<void> => {
    try {
      if (!state || !callback) {
        throw new Error(
          "State and callback are required for SET_ENV_VAR action",
        );
      }

      const envService = runtime.getService("ENV_MANAGER") as EnvManagerService;
      if (!envService) {
        throw new Error("Environment manager service not available");
      }

      const envVars = await envService.getAllEnvVars();
      if (!envVars) {
        throw new Error("No environment variables metadata found");
      }

      // Extract environment variable assignments from message
      logger.info(
        `[SetEnvVar] Extracting env vars from message: ${message.content.text}`,
      );
      const extractedUpdates = await extractEnvVarValues(
        runtime,
        message,
        state,
        envVars,
      );
      logger.info(
        `[SetEnvVar] Extracted ${extractedUpdates.length} env var updates`,
      );

      // Process extracted updates
      const updateResults = await processEnvVarUpdates(
        runtime,
        extractedUpdates,
      );

      if (updateResults.updatedAny) {
        logger.info(
          `[SetEnvVar] Successfully updated env vars: ${updateResults.messages.join(", ")}`,
        );

        // Get updated environment variables
        const updatedEnvVars = await envService.getAllEnvVars();
        if (!updatedEnvVars) {
          throw new Error("Failed to retrieve updated environment variables");
        }

        // Get next missing variable
        const nextMissing = getNextMissingEnvVar(updatedEnvVars);
        const remainingMissing = Object.values(updatedEnvVars).reduce(
          (sum, plugin) =>
            sum +
            Object.values(plugin).filter(
              (c) => c.required && c.status === "missing",
            ).length,
          0,
        );

        // Generate success response
        const prompt = composePrompt({
          state: {
            updateMessages: updateResults.messages.join("\n"),
            nextMissing: nextMissing
              ? `${nextMissing.varName} (${nextMissing.config.description})`
              : "None",
            remainingMissing: remainingMissing.toString(),
          },
          template: successTemplate,
        });

        const response = await runtime.useModel(ModelType.TEXT_LARGE, {
          prompt,
          stopSequences: [],
        });

        const responseContent = parseJSONObjectFromText(response);

        await callback({
          text: responseContent.text,
          actions: ["ENV_VAR_UPDATED"],
          source: message.content.source,
        });
      } else {
        logger.info("[SetEnvVar] No environment variables were updated");

        // Generate failure response
        const prompt = composePrompt({
          state: {
            ...state.values,
            recentMessages: state.text,
          },
          template: failureTemplate,
        });

        const response = await runtime.useModel(ModelType.TEXT_LARGE, {
          prompt,
          stopSequences: [],
        });

        const responseContent = parseJSONObjectFromText(response);

        await callback({
          text: responseContent.text,
          actions: ["ENV_VAR_UPDATE_FAILED"],
          source: message.content.source,
        });
      }
    } catch (error) {
      logger.error(`[SetEnvVar] Error in handler: ${error}`);
      await callback?.({
        text: "I'm sorry, but I encountered an error while processing your environment variable update. Please try again or contact support if the issue persists.",
        actions: ["ENV_VAR_UPDATE_ERROR"],
        source: message.content.source,
      });
    }
  },

  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "Set OPENAI_API_KEY to sk-1234567890abcdef",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "✅ OPENAI_API_KEY validated successfully! The OpenAI plugin is now configured and ready to use.",
          actions: ["ENV_VAR_UPDATED"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "My Groq API key is gsk-abcdef1234567890",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "✅ GROQ_API_KEY validated successfully! The Groq plugin is now configured.",
          actions: ["ENV_VAR_UPDATED"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Configure ANTHROPIC_API_KEY as sk-ant-1234567890",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "✅ ANTHROPIC_API_KEY validated successfully! The Anthropic plugin is now ready.",
          actions: ["ENV_VAR_UPDATED"],
        },
      },
    ],
  ] as ActionExample[][],
};

export default setEnvVarAction;
