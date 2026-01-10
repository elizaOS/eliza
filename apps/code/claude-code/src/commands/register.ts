/**
 * Command Registration
 * 
 * Registers all available CLI commands with the command registry.
 */

import { commandRegistry, ArgType, CommandDef } from './index.js';
import { logger } from '../utils/logger.js';
import { getAIClient, initAI } from '../ai/index.js';
import { fileExists, readTextFile } from '../fs/operations.js';
import { isNonEmptyString } from '../utils/validation.js';
import { formatErrorForDisplay } from '../errors/formatter.js';
import { authManager } from '../auth/index.js';
import { createUserError } from '../errors/formatter.js';
import { ErrorCategory } from '../errors/types.js';

/**
 * Register all commands
 */
export function registerCommands(): void {
  logger.debug('Registering commands');
  
  // Register core commands
  registerLoginCommand();
  registerLogoutCommand();
  registerAskCommand();
  registerExplainCommand();
  registerRefactorCommand();
  registerFixCommand();
  registerGenerateCommand();
  registerConfigCommand();
  registerBugCommand();
  registerFeedbackCommand();
  registerRunCommand();
  registerSearchCommand();
  registerThemeCommand();
  registerVerbosityCommand();
  registerEditCommand();
  registerGitCommand();
  registerExitCommand();
  registerQuitCommand();
  registerClearCommand();
  registerResetCommand();
  registerHistoryCommand();
  registerCommandsCommand();
  registerHelpCommand();
  
  logger.info('Commands registered successfully');
}

/**
 * Register login command
 */
function registerLoginCommand(): void {
  const command: CommandDef = {
    name: 'login',
    description: 'Log in to Claude AI',
    category: 'Auth',
    handler: async (args) => {
      try {
        const { 'api-key': apiKey, oauth } = args;
        
        console.log('Authenticating with Claude...');
        
        if (apiKey) {
          // Use API key authentication
          const authResult = await authManager.authenticateWithApiKey(apiKey);
          if (authResult.success) {
            console.log('Successfully logged in with API key.');
            
            // Display token expiration if available
            if (authResult.token?.expiresAt) {
              const expirationDate = new Date(authResult.token.expiresAt * 1000);
              console.log(`Token expires on: ${expirationDate.toLocaleString()}`);
            }
          } else {
            console.error(`Authentication failed: ${authResult.error || 'Unknown error'}`);
          }
        } else if (oauth) {
          // Use OAuth authentication
          const authResult = await authManager.authenticateWithOAuth();
          if (authResult.success) {
            console.log('Successfully logged in with OAuth.');
            
            // Display token expiration if available
            if (authResult.token?.expiresAt) {
              const expirationDate = new Date(authResult.token.expiresAt * 1000);
              console.log(`Token expires on: ${expirationDate.toLocaleString()}`);
            }
          } else {
            console.error(`Authentication failed: ${authResult.error || 'Unknown error'}`);
          }
        } else {
          // Determine method based on available environment variables
          const apiKeyFromEnv = process.env.ANTHROPIC_API_KEY;
          
          if (apiKeyFromEnv) {
            const authResult = await authManager.authenticateWithApiKey(apiKeyFromEnv);
            if (authResult.success) {
              console.log('Successfully logged in with API key from environment.');
              
              // Display token expiration if available
              if (authResult.token?.expiresAt) {
                const expirationDate = new Date(authResult.token.expiresAt * 1000);
                console.log(`Token expires on: ${expirationDate.toLocaleString()}`);
              }
            } else {
              console.error(`Authentication failed: ${authResult.error || 'Unknown error'}`);
            }
          } else {
            // Default to OAuth if no API key is available
            console.log('No API key found. Proceeding with OAuth authentication...');
            const authResult = await authManager.authenticateWithOAuth();
            if (authResult.success) {
              console.log('Successfully logged in with OAuth.');
              
              // Display token expiration if available
              if (authResult.token?.expiresAt) {
                const expirationDate = new Date(authResult.token.expiresAt * 1000);
                console.log(`Token expires on: ${expirationDate.toLocaleString()}`);
              }
            } else {
              console.error(`Authentication failed: ${authResult.error || 'Unknown error'}`);
            }
          }
        }
      } catch (error) {
        console.error('Error during authentication:', formatErrorForDisplay(error));
      }
    },
    args: [
      {
        name: 'api-key',
        description: 'API key for Claude AI',
        type: ArgType.STRING,
        shortFlag: 'k'
      },
      {
        name: 'oauth',
        description: 'Use OAuth authentication',
        type: ArgType.BOOLEAN,
        shortFlag: 'o'
      }
    ],
    examples: [
      'login',
      'login --api-key your-api-key'
    ]
  };
  
  commandRegistry.register(command);
}

/**
 * Register logout command
 */
function registerLogoutCommand(): void {
  const command: CommandDef = {
    name: 'logout',
    description: 'Log out and clear stored credentials',
    category: 'Auth',
    handler: async () => {
      try {
        console.log('Logging out and clearing credentials...');
        
        // Call the auth manager's logout function
        await authManager.logout();
        
        console.log('Successfully logged out. All credentials have been cleared.');
      } catch (error) {
        console.error('Error during logout:', formatErrorForDisplay(error));
      }
    },
    examples: [
      'logout'
    ]
  };
  
  commandRegistry.register(command);
}

