import {
  type Action,
  type ActionExample,
  type Content,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  ModelType,
  type State,
  composePromptFromState,
  parseJSONObjectFromText,
  logger,
} from '@elizaos/core';
import { ShellService } from '../services/shellService';

/**
 * Template for extracting command from user input
 */
export const commandExtractionTemplate = `# Extracting shell command from request
{{recentMessages}}

# Instructions: {{senderName}} wants to execute a shell command. Extract the COMPLETE shell command they want to run.

IMPORTANT: 
1. Always return the FULL executable shell command, not just the content or partial command.
2. If the user mentions installing something, create the appropriate brew/npm/apt command.
3. If the user directly provides a command (like "brew install X"), use it exactly as provided.
4. ALWAYS extract a command if the user is asking for ANY kind of system operation.

Common patterns:
- "run ls -la" -> command: "ls -la"
- "execute npm test" -> command: "npm test"
- "show me the files" or "list files" -> command: "ls -la"
- "what's in this directory" -> command: "ls -la"
- "check git status" -> command: "git status"
- "navigate to src folder" -> command: "cd src"
- "create a file called test.txt" -> command: "touch test.txt"
- "write hello world to a file" -> command: "echo 'hello world' > file.txt"
- "create hello.js with javascript code" -> command: "echo 'console.log(\"Hello, World!\");' > hello.js"
- "create hello_world.py and write a python hello world script inside" -> command: "echo 'print(\"Hello, World!\")' > hello_world.py"
- "make a new directory" -> command: "mkdir newdir"
- "list files inside your filesystem" -> command: "ls -la"
- "install orbstack" or "brew install orbstack" -> command: "brew install orbstack"
- "install mullvad vpn" -> command: "brew install --cask mullvad-vpn"
- "get system info" -> command: "system_profiler SPHardwareDataType"
- "check memory usage" -> command: "vm_stat"
- "install package" -> command: "brew install <package>"

Special cases:
- "Run it in your shell" or "execute it" -> Extract the command from previous context
- "Install these" -> Look for package names in previous messages
- Direct commands should be used exactly as provided

Key rules:
1. For file creation with content, use: echo 'content' > filename
2. For listing files, use: ls -la (not just ls)
3. Always include the echo command when writing to files
4. Include all flags and arguments
5. When user says "run it", "execute it", or similar, they want you to run the command

Your response must be formatted as a JSON block:
\`\`\`json
{
  "command": "<complete shell command to execute>"
}
\`\`\`
`;

/**
 * Extracts the command from the message
 */
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

    const parsedResponse = parseJSONObjectFromText(response);
    if (parsedResponse?.command) {
      return { command: parsedResponse.command };
    }
  }
  return null;
};

export const executeCommand: Action = {
  name: 'EXECUTE_COMMAND',
  similes: [
    'RUN_COMMAND',
    'SHELL_COMMAND',
    'TERMINAL_COMMAND',
    'EXEC',
    'RUN',
    'EXECUTE',
    'CREATE_FILE',
    'WRITE_FILE',
    'MAKE_FILE',
    'INSTALL',
    'BREW_INSTALL',
    'NPM_INSTALL',
    'APT_INSTALL',
  ],
  description:
    'Execute ANY shell command in the terminal. Use this to run ANY command including: brew install, npm install, apt-get, system commands, file operations (create, write, delete), navigate directories, execute scripts, or perform any other shell operation. I CAN and SHOULD execute commands when asked. This includes brew, npm, git, ls, cd, echo, touch, cat, mkdir, system_profiler, and literally ANY other terminal command.',
  validate: async (runtime: IAgentRuntime, message: Memory, _state: State) => {
    // Check if shell service is available
    const shellService = runtime.getService<ShellService>('shell');
    if (!shellService) {
      return false;
    }
    
    // This action should be used for ANY command execution request
    const text = message.content.text?.toLowerCase() || '';
    const commandKeywords = [
      'run', 'execute', 'command', 'shell', 'install', 'brew', 'npm',
      'create', 'file', 'directory', 'folder', 'list', 'show',
      'system', 'info', 'check', 'status', 'cd', 'ls', 'mkdir',
      'echo', 'cat', 'touch', 'git', 'build', 'test'
    ];
    
    // Be very permissive - if any command-related keyword is found, this action is valid
    const hasCommandKeyword = commandKeywords.some(keyword => text.includes(keyword));
    
    // Also check for direct commands
    const hasDirectCommand = /^(brew|npm|apt|git|ls|cd|echo|cat|touch|mkdir|rm|mv|cp)\s/i.test(message.content.text || '');
    
    return hasCommandKeyword || hasDirectCommand;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
    _options: any,
    callback: HandlerCallback
  ) => {
    const shellService = runtime.getService<ShellService>('shell');
    
    if (!shellService) {
      await callback({
        text: 'Shell service is not available.',
        source: message.content.source,
      });
      return;
    }

    // Extract command from message
    const commandInfo = await extractCommand(runtime, message, state);
    if (!commandInfo?.command) {
      logger.error('Failed to extract command from message:', message.content.text);
      await callback({
        text: "I couldn't understand which command you want to execute. Please specify a shell command.",
        source: message.content.source,
      });
      return;
    }

    logger.info(`User request: "${message.content.text}"`);
    logger.info(`Extracted command: "${commandInfo.command}"`);

    try {
      // Get conversation ID for history tracking
      const conversationId = message.roomId || message.agentId;
      
      // Execute the command with conversation tracking
      const result = await shellService.executeCommand(commandInfo.command, conversationId);
      
      // Format the response
      let responseText = '';
      
      if (result.success) {
        responseText = `Command executed successfully in ${result.executedIn}\n\n`;
        if (result.stdout) {
          responseText += `Output:\n\`\`\`\n${result.stdout}\n\`\`\``;
        } else {
          responseText += 'Command completed with no output.';
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
    } catch (error) {
      logger.error('Error executing command:', error);
      await callback({
        text: `Failed to execute command: ${error instanceof Error ? error.message : 'Unknown error'}`,
        source: message.content.source,
      });
    }
  },
  examples: [
    [
      {
        name: '{{name1}}',
        content: {
          text: 'run ls -la',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: "I'll execute that command for you.",
          actions: ['EXECUTE_COMMAND'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: 'show me what files are in this directory',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: "I'll list the files in the current directory.",
          actions: ['EXECUTE_COMMAND'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: 'navigate to the src folder',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: "I'll change to the src directory.",
          actions: ['EXECUTE_COMMAND'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: 'check the git status',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: "I'll check the git repository status.",
          actions: ['EXECUTE_COMMAND'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: 'create a file called hello.txt',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: "I'll create hello.txt for you.",
          actions: ['EXECUTE_COMMAND'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: 'create hello_world.py and write a python hello world script inside',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: "I'll create hello_world.py with a Python hello world script.",
          actions: ['EXECUTE_COMMAND'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: 'write some content to a file',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: "I'll write content to a file for you.",
          actions: ['EXECUTE_COMMAND'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: 'brew install orbstack',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: "I'll install orbstack using brew.",
          actions: ['EXECUTE_COMMAND'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: 'install mullvad vpn',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: "I'll install Mullvad VPN for you.",
          actions: ['EXECUTE_COMMAND'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: 'run the command brew install --cask docker',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: "I'll run that brew install command for you.",
          actions: ['EXECUTE_COMMAND'],
        },
      },
    ],
  ] as ActionExample[][],
} as Action;

export default executeCommand; 