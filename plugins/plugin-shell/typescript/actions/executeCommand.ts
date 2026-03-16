import type { HandlerOptions } from "@elizaos/core";
import {
  type Action,
  type ActionExample,
  type Content,
  composePromptFromState,
  type HandlerCallback,
  type IAgentRuntime,
  logger,
  type Memory,
  ModelType,
  parseJSONObjectFromText,
  type State,
} from "@elizaos/core";
import { commandExtractionTemplate } from "../generated/prompts/typescript/prompts.js";
import { requireActionSpec } from "../generated/specs/spec-helpers";
import type { ShellService } from "../services/shellService";
export { commandExtractionTemplate };

const extractCommand = async (
  runtime: IAgentRuntime,
  _message: Memory,
  state: State
): Promise<{ command: string } | null> => {
  const prompt = composePromptFromState({
    state,
    template: commandExtractionTemplate,
  });

  for (let i = 0; i < 3; i++) {
    const response = await runtime.useModel(ModelType.TEXT_SMALL, {
      prompt,
    });

    const parsedResponse = parseJSONObjectFromText(response) as {
      command?: string;
    } | null;
    if (parsedResponse?.command) {
      return { command: parsedResponse.command };
    }
  }
  return null;
};

const spec = requireActionSpec("EXECUTE_COMMAND");

export const executeCommand: Action = {
  name: spec.name,
  similes: spec.similes ? [...spec.similes] : [],
  description: spec.description,
  validate: async (runtime: IAgentRuntime, message: Memory, _state: State): Promise<boolean> => {
    const shellService = runtime.getService<ShellService>("shell");
    if (!shellService) {
      return false;
    }

    const text = message.content.text?.toLowerCase() || "";
    const commandKeywords = [
      "run",
      "execute",
      "command",
      "shell",
      "install",
      "brew",
      "npm",
      "create",
      "file",
      "directory",
      "folder",
      "list",
      "show",
      "system",
      "info",
      "check",
      "status",
      "cd",
      "ls",
      "mkdir",
      "echo",
      "cat",
      "touch",
      "git",
      "build",
      "test",
    ];

    const hasCommandKeyword = commandKeywords.some((keyword) => text.includes(keyword));
    const hasDirectCommand = /^(brew|npm|apt|git|ls|cd|echo|cat|touch|mkdir|rm|mv|cp)\s/i.test(
      message.content.text || ""
    );

    return hasCommandKeyword || hasDirectCommand;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback
  ) => {
    const shellService = runtime.getService<ShellService>("shell");

    if (!shellService) {
      if (callback) {
        await callback({
          text: "Shell service is not available.",
          source: message.content.source,
        });
      }
      return { success: false, error: "Shell service is not available." };
    }

    const commandInfo = await extractCommand(runtime, message, state);
    if (!commandInfo?.command) {
      logger.error("Failed to extract command from message:", message.content.text);
      if (callback) {
        await callback({
          text: "Could not determine which command to execute. Please specify a shell command.",
          source: message.content.source,
        });
      }
      return { success: false, error: "Could not extract command." };
    }

    logger.info(`Extracted command: "${commandInfo.command}"`);

    try {
      const conversationId = message.roomId || message.agentId;
      const result = await shellService.executeCommand(commandInfo.command, conversationId);

      let responseText = "";

      if (result.success) {
        responseText = `Command executed successfully in ${result.executedIn}\n\n`;
        if (result.stdout) {
          responseText += `Output:\n\`\`\`\n${result.stdout}\n\`\`\``;
        } else {
          responseText += "Command completed with no output.";
        }
      } else {
        responseText = `Command failed with exit code ${result.exitCode} in ${result.executedIn}\n\n`;
        if (result.error) {
          responseText += `Error: ${result.error}\n`;
        }
        if (result.stderr) {
          responseText += `\nError output:\n\`\`\`\n${result.stderr}\n\`\`\``;
        }
      }

      const response: Content = {
        text: responseText,
        source: message.content.source,
      };

      if (callback) {
        await callback(response);
      }
      return { success: result.success, text: responseText };
    } catch (error) {
      logger.error("Error executing command:", error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (callback) {
        await callback({
          text: `Failed to execute command: ${errorMessage}`,
          source: message.content.source,
        });
      }
      return { success: false, error: errorMessage };
    }
  },
  examples: (spec.examples ?? []) as ActionExample[][],
};

export default executeCommand;