/**
 * Register ask command
 */
function registerAskCommand(): void {
  const command: CommandDef = {
    name: 'ask',
    description: 'Ask Claude a question about code or programming',
    category: 'Assistance',
    handler: async (args) => {
      try {
        const { question } = args;
        
        if (!isNonEmptyString(question)) {
          console.error('Please provide a question to ask Claude.');
          return;
        }
        
        console.log('Asking Claude...\n');
        
        // Get AI client and send question
        const aiClient = getAIClient();
        const result = await aiClient.complete(question);
        
        // Extract and print the response
        const responseText = result.content[0]?.text || 'No response received';
        console.log(responseText);
      } catch (error) {
        console.error('Error asking Claude:', formatErrorForDisplay(error));
      }
    },
    args: [
      {
        name: 'question',
        description: 'Question to ask Claude',
        type: ArgType.STRING,
        position: 0,
        required: true
      },
      {
        name: 'context',
        description: 'Provide additional context files',
        type: ArgType.STRING,
        shortFlag: 'c'
      },
      {
        name: 'model',
        description: 'Specific Claude model to use',
        type: ArgType.STRING,
        shortFlag: 'm',
        choices: ['claude-3-opus', 'claude-3-sonnet', 'claude-3-haiku']
      }
    ],
    examples: [
      'ask "How do I implement a binary search tree in TypeScript?"',
      'ask "What\'s wrong with this code?" --context ./path/to/file.js'
    ],
    requiresAuth: true
  };
  
  commandRegistry.register(command);
}

/**
 * Register explain command
 */
function registerExplainCommand(): void {
  const command: CommandDef = {
    name: 'explain',
    description: 'Explain a code file or snippet',
    category: 'Assistance',
    handler: async (args) => {
      try {
        const { file } = args;
        
        // Validate file path
        if (!isNonEmptyString(file)) {
          console.error('Please provide a file path to explain.');
          return;
        }
        
        // Check if file exists
        if (!await fileExists(file)) {
          console.error(`File not found: ${file}`);
          return;
        }
        
        console.log(`Explaining ${file}...\n`);
        
        // Read the file
        const fileContent = await readTextFile(file);
        
        // Construct the prompt
        const prompt = `Please explain this code:\n\n\`\`\`\n${fileContent}\n\`\`\``;
        
        // Get AI client and send request
        const aiClient = getAIClient();
        const result = await aiClient.complete(prompt);
        
        // Extract and print the response
        const responseText = result.content[0]?.text || 'No explanation received';
        console.log(responseText);
      } catch (error) {
        console.error('Error explaining code:', formatErrorForDisplay(error));
      }
    },
    args: [
      {
        name: 'file',
        description: 'File to explain',
        type: ArgType.STRING,
        position: 0,
        required: true
      },
      {
        name: 'detail',
        description: 'Level of detail',
        type: ArgType.STRING,
        shortFlag: 'd',
        choices: ['basic', 'intermediate', 'detailed'],
        default: 'intermediate'
      }
    ],
    examples: [
      'explain path/to/file.js',
      'explain path/to/file.py --detail detailed'
    ],
    requiresAuth: true
  };
  
  commandRegistry.register(command);
}

/**
 * Register refactor command
 */
function registerRefactorCommand(): void {
  const command: CommandDef = {
    name: 'refactor',
    description: 'Refactor code for better readability, performance, or structure',
    category: 'Code Generation',
    handler: async (args) => {
      try {
        const { file, focus } = args;
        
        // Validate file path
        if (!isNonEmptyString(file)) {
          console.error('Please provide a file path to refactor.');
          return;
        }
        
        // Check if file exists
        if (!await fileExists(file)) {
          console.error(`File not found: ${file}`);
          return;
        }
        
        console.log(`Refactoring ${file} with focus on ${focus}...\n`);
        
        // Read the file
        const fileContent = await readTextFile(file);
        
        // Construct the prompt
        const prompt = `Please refactor this code to improve ${focus}:\n\n\`\`\`\n${fileContent}\n\`\`\``;
        
        // Get AI client and send request
        const aiClient = getAIClient();
        const result = await aiClient.complete(prompt);
        
        // Extract and print the response
        const responseText = result.content[0]?.text || 'No refactored code received';
        console.log(responseText);
      } catch (error) {
        console.error('Error refactoring code:', formatErrorForDisplay(error));
      }
    },
    args: [
      {
        name: 'file',
        description: 'File to refactor',
        type: ArgType.STRING,
        position: 0,
        required: true
      },
      {
        name: 'focus',
        description: 'Focus of the refactoring',
        type: ArgType.STRING,
        shortFlag: 'f',
        choices: ['readability', 'performance', 'simplicity', 'maintainability'],
        default: 'readability'
      },
      {
        name: 'output',
        description: 'Output file path (defaults to stdout)',
        type: ArgType.STRING,
        shortFlag: 'o'
      }
    ],
    examples: [
      'refactor path/to/file.js',
      'refactor path/to/file.py --focus performance',
      'refactor path/to/file.ts --output path/to/refactored.ts'
    ],
    requiresAuth: true
  };
  
  commandRegistry.register(command);
}

