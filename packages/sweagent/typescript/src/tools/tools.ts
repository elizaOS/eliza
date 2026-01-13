/**
 * Tools configuration and handler
 * Converted from sweagent/tools/tools.py
 */

import { Bundle } from './bundle';
import { Command } from './commands';
import { AbstractParseFunction, FunctionCallingParser, createParser } from './parsing';
import { generateCommandDocs } from './utils';
import { SWEEnv } from '../environment/swe-env';
import { getLogger, AgentLogger } from '../utils/log';
import { ModelResponse } from '../types';

/**
 * Tool filter configuration
 */
export interface ToolFilterConfig {
  blocklistErrorTemplate: string;
  blocklist: string[];
  blocklistStandalone: string[];
  blockUnlessRegex?: Record<string, string>;
}

/**
 * Default tool filter config
 */
export const defaultToolFilterConfig: ToolFilterConfig = {
  blocklistErrorTemplate: "Operation '{{action}}' is not supported by this environment.",
  blocklist: ['vim', 'vi', 'emacs', 'nano', 'nohup', 'gdb', 'less', 'tail -f', 'python -m venv', 'make'],
  blocklistStandalone: [
    'python',
    'python3',
    'ipython',
    'bash',
    'sh',
    '/bin/bash',
    '/bin/sh',
    'nohup',
    'vi',
    'vim',
    'emacs',
    'nano',
    'su',
  ],
  blockUnlessRegex: {
    git: '^git\\s+(status|diff|log|show)',
  },
};

/**
 * Tool configuration
 */
export interface ToolConfig {
  filter?: ToolFilterConfig;
  bundles?: Bundle[];
  propagateEnvVariables?: string[];
  envVariables?: Record<string, any>;
  registryVariables?: Record<string, any>;
  submitCommand?: string;
  parseFunction?: AbstractParseFunction | string;
  enableBashTool?: boolean;
  formatErrorTemplate?: string;
  commandDocs?: string;
  multiLineCommandEndings?: Record<string, string>;
  submitCommandEndName?: string | null;
  resetCommands?: Array<string | string[]>;
  executionTimeout?: number;
  installTimeout?: number;
  totalExecutionTimeout?: number;
  maxConsecutiveExecutionTimeouts?: number;
  useFunctionCalling?: boolean;
  stateCommands?: string[];
  commands?: Command[];
  tools?: Array<Record<string, any>>;
}

/**
 * Default tool configuration
 */
export const defaultToolConfig: ToolConfig = {
  filter: defaultToolFilterConfig,
  bundles: [],
  propagateEnvVariables: [],
  envVariables: {
    PAGER: 'cat',
    MANPAGER: 'cat',
    LESS: '-R',
    PIP_PROGRESS_BAR: 'off',
    TQDM_DISABLE: '1',
    GIT_PAGER: 'cat',
  },
  registryVariables: {},
  submitCommand: 'submit',
  parseFunction: new FunctionCallingParser(),
  enableBashTool: true,
  formatErrorTemplate: '',
  commandDocs: '',
  multiLineCommandEndings: {},
  submitCommandEndName: null,
  resetCommands: [],
  executionTimeout: 30,
  installTimeout: 300,
  totalExecutionTimeout: 1800,
  maxConsecutiveExecutionTimeouts: 3,
};

/**
 * Tool handler
 */
export class ToolHandler {
  config: ToolConfig;
  private parser: AbstractParseFunction;
  private multilineCommands: Map<string, string> = new Map();
  private logger: AgentLogger;

  constructor(config: ToolConfig = {}) {
    this.config = { ...defaultToolConfig, ...config };
    this.logger = getLogger('tools');

    // Set up parser
    if (typeof this.config.parseFunction === 'string') {
      this.parser = createParser(this.config.parseFunction);
    } else if (this.config.parseFunction) {
      this.parser = this.config.parseFunction;
    } else {
      this.parser = new FunctionCallingParser();
    }

    // Set up commands
    if (!this.config.commands) {
      this.config.commands = this.getCommandsFromBundles();
    }

    // Generate command docs if not provided
    if (!this.config.commandDocs) {
      this.config.commandDocs = generateCommandDocs(this.config.commands, [], {});
    }

    // Set format error template if not provided
    if (!this.config.formatErrorTemplate) {
      this.config.formatErrorTemplate = this.parser.formatErrorTemplate;
    }

    // Build multiline command map
    for (const cmd of this.config.commands) {
      if (cmd.endName) {
        this.multilineCommands.set(cmd.name, cmd.endName);
      }
    }
  }

