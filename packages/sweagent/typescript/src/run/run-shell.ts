/**
 * Run shell mode
 * Converted from sweagent/run/run_shell.py
 */

import * as readline from 'readline';
import { DefaultAgent, AbstractAgent } from '../agent/agents';
import { SWEEnv } from '../environment/swe-env';
import { ProblemStatement, ProblemStatementConfig } from '../agent/problem-statement';
import { AbstractAgentHook } from '../agent/hooks';
import { getLogger, AgentLogger } from '../utils/log';

/**
 * Run shell - interactive shell mode
 */
export class RunShell {
  private env: SWEEnv;
  private agent: AbstractAgent;
  private problemStatement: ProblemStatement | ProblemStatementConfig;
  private outputDir: string;
  private hooks: AbstractAgentHook[];
  private logger: AgentLogger;
  private rl: readline.Interface;

  constructor(config: {
    env: SWEEnv;
    agent: AbstractAgent;
    problemStatement: ProblemStatement | ProblemStatementConfig;
    outputDir?: string;
    hooks?: AbstractAgentHook[];
  }) {
    this.env = config.env;
    this.agent = config.agent;
    this.problemStatement = config.problemStatement;
    this.outputDir = config.outputDir || '.';
    this.hooks = config.hooks || [];
    this.logger = getLogger('run-shell', '🐚');

    // Setup readline interface
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: '> ',
    });

    // Add hooks to agent
    for (const hook of this.hooks) {
      this.agent.addHook(hook);
    }
  }

  addHook(hook: AbstractAgentHook): void {
    this.hooks.push(hook);
    this.agent.addHook(hook);
  }

  async run(): Promise<void> {
    this.logger.info('Starting shell mode');
    this.logger.info('Type commands to execute, or "exit" to quit');

    // Start environment
    await this.env.start();

    try {
      // Setup agent (DefaultAgent has setup method)
      if (this.agent instanceof DefaultAgent) {
        await this.agent.setup(this.env, this.problemStatement, this.outputDir);
      }

      // Interactive loop
      await this.interactiveLoop();
    } finally {
      // Clean up
      this.rl.close();
      await this.env.close();
    }
  }

  private async interactiveLoop(): Promise<void> {
    return new Promise((resolve) => {
      this.rl.prompt();

      this.rl.on('line', async (input) => {
        const command = input.trim();

        if (command === 'exit' || command === 'quit') {
          this.logger.info('Exiting shell mode');
          resolve();
          return;
        }

        if (command === 'help') {
          this.printHelp();
          this.rl.prompt();
          return;
        }

        if (command === 'status') {
          await this.printStatus();
          this.rl.prompt();
          return;
        }

        if (command === 'save') {
          this.saveState();
          this.rl.prompt();
          return;
        }

        if (command) {
          try {
            // Execute command through environment
            const result = await this.env.communicate(command);
            console.log(result);
          } catch (error) {
            this.logger.error(`Error executing command: ${error}`);
          }
        }

        this.rl.prompt();
      });

      this.rl.on('close', () => {
        resolve();
      });
    });
  }

  private printHelp(): void {
    console.log('\nShell Mode Commands:');
    console.log('  exit/quit - Exit shell mode');
    console.log('  help      - Show this help message');
    console.log('  status    - Show current environment status');
    console.log('  save      - Save current state');
    console.log('\nOr enter any bash command to execute in the environment\n');
  }

  private async printStatus(): Promise<void> {
    console.log('\nEnvironment Status:');
    console.log(`  Name: ${this.env.name}`);

    if (this.env.repo) {
      console.log(`  Repository: ${this.env.repo.repoName}`);
      console.log(`  Base commit: ${this.env.repo.baseCommit}`);
    }

    // Get current working directory
    try {
      const pwd = await this.env.communicate('pwd');
      console.log(`  Current directory: ${pwd.trim()}`);
    } catch {
      // Ignore errors
    }

    console.log('');
  }

  private saveState(): void {
    try {
      if (this.agent instanceof DefaultAgent) {
        this.agent.saveTrajectory();
        this.logger.info('State saved to trajectory file');
      } else {
        this.logger.warning('Cannot save state for this agent type');
      }
    } catch (error) {
      this.logger.error(`Error saving state: ${error}`);
    }
  }
}

/**
 * Run a shell session from configuration options
 * @param _options - Configuration options for the shell session
 * @param _options.repo - Repository URL or path
 * @param _options.config - Configuration file path
 * @param _options.problemStatement - Problem statement to solve
 */
export async function runShellFromConfig(_options: {
  repo?: string;
  config?: string;
  problemStatement?: string;
}): Promise<void> {
  // This function appears to be incomplete/incorrectly implemented
  // For now, throw an error indicating it needs proper implementation
  throw new Error(
    'runShellFromConfig is not yet properly implemented. Use RunShell directly with proper env and agent instances.',
  );

  // TODO: Properly implement this function by:
  // 1. Loading config from _options.config
  // 2. Creating SWEEnv from config
  // 3. Creating Agent from config
  // 4. Creating ProblemStatement from _options.problemStatement
  // 5. Creating RunShell with proper parameters
}