/**
 * Register fix command
 */
function registerFixCommand(): void {
  const command: CommandDef = {
    name: 'fix',
    description: 'Fix bugs or issues in code',
    category: 'Assistance',
    handler: async (args) => {
      try {
        const { file, issue } = args;
        
        // Validate file path
        if (!isNonEmptyString(file)) {
          console.error('Please provide a file path to fix.');
          return;
        }
        
        // Check if file exists
        if (!await fileExists(file)) {
          console.error(`File not found: ${file}`);
          return;
        }
        
        console.log(`Fixing ${file}...\n`);
        
        // Read the file
        const fileContent = await readTextFile(file);
        
        // Construct the prompt
        let prompt = `Please fix this code:\n\n\`\`\`\n${fileContent}\n\`\`\``;
        
        if (isNonEmptyString(issue)) {
          prompt += `\n\nThe specific issue is: ${issue}`;
        }
        
        // Get AI client and send request
        const aiClient = getAIClient();
        const result = await aiClient.complete(prompt);
        
        // Extract and print the response
        const responseText = result.content[0]?.text || 'No fixed code received';
        console.log(responseText);
      } catch (error) {
        console.error('Error fixing code:', formatErrorForDisplay(error));
      }
    },
    args: [
      {
        name: 'file',
        description: 'File to fix',
        type: ArgType.STRING,
        position: 0,
        required: true
      },
      {
        name: 'issue',
        description: 'Description of the issue to fix',
        type: ArgType.STRING,
        shortFlag: 'i'
      },
      {
        name: 'output',
        description: 'Output file path (defaults to stdout)',
        type: ArgType.STRING,
        shortFlag: 'o'
      }
    ],
    examples: [
      'fix path/to/file.js',
      'fix path/to/file.py --issue "Infinite loop in the sort function"',
      'fix path/to/file.ts --output path/to/fixed.ts'
    ],
    requiresAuth: true
  };
  
  commandRegistry.register(command);
}

/**
 * Register generate command
 */
function registerGenerateCommand(): void {
  const command: CommandDef = {
    name: 'generate',
    description: 'Generate code based on a prompt',
    category: 'Code Generation',
    handler: async (args) => {
      try {
        const { prompt, language } = args;
        
        // Validate prompt
        if (!isNonEmptyString(prompt)) {
          console.error('Please provide a prompt for code generation.');
          return;
        }
        
        console.log(`Generating ${language} code...\n`);
        
        // Construct the prompt
        const fullPrompt = `Generate ${language} code that ${prompt}. Please provide only the code without explanations.`;
        
        // Get AI client and send request
        const aiClient = getAIClient();
        const result = await aiClient.complete(fullPrompt);
        
        // Extract and print the response
        const responseText = result.content[0]?.text || 'No code generated';
        console.log(responseText);
      } catch (error) {
        console.error('Error generating code:', formatErrorForDisplay(error));
      }
    },
    args: [
      {
        name: 'prompt',
        description: 'Description of the code to generate',
        type: ArgType.STRING,
        position: 0,
        required: true
      },
      {
        name: 'language',
        description: 'Programming language for the generated code',
        type: ArgType.STRING,
        shortFlag: 'l',
        default: 'JavaScript'
      },
      {
        name: 'output',
        description: 'Output file path (defaults to stdout)',
        type: ArgType.STRING,
        shortFlag: 'o'
      }
    ],
    examples: [
      'generate "a function that sorts an array using quick sort"',
      'generate "a REST API server with Express" --language TypeScript',
      'generate "a binary search tree implementation" --output bst.js'
    ],
    requiresAuth: true
  };
  
  commandRegistry.register(command);
}

/**
 * Register config command
 */
function registerConfigCommand(): void {
  logger.debug('Registering config command');

  const command = {
    name: 'config',
    description: 'View or edit configuration settings',
    category: 'system',
    async handler({ key, value }: { key?: string; value?: string }) {
      logger.info('Executing config command');
      
      try {
        const configModule = await import('../config/index.js');
        // Load the current configuration
        const currentConfig = await configModule.loadConfig();
        
        if (!key) {
          // Display the current configuration
          logger.info('Current configuration:');
          console.log(JSON.stringify(currentConfig, null, 2));
          return;
        }
        
        // Handle nested keys like "api.baseUrl"
        const keyPath = key.split('.');
        let configSection: any = currentConfig;
        
        // Navigate to the nested config section
        for (let i = 0; i < keyPath.length - 1; i++) {
          configSection = configSection[keyPath[i]];
          if (!configSection) {
            throw new Error(`Configuration key '${key}' not found`);
          }
        }
        
        const finalKey = keyPath[keyPath.length - 1];
        
        if (value === undefined) {
          // Get the value
          const keyValue = configSection[finalKey];
          if (keyValue === undefined) {
            throw new Error(`Configuration key '${key}' not found`);
          }
          logger.info(`${key}: ${JSON.stringify(keyValue)}`);
        } else {
          // Set the value
          // Parse the value if needed (convert strings to numbers/booleans)
          let parsedValue: any = value;
          if (value.toLowerCase() === 'true') parsedValue = true;
          else if (value.toLowerCase() === 'false') parsedValue = false;
          else if (!isNaN(Number(value))) parsedValue = Number(value);
          
          // Update the config in memory
          configSection[finalKey] = parsedValue;
          
          // Save the updated config to file
          // Since there's no direct saveConfig function, we'd need to implement
          // this part separately to write to a config file
          logger.info(`Configuration updated in memory: ${key} = ${JSON.stringify(parsedValue)}`);
          logger.warn('Note: Configuration changes are only temporary for this session');
          // In a real implementation, we would save to the config file
        }
      } catch (error) {
        logger.error(`Error executing config command: ${error instanceof Error ? error.message : 'Unknown error'}`);
        throw error;
      }
    },
    args: [
      {
        name: 'key',
        description: 'Configuration key (e.g., "api.baseUrl")',
        type: ArgType.STRING,
        required: false
      },
      {
        name: 'value',
        description: 'New value to set',
        type: ArgType.STRING,
        required: false
      }
    ],
    examples: [
      'config',
      'config api.baseUrl',
      'config api.baseUrl https://api.anthropic.com',
      'config telemetry.enabled false'
    ]
  };

  commandRegistry.register(command);
}