  private getCommandsFromBundles(): Command[] {
    const commands: Command[] = [];

    if (this.config.bundles) {
      for (const bundle of this.config.bundles) {
        commands.push(...bundle.commands);
      }
    }

    // Add bash command if enabled
    if (this.config.enableBashTool) {
      commands.push(
        new Command({
          name: 'bash',
          docstring: 'Execute bash commands',
          arguments: [
            {
              name: 'command',
              type: 'string',
              description: 'The bash command to execute',
              required: true,
              argumentFormat: '{{value}}',
            },
          ],
        }),
      );
    }

    return commands;
  }

  static fromConfig(config: ToolConfig): ToolHandler {
    return new ToolHandler(config);
  }

  async install(env: SWEEnv): Promise<void> {
    this.logger.info('Installing tools...');

    // Upload bundles
    if (this.config.bundles) {
      for (const bundle of this.config.bundles) {
        await this.uploadBundle(env, bundle);
      }
    }

    // Set environment variables
    if (this.config.envVariables) {
      await env.setEnvVariables(this.config.envVariables);
    }

    // Execute reset commands
    if (this.config.resetCommands) {
      for (const cmd of this.config.resetCommands) {
        const command = Array.isArray(cmd) ? cmd.join(' ') : cmd;
        await env.communicate(command, this.config.installTimeout);
      }
    }

    this.logger.info('Tools installed successfully');
  }

  private async uploadBundle(_env: SWEEnv, bundle: Bundle): Promise<void> {
    // Implementation would upload bundle files to environment
    this.logger.info(`Uploading bundle from ${bundle.path}`);
    // This would need actual implementation based on environment
  }

  async reset(env: SWEEnv): Promise<void> {
    if (this.config.resetCommands) {
      for (const cmd of this.config.resetCommands) {
        const command = Array.isArray(cmd) ? cmd.join(' ') : cmd;
        await env.communicate(command, this.config.executionTimeout);
      }
    }
  }

  async getState(env: SWEEnv): Promise<Record<string, string>> {
    const state: Record<string, string> = {};

    // Execute state commands
    if (this.config.stateCommands) {
      for (const cmd of this.config.stateCommands) {
        try {
          const result = await env.communicate(cmd, 5);
          const key = cmd.split(' ')[0]; // Simple key extraction
          state[key] = result;
        } catch (error) {
          this.logger.warning(`Failed to execute state command: ${cmd}`);
        }
      }
    }

    // Execute bundle state commands
    if (this.config.bundles) {
      for (const bundle of this.config.bundles) {
        if (bundle.stateCommand) {
          try {
            const result = await env.communicate(bundle.stateCommand, 5);
            state['bundle_state'] = result;
          } catch (error) {
            this.logger.warning('Failed to execute bundle state command');
          }
        }
      }
    }

    return state;
  }

  shouldBlockAction(action: string): boolean {
    if (!this.config.filter) {
      return false;
    }

    const actionLower = action.toLowerCase();

    // Check blocklist
    for (const blocked of this.config.filter.blocklist) {
      if (actionLower.startsWith(blocked.toLowerCase())) {
        return true;
      }
    }

    // Check standalone blocklist
    const firstWord = action.split(/\s+/)[0];
    if (this.config.filter.blocklistStandalone.includes(firstWord)) {
      return true;
    }

    // Check regex exceptions
    if (this.config.filter.blockUnlessRegex) {
      for (const [cmd, pattern] of Object.entries(this.config.filter.blockUnlessRegex)) {
        if (actionLower.startsWith(cmd)) {
          const regex = new RegExp(pattern);
          if (!regex.test(action)) {
            return true;
          }
        }
      }
    }

    return false;
  }

  checkForSubmissionCmd(observation: string): boolean {
    const submitCommand = this.config.submitCommand || 'submit';
    return observation.includes(`<${submitCommand}>`) || observation.includes(`</${submitCommand}>`);
  }

  parseActions(output: string | ModelResponse): [string, string] {
    const modelResponse: ModelResponse = typeof output === 'string' ? { message: output } : output;
    return this.parser.parse(modelResponse, this.config.commands || [], false);
  }

  guardMultilineInput(action: string): string {
    // Check for multiline commands
    for (const [cmdName, endName] of this.multilineCommands) {
      if (action.startsWith(cmdName)) {
        if (!action.includes(endName)) {
          this.logger.warning(`Multiline command ${cmdName} missing end marker ${endName}`);
        }
      }
    }
    return action;
  }
}
