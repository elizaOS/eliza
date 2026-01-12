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

export const executeCommand: Action = {
  name: "EXECUTE_COMMAND",
  similes: [
    "RUN_COMMAND",
    "SHELL_COMMAND",
    "TERMINAL_COMMAND",
    "EXEC",
    "RUN",
    "EXECUTE",
    "CREATE_FILE",
    "WRITE_FILE",
    "MAKE_FILE",
    "INSTALL",
    "BREW_INSTALL",
    "NPM_INSTALL",
    "APT_INSTALL",
  ],
  description:
    "Execute shell commands including brew install, npm install, apt-get, system commands, file operations, directory navigation, and scripts.",
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
    _options: Record<string, unknown>,
    callback: HandlerCallback
  ) => {
    const shellService = runtime.getService<ShellService>("shell");

    if (!shellService) {
      await callback({
        text: "Shell service is not available.",
        source: message.content.source,
      });
      return { success: false, error: "Shell service is not available." };
    }

    const commandInfo = await extractCommand(runtime, message, state);
    if (!commandInfo?.command) {
      logger.error("Failed to extract command from message:", message.content.text);
      await callback({
        text: "Could not determine which command to execute. Please specify a shell command.",
        source: message.content.source,
      });
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

      await callback(response);
      return { success: result.success, text: responseText };
    } catch (error) {
      logger.error("Error executing command:", error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      await callback({
        text: `Failed to execute command: ${errorMessage}`,
        source: message.content.source,
      });
      return { success: false, error: errorMessage };
    }
  },
  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "run ls -la",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "I'll execute that command for you.",
          actions: ["EXECUTE_COMMAND"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "show me what files are in this directory",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "I'll list the files in the current directory.",
          actions: ["EXECUTE_COMMAND"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "navigate to the src folder",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "I'll change to the src directory.",
          actions: ["EXECUTE_COMMAND"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "check the git status",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "I'll check the git repository status.",
          actions: ["EXECUTE_COMMAND"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "create a file called hello.txt",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "I'll create hello.txt for you.",
          actions: ["EXECUTE_COMMAND"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "create hello_world.py and write a python hello world script inside",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "I'll create hello_world.py with a Python hello world script.",
          actions: ["EXECUTE_COMMAND"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "brew install orbstack",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "I'll install orbstack using brew.",
          actions: ["EXECUTE_COMMAND"],
        },
      },
    ],
  ] as ActionExample[][],
};

export default executeCommand;