/**
 * Register bug command
 */
function registerBugCommand(): void {
  logger.debug('Registering bug command');

  const command = {
    name: 'bug',
    description: 'Report a bug or issue with Claude Code',
    category: 'system',
    async handler(args: Record<string, any>): Promise<void> {
      logger.info('Executing bug command');
      
      const description = args.description;
      if (!isNonEmptyString(description)) {
        throw createUserError('Bug description is required', {
          category: ErrorCategory.VALIDATION,
          resolution: 'Please provide a description of the bug you encountered'
        });
      }
      
      try {
        // In a real implementation, this would send the bug report to a server
        logger.info('Submitting bug report...');
        
        // Get system information
        const os = await import('os');
        const systemInfo = {
          platform: os.platform(),
          release: os.release(),
          nodeVersion: process.version,
          appVersion: '0.2.29', // This would come from package.json in a real implementation
          timestamp: new Date().toISOString()
        };
        
        // Get current telemetry client
        const telemetryModule = await import('../telemetry/index.js');
        const telemetryManager = await telemetryModule.initTelemetry();
        
        telemetryManager.trackEvent('BUG_REPORT', {
          description,
          ...systemInfo
        });
        
        logger.info('Bug report submitted successfully');
        console.log('Thank you for your bug report. Our team will investigate the issue.');
        
      } catch (error) {
        logger.error(`Error submitting bug report: ${error instanceof Error ? error.message : 'Unknown error'}`);
        throw error;
      }
    },
    args: [
      {
        name: 'description',
        description: 'Description of the bug or issue',
        type: ArgType.STRING,
        required: true
      }
    ],
    examples: [
      'bug "The login command fails with a network error"',
      'bug "The application crashes when processing large files"'
    ]
  };

  commandRegistry.register(command);
}

/**
 * Register feedback command
 */
function registerFeedbackCommand(): void {
  logger.debug('Registering feedback command');

  const command = {
    name: 'feedback',
    description: 'Provide general feedback about Claude Code',
    category: 'system',
    async handler(args: Record<string, any>): Promise<void> {
      logger.info('Executing feedback command');
      
      const content = args.content;
      if (!isNonEmptyString(content)) {
        throw createUserError('Feedback content is required', {
          category: ErrorCategory.VALIDATION,
          resolution: 'Please provide your feedback about Claude Code'
        });
      }
      
      try {
        // In a real implementation, this would send the feedback to a server
        logger.info('Submitting feedback...');
        
        // Get system information
        const os = await import('os');
        const systemInfo = {
          platform: os.platform(),
          release: os.release(),
          nodeVersion: process.version,
          appVersion: '0.2.29', // This would come from package.json in a real implementation
          timestamp: new Date().toISOString()
        };
        
        // Get current telemetry client
        const telemetryModule = await import('../telemetry/index.js');
        const telemetryManager = await telemetryModule.initTelemetry();
        
        telemetryManager.trackEvent('USER_FEEDBACK', {
          content,
          ...systemInfo
        });
        
        logger.info('Feedback submitted successfully');
        console.log('Thank you for your feedback. We appreciate your input.');
        
      } catch (error) {
        logger.error(`Error submitting feedback: ${error instanceof Error ? error.message : 'Unknown error'}`);
        throw error;
      }
    },
    args: [
      {
        name: 'content',
        description: 'Your feedback about Claude Code',
        type: ArgType.STRING,
        required: true
      }
    ],
    examples: [
      'feedback "I love the AI-assisted code generation feature"',
      'feedback "The error messages could be more descriptive"'
    ]
  };

  commandRegistry.register(command);
}

/**
 * Register run command
 */
function registerRunCommand(): void {
  logger.debug('Registering run command');

  const command = {
    name: 'run',
    description: 'Execute a terminal command',
    category: 'system',
    async handler(args: Record<string, any>): Promise<void> {
      logger.info('Executing run command');
      
      const commandToRun = args.command;
      if (!isNonEmptyString(commandToRun)) {
        throw createUserError('Command is required', {
          category: ErrorCategory.VALIDATION,
          resolution: 'Please provide a command to execute'
        });
      }
      
      try {
        logger.info(`Running command: ${commandToRun}`);
        
        // Execute the command
        const { exec } = await import('child_process');
        const util = await import('util');
        const execPromise = util.promisify(exec);
        
        logger.debug(`Executing: ${commandToRun}`);
        const { stdout, stderr } = await execPromise(commandToRun);
        
        if (stdout) {
          console.log(stdout);
        }
        
        if (stderr) {
          console.error(stderr);
        }
        
        logger.info('Command executed successfully');
      } catch (error) {
        logger.error(`Error executing command: ${error instanceof Error ? error.message : 'Unknown error'}`);
        
        if (error instanceof Error) {
          console.error(`Error: ${error.message}`);
        }
        
        throw error;
      }
    },
    args: [
      {
        name: 'command',
        description: 'The command to execute',
        type: ArgType.STRING,
        required: true
      }
    ],
    examples: [
      'run "ls -la"',
      'run "npm install"',
      'run "git status"'
    ]
  };

  commandRegistry.register(command);
}

/**
 * Register search command
 */
function registerSearchCommand(): void {
  logger.debug('Registering search command');

  const command = {
    name: 'search',
    description: 'Search the codebase for a term',
    category: 'system',
    async handler(args: Record<string, any>): Promise<void> {
      logger.info('Executing search command');
      
      const term = args.term;
      if (!isNonEmptyString(term)) {
        throw createUserError('Search term is required', {
          category: ErrorCategory.VALIDATION,
          resolution: 'Please provide a term to search for'
        });
      }
      
      try {
        logger.info(`Searching for: ${term}`);
        
        // Get search directory (current directory if not specified)
        const searchDir = args.dir || process.cwd();
        
        // Execute the search using ripgrep if available, otherwise fall back to simple grep
        const { exec } = await import('child_process');
        const util = await import('util');
        const execPromise = util.promisify(exec);
        
        let searchCommand;
        const searchPattern = term.includes(' ') ? `"${term}"` : term;
        
        try {
          // Try to use ripgrep (rg) for better performance
          await execPromise('rg --version');
          
          // Ripgrep is available, use it
          searchCommand = `rg --color=always --line-number --heading --smart-case ${searchPattern} ${searchDir}`;
        } catch {
          // Fall back to grep (available on most Unix systems)
          searchCommand = `grep -r --color=always -n "${term}" ${searchDir}`;
        }
        
        logger.debug(`Running search command: ${searchCommand}`);
        const { stdout, stderr } = await execPromise(searchCommand);
        
        if (stderr) {
          console.error(stderr);
        }
        
        if (stdout) {
          console.log(stdout);
        } else {
          console.log(`No results found for '${term}'`);
        }
        
        logger.info('Search completed');
      } catch (error) {
        logger.error(`Error searching codebase: ${error instanceof Error ? error.message : 'Unknown error'}`);
        
        if (error instanceof Error) {
          console.error(`Error: ${error.message}`);
        }
        
        throw error;
      }
    },
    args: [
      {
        name: 'term',
        description: 'The term to search for',
        type: ArgType.STRING,
        position: 0,
        required: true
      },
      {
        name: 'dir',
        description: 'Directory to search in (defaults to current directory)',
        type: ArgType.STRING,
        shortFlag: 'd'
      }
    ],
    examples: [
      'search "function main"',
      'search TODO',
      'search "import React" --dir ./src'
    ]
  };

  commandRegistry.register(command);
}

/**
 * Register theme command
 */
function registerThemeCommand(): void {
  logger.debug('Registering theme command');

  const command = {
    name: 'theme',
    description: 'Change the UI theme',
    category: 'system',
    async handler(args: Record<string, any>): Promise<void> {
      logger.info('Executing theme command');
      
      const theme = args.name;
      if (!isNonEmptyString(theme)) {
        // If no theme is specified, display the current theme
        const configModule = await import('../config/index.js');
        const currentConfig = await configModule.loadConfig();
        
        const currentTheme = currentConfig.terminal?.theme || 'system';
        console.log(`Current theme: ${currentTheme}`);
        console.log('Available themes: dark, light, system');
        return;
      }
      
      // Validate the theme
      const validThemes = ['dark', 'light', 'system'];
      if (!validThemes.includes(theme.toLowerCase())) {
        throw createUserError(`Invalid theme: ${theme}`, {
          category: ErrorCategory.VALIDATION,
          resolution: `Please choose one of: ${validThemes.join(', ')}`
        });
      }
      
      try {
        // Update the theme in the configuration
        const configModule = await import('../config/index.js');
        const currentConfig = await configModule.loadConfig();
        
        if (!currentConfig.terminal) {
          currentConfig.terminal = {};
        }
        
        currentConfig.terminal.theme = theme.toLowerCase();
        
        logger.info(`Theme updated to: ${theme}`);
        console.log(`Theme set to: ${theme}`);
        console.log('Note: Theme changes are only temporary for this session. Use the config command to make permanent changes.');
        
      } catch (error) {
        logger.error(`Error changing theme: ${error instanceof Error ? error.message : 'Unknown error'}`);
        throw error;
      }
    },
    args: [
      {
        name: 'name',
        description: 'Theme name (dark, light, system)',
        type: ArgType.STRING,
        position: 0,
        required: false
      }
    ],
    examples: [
      'theme',
      'theme dark',
      'theme light',
      'theme system'
    ]
  };

  commandRegistry.register(command);
}

/**
 * Register verbosity command
 */
function registerVerbosityCommand(): void {
  logger.debug('Registering verbosity command');

  const command = {
    name: 'verbosity',
    description: 'Set output verbosity level',
    category: 'system',
    async handler(args: Record<string, any>): Promise<void> {
      logger.info('Executing verbosity command');
      
      const level = args.level;
      
      try {
        // If no level is specified, display the current verbosity level
        if (!isNonEmptyString(level)) {
          const configModule = await import('../config/index.js');
          const currentConfig = await configModule.loadConfig();
          
          const currentLevel = currentConfig.logger?.level || 'info';
          console.log(`Current verbosity level: ${currentLevel}`);
          console.log('Available levels: error, warn, info, debug');
          return;
        }
        
        // Validate the verbosity level and map to LogLevel
        const { LogLevel } = await import('../utils/logger.js');
        let logLevel: any;
        
        switch (level.toLowerCase()) {
          case 'debug':
            logLevel = LogLevel.DEBUG;
            break;
          case 'info':
            logLevel = LogLevel.INFO;
            break;
          case 'warn':
            logLevel = LogLevel.WARN;
            break;
          case 'error':
            logLevel = LogLevel.ERROR;
            break;
          case 'silent':
            logLevel = LogLevel.SILENT;
            break;
          default:
            throw createUserError(`Invalid verbosity level: ${level}`, {
              category: ErrorCategory.VALIDATION,
              resolution: `Please choose one of: debug, info, warn, error, silent`
            });
        }
        
        // Update the verbosity level in the configuration
        const configModule = await import('../config/index.js');
        const currentConfig = await configModule.loadConfig();
        
        if (!currentConfig.logger) {
          currentConfig.logger = {};
        }
        
        currentConfig.logger.level = level.toLowerCase();
        
        // Update the logger instance directly
        logger.setLevel(logLevel);
        
        logger.info(`Verbosity level updated to: ${level}`);
        console.log(`Verbosity level set to: ${level}`);
        
      } catch (error) {
        logger.error(`Error changing verbosity level: ${error instanceof Error ? error.message : 'Unknown error'}`);
        throw error;
      }
    },
    args: [
      {
        name: 'level',
        description: 'Verbosity level (debug, info, warn, error, silent)',
        type: ArgType.STRING,
        position: 0,
        required: false
      }
    ],
    examples: [
      'verbosity',
      'verbosity info',
      'verbosity debug',
      'verbosity error'
    ]
  };

  commandRegistry.register(command);
}

/**
 * Register edit command
 */
function registerEditCommand(): void {
  logger.debug('Registering edit command');

  const command = {
    name: 'edit',
    description: 'Edit a specified file',
    category: 'system',
    async handler(args: Record<string, any>): Promise<void> {
      logger.info('Executing edit command');
      
      const file = args.file;
      if (!isNonEmptyString(file)) {
        throw createUserError('File path is required', {
          category: ErrorCategory.VALIDATION,
          resolution: 'Please provide a file path to edit'
        });
      }
      
      try {
        // Check if file exists
        const fs = await import('fs/promises');
        const path = await import('path');
        
        // Resolve the file path
        const resolvedPath = path.resolve(process.cwd(), file);
        
        try {
          // Check if file exists
          await fs.access(resolvedPath);
        } catch (error) {
          // If file doesn't exist, create it with empty content
          logger.info(`File doesn't exist, creating: ${resolvedPath}`);
          await fs.writeFile(resolvedPath, '');
        }
        
        logger.info(`Opening file for editing: ${resolvedPath}`);
        
        // On different platforms, open the file with different editors
        const { platform } = await import('os');
        const { exec } = await import('child_process');
        const util = await import('util');
        const execPromise = util.promisify(exec);
        
        let editorCommand;
        const systemPlatform = platform();
        
        // Try to use the EDITOR environment variable first
        const editor = process.env.EDITOR;
        
        if (editor) {
          editorCommand = `${editor} "${resolvedPath}"`;
        } else {
          // Default editors based on platform
          if (systemPlatform === 'win32') {
            editorCommand = `notepad "${resolvedPath}"`;
          } else if (systemPlatform === 'darwin') {
            editorCommand = `open -a TextEdit "${resolvedPath}"`;
          } else {
            // Try nano first, fall back to vi
            try {
              await execPromise('which nano');
              editorCommand = `nano "${resolvedPath}"`;
            } catch {
              editorCommand = `vi "${resolvedPath}"`;
            }
          }
        }
        
        logger.debug(`Executing editor command: ${editorCommand}`);
        console.log(`Opening ${resolvedPath} for editing...`);
        
        const child = exec(editorCommand);
        
        // Log when the editor process exits
        child.on('exit', (code) => {
          logger.info(`Editor process exited with code: ${code}`);
          if (code === 0) {
            console.log(`File saved: ${resolvedPath}`);
          } else {
            console.error(`Editor exited with non-zero code: ${code}`);
          }
        });
        
        // Wait for the editor to start
        await new Promise((resolve) => setTimeout(resolve, 1000));
        
      } catch (error) {
        logger.error(`Error editing file: ${error instanceof Error ? error.message : 'Unknown error'}`);
        throw error;
      }
    },
    args: [
      {
        name: 'file',
        description: 'File path to edit',
        type: ArgType.STRING,
        position: 0,
        required: true
      }
    ],
    examples: [
      'edit path/to/file.txt',
      'edit newfile.md'
    ]
  };

  commandRegistry.register(command);
}

/**
 * Register git command
 */
function registerGitCommand(): void {
  logger.debug('Registering git command');

  const command = {
    name: 'git',
    description: 'Perform git operations',
    category: 'system',
    async handler(args: Record<string, any>): Promise<void> {
      logger.info('Executing git command');
      
      const operation = args.operation;
      if (!isNonEmptyString(operation)) {
        throw createUserError('Git operation is required', {
          category: ErrorCategory.VALIDATION,
          resolution: 'Please provide a git operation to perform'
        });
      }
      
      try {
        logger.info(`Performing git operation: ${operation}`);
        
        // Check if git is installed
        const { exec } = await import('child_process');
        const util = await import('util');
        const execPromise = util.promisify(exec);
        
        try {
          await execPromise('git --version');
        } catch (error) {
          throw createUserError('Git is not installed or not in PATH', {
            category: ErrorCategory.COMMAND_EXECUTION,
            resolution: 'Please install git or add it to your PATH'
          });
        }
        
        // Validate the operation is a simple command without pipes, redirection, etc.
        const validOpRegex = /^[a-z0-9\-_\s]+$/i;
        if (!validOpRegex.test(operation)) {
          throw createUserError('Invalid git operation', {
            category: ErrorCategory.VALIDATION,
            resolution: 'Please provide a simple git operation without special characters'
          });
        }
        
        // Construct and execute the git command
        const gitCommand = `git ${operation}`;
        logger.debug(`Executing git command: ${gitCommand}`);
        
        const { stdout, stderr } = await execPromise(gitCommand);
        
        if (stderr) {
          console.error(stderr);
        }
        
        if (stdout) {
          console.log(stdout);
        }
        
        logger.info('Git operation completed');
      } catch (error) {
        logger.error(`Error executing git operation: ${error instanceof Error ? error.message : 'Unknown error'}`);
        
        if (error instanceof Error) {
          console.error(`Error: ${error.message}`);
        }
        
        throw error;
      }
    },
    args: [
      {
        name: 'operation',
        description: 'Git operation to perform',
        type: ArgType.STRING,
        position: 0,
        required: true
      }
    ],
    examples: [
      'git status',
      'git log',
      'git add .',
      'git commit -m "Commit message"'
    ]
  };

  commandRegistry.register(command);
}

/**
 * Register exit command
 */
function registerExitCommand(): void {
  logger.debug('Registering exit command');

  const command = {
    name: 'exit',
    description: 'Exit the application',
    category: 'session',
    async handler(): Promise<void> {
      logger.info('Executing exit command');
      console.log('Exiting Claude Code CLI...');
      process.exit(0);
    },
    examples: [
      'exit'
    ]
  };

  commandRegistry.register(command);
}

/**
 * Register quit command (alias for exit)
 */
function registerQuitCommand(): void {
  logger.debug('Registering quit command');

  const command = {
    name: 'quit',
    description: 'Exit the application (alias for exit)',
    category: 'session',
    async handler(): Promise<void> {
      logger.info('Executing quit command');
      console.log('Exiting Claude Code CLI...');
      process.exit(0);
    },
    examples: [
      'quit'
    ]
  };

  commandRegistry.register(command);
}

/**
 * Register clear command
 */
function registerClearCommand(): void {
  logger.debug('Registering clear command');

  const command = {
    name: 'clear',
    description: 'Clear the current session display',
    category: 'session',
    async handler(): Promise<void> {
      logger.info('Executing clear command');
      
      // Clear the console using the appropriate method for the current platform
      // This is the cross-platform way to clear the terminal
      process.stdout.write('\x1Bc');
      
      console.log('Display cleared.');
    },
    examples: [
      'clear'
    ]
  };

  commandRegistry.register(command);
}

/**
 * Register reset command
 */
function registerResetCommand(): void {
  logger.debug('Registering reset command');

  const command = {
    name: 'reset',
    description: 'Reset the conversation context with Claude',
    category: 'session',
    async handler(): Promise<void> {
      logger.info('Executing reset command');
      
      try {
        // Since there's no direct reset method, we'll reinitialize the AI client
        logger.info('Reinitializing AI client to reset conversation context');
        
        // Re-initialize the AI client
        await initAI();
        
        console.log('Conversation context has been reset.');
        logger.info('AI client reinitialized, conversation context reset');
      } catch (error) {
        logger.error(`Error resetting conversation context: ${error instanceof Error ? error.message : 'Unknown error'}`);
        throw error;
      }
    },
    examples: [
      'reset'
    ],
    requiresAuth: true
  };

  commandRegistry.register(command);
}

/**
 * Register history command
 */
function registerHistoryCommand(): void {
  logger.debug('Registering history command');

  const command = {
    name: 'history',
    description: 'View conversation history',
    category: 'session',
    async handler(args: Record<string, any>): Promise<void> {
      logger.info('Executing history command');
      
      try {
        // Since we don't have direct access to conversation history through the AI client,
        // we'll need to inform the user that history is not available or implement
        // a conversation history tracking mechanism elsewhere
        
        // This is a placeholder implementation until a proper history tracking system is implemented
        logger.warn('Conversation history feature is not currently implemented');
        console.log('Conversation history is not available in the current version.');
        console.log('This feature will be implemented in a future update.');
        
        // Future implementation could include:
        // - Storing conversations in a local database or file
        // - Retrieving conversations from the API if it supports it
        // - Implementing a session-based history tracker
      } catch (error) {
        logger.error(`Error retrieving conversation history: ${error instanceof Error ? error.message : 'Unknown error'}`);
        throw error;
      }
    },
    args: [
      {
        name: 'limit',
        description: 'Maximum number of history items to display',
        type: ArgType.NUMBER,
        shortFlag: 'l',
        default: '10'
      }
    ],
    examples: [
      'history',
      'history --limit 5'
    ],
    requiresAuth: true
  };

  commandRegistry.register(command);
}

/**
 * Register commands command
 */
function registerCommandsCommand(): void {
  logger.debug('Registering commands command');

  const command = {
    name: 'commands',
    description: 'List all available slash commands',
    category: 'session',
    async handler(): Promise<void> {
      logger.info('Executing commands command');
      
      try {
        // Get all registered commands
        const allCommands = commandRegistry.list()
          .filter(cmd => !cmd.hidden) // Filter out hidden commands
          .sort((a, b) => {
            // Sort first by category, then by name
            if (a.category && b.category) {
              if (a.category !== b.category) {
                return a.category.localeCompare(b.category);
              }
            } else if (a.category) {
              return -1;
            } else if (b.category) {
              return 1;
            }
            return a.name.localeCompare(b.name);
          });
        
        // Group commands by category
        const categories = new Map<string, CommandDef[]>();
        const uncategorizedCommands: CommandDef[] = [];
        
        for (const cmd of allCommands) {
          if (cmd.category) {
            if (!categories.has(cmd.category)) {
              categories.set(cmd.category, []);
            }
            categories.get(cmd.category)!.push(cmd);
          } else {
            uncategorizedCommands.push(cmd);
          }
        }
        
        console.log('Available slash commands:\n');
        
        // Display uncategorized commands first
        if (uncategorizedCommands.length > 0) {
          for (const cmd of uncategorizedCommands) {
            console.log(`/${cmd.name.padEnd(15)} ${cmd.description}`);
          }
          console.log('');
        }
        
        // Display categorized commands
        for (const [category, commands] of categories.entries()) {
          console.log(`${category}:`);
          for (const cmd of commands) {
            console.log(`  /${cmd.name.padEnd(13)} ${cmd.description}`);
          }
          console.log('');
        }
        
        console.log('For more information on a specific command, use:');
        console.log('  /help <command>');
        
      } catch (error) {
        logger.error(`Error listing commands: ${error instanceof Error ? error.message : 'Unknown error'}`);
        throw error;
      }
    },
    examples: [
      'commands'
    ]
  };

  commandRegistry.register(command);
}

/**
 * Register help command
 */
function registerHelpCommand(): void {
  logger.debug('Registering help command');

  const command = {
    name: 'help',
    description: 'Get help for a specific command',
    category: 'session',
    async handler(args: Record<string, any>): Promise<void> {
      logger.info('Executing help command');
      
      const commandName = args.command;
      if (!isNonEmptyString(commandName)) {
        throw createUserError('Command name is required', {
          category: ErrorCategory.VALIDATION,
          resolution: 'Please provide a command name to get help for'
        });
      }
      
      try {
        // Get the command definition
        const command = commandRegistry.get(commandName);
        if (!command) {
          throw createUserError(`Command not found: ${commandName}`, {
            category: ErrorCategory.VALIDATION,
            resolution: 'Please check the command name and try again'
          });
        }
        
        // Display command information
        console.log(`Command: ${command.name}`);
        console.log(`Description: ${command.description}`);
        if (command.category) {
          console.log(`Category: ${command.category}`);
        }
        console.log(`Requires Auth: ${command.requiresAuth ? 'Yes' : 'No'}`);
        
        // Display command usage
        console.log('\nUsage:');
        if (command.args && command.args.length > 0) {
          console.log(`  /${command.name} ${command.args.map(arg => arg.name).join(' ')}`);
        } else {
          console.log(`  /${command.name}`);
        }
        
        // Display command examples
        if (command.examples && command.examples.length > 0) {
          console.log('\nExamples:');
          for (const example of command.examples) {
            console.log(`  /${example}`);
          }
        }
        
        // Display command arguments
        if (command.args && command.args.length > 0) {
          console.log('\nArguments:');
          for (const arg of command.args) {
            console.log(`  ${arg.name}: ${arg.description}`);
          }
        }
        
        logger.info('Help information retrieved');
      } catch (error) {
        logger.error(`Error retrieving help: ${error instanceof Error ? error.message : 'Unknown error'}`);
        throw error;
      }
    },
    args: [
      {
        name: 'command',
        description: 'The command to get help for',
        type: ArgType.STRING,
        position: 0,
        required: true
      }
    ],
    examples: [
      'help login',
      'help ask'
    ]
  };

  commandRegistry.register(command);
} 