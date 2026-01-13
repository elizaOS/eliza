/**
 * Main environment class
 * Converted from sweagent/environment/swe_env.py
 */

import { z } from 'zod';
import { getLogger } from '../utils/log';
import { Repo, RepoConfig, RepoConfigSchema, PreExistingRepo, LocalRepo, GithubRepo } from './repo';
import { AbstractDeployment, DockerDeployment, DeploymentConfig } from './deployment';
import { EnvHook, CombinedEnvHooks } from './hooks/abstract';
import {
  BashAction,
  BashInterruptAction,
  CreateBashSessionRequest,
  ReadFileRequest,
  WriteFileRequest,
  Command,
} from './runtime';
import { AgentEnvironment } from '../agent/agents';

/**
 * Environment configuration
 */
export const EnvironmentConfigSchema = z.object({
  deployment: z
    .custom<DeploymentConfig>()
    .default(() => ({ type: 'docker', image: 'python:3.11' }) as DeploymentConfig),
  repo: RepoConfigSchema.nullable().optional(),
  postStartupCommands: z.array(z.string()).default([]),
  postStartupCommandTimeout: z.number().default(500),
  name: z.string().default('main'),
});

export type EnvironmentConfig = z.infer<typeof EnvironmentConfigSchema>;

/**
 * Main SWE environment class
 */
export class SWEEnv implements AgentEnvironment {
  public deployment: AbstractDeployment; // Made public to match Python
  public repo: Repo | undefined; // Changed from null to undefined to match AgentEnvironment interface
  private _postStartupCommands: string[]; // Private with underscore to match Python
  public postStartupCommandTimeout: number; // Made public to match Python
  private _chook: CombinedEnvHooks; // Private with underscore to match Python
  public name: string; // Made public to match Python
  public cleanMultiLineFunctions: (x: string) => string = (x) => x;
  public logger = getLogger('swe-env'); // Added logger property to match Python
  // @ts-ignore - used in start() and reset() methods
  private _started: boolean = false; // Track if environment has been started

  constructor(config: {
    deployment: AbstractDeployment;
    repo?: Repo | RepoConfig | null;
    postStartupCommands: string[];
    postStartupCommandTimeout?: number;
    hooks?: EnvHook[] | null;
    name?: string;
  }) {
    this.deployment = config.deployment;
    this.repo = this.resolveRepo(config.repo);
    this._postStartupCommands = config.postStartupCommands;
    this.postStartupCommandTimeout = config.postStartupCommandTimeout || 500;
    this.name = config.name || 'main';

    this._chook = new CombinedEnvHooks();
    if (config.hooks) {
      for (const hook of config.hooks) {
        this.addHook(hook);
      }
    }
  }

  private resolveRepo(repo?: Repo | RepoConfig | null): Repo | undefined {
    if (!repo) {
      return undefined;
    }

    // If it's already a Repo instance, return it
    if ('copy' in repo && typeof repo.copy === 'function') {
      return repo as Repo;
    }

    // Otherwise, create a Repo from config
    const config = repo as RepoConfig;
    switch (config.type) {
      case 'preexisting':
        return new PreExistingRepo(config);
      case 'local':
        return new LocalRepo(config);
      case 'github':
        return new GithubRepo(config);
      default:
        throw new Error(`Unknown repo type: ${(config as RepoConfig).type}`);
    }
  }

  static fromConfig(config: EnvironmentConfig): SWEEnv {
    // Create deployment from config
    const deployment = new DockerDeployment(config.deployment);

    return new SWEEnv({
      deployment,
      repo: config.repo || null,
      postStartupCommands: config.postStartupCommands,
      postStartupCommandTimeout: config.postStartupCommandTimeout,
      name: config.name,
    });
  }

  addHook(hook: EnvHook): void {
    // Create a compatible EnvironmentInstance object
    const envInstance = {
      deployment: this.deployment,
      repo: this.repo,
      name: this.name,
      postStartupCommandTimeout: this.postStartupCommandTimeout,
    } as any;
    hook.onInit(envInstance);
    this._chook.addHook(hook);
  }

  /**
   * Start the environment and reset it to a clean state
   */
  async start(): Promise<void> {
    if (this._started) {
      return; // Already started
    }

    this.logger.info('Starting environment');

    // Initialize deployment first (matches Python _init_deployment)
    await this.initDeployment();

    // Reset environment to clean state
    await this.reset();

    // Run post-startup commands
    for (const command of this._postStartupCommands) {
      await this.communicate(command, this.postStartupCommandTimeout, {
        check: 'raise',
      });
    }

    this._started = true;
  }

  private async copyRepo(): Promise<void> {
    if (!this.repo) {
      return;
    }

    // Check if repo already exists in container
    const folders = (await this.communicate('ls', 25, { check: 'raise' })).split('\n');
    if (folders.includes(this.repo.repoName)) {
      return;
    }

    this.logger.info(`Copying repository ${this.repo.repoName}`);
    this._chook.onCopyRepoStarted(this.repo);

    await this.repo.copy(this.deployment);
  }

  private async resetRepository(): Promise<void> {
    if (!this.repo) {
      return;
    }

    this.logger.debug(`Resetting repository ${this.repo.repoName} to commit ${this.repo.baseCommit}`);

    const startupCommands = [`cd /${this.repo.repoName}`, 'export ROOT=$(pwd -P)', ...this.repo.getResetCommands()];

    await this.communicate(
      startupCommands.join(' && '),
      120, // Sometimes slow due to index rebuilding
      {
        check: 'raise',
        errorMsg: 'Failed to clean repository',
      },
    );
  }

  private async initDeployment(): Promise<void> {
    this._chook.onStartDeployment();

    await this.deployment.start();

    // Create bash session with startup source
    await this.deployment.runtime.createSession({
      startupSource: ['/root/.bashrc'],
      startupTimeout: 10,
    } as CreateBashSessionRequest);

    // Set default environment variables (matching Python)
    await this.setEnvVariables({
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      PIP_PROGRESS_BAR: 'off',
      PAGER: 'cat',
    });

    this.logger.info('Environment Initialized');
  }

  /**
   * Execute a command in the running shell session
   */
  async communicate(
    input: string,
    timeout: number = 25,
    options: {
      check?: 'warn' | 'ignore' | 'raise';
      errorMsg?: string;
    } = {},
  ): Promise<string> {
    const { check = 'ignore', errorMsg = 'Command failed' } = options;

    this.logger.debug(`Input:\n${input}`);

    // Convert check parameter to match BashAction interface
    const rexCheck = check === 'raise' || check === 'warn' ? 'silent' : 'ignore';
    const result = await this.deployment.runtime.runInSession({
      command: input,
      timeout: timeout,
      check: rexCheck,
    } as BashAction);

    const output = result.output;
    this.logger.debug(`Output:\n${output}`);

    if (check !== 'ignore' && result.exitCode !== 0) {
      this.logger.error(`${errorMsg}:\n${output}`);
      const msg = `Command '${input}' failed (exit_code=${result.exitCode}): ${errorMsg}`;
      this.logger.error(msg);

      if (check === 'raise') {
        await this.close();
        throw new Error(msg);
      }
    }

    return output;
  }

  /**
   * Read a file from the environment
   */
  async readFile(filePath: string, encoding?: string, errors?: string): Promise<string> {
    const response = await this.deployment.runtime.readFile({
      path: filePath,
      encoding: encoding,
      errors: errors,
    } as ReadFileRequest);

    return response.content;
  }

  /**
   * Write a file to the environment
   */
  async writeFile(filePath: string, content: string): Promise<void> {
    await this.deployment.runtime.writeFile({
      path: filePath,
      content: content,
    } as WriteFileRequest);
  }

  /**
   * Set environment variables
   */
  async setEnvVariables(envVars: Record<string, string>): Promise<void> {
    for (const [key, value] of Object.entries(envVars)) {
      await this.communicate(`export ${key}="${value}"`, 5);
    }
  }

  /**
   * Execute a command independent of the session (as subprocess)
   */
  async executeCommand(
    command: string,
    options: {
      shell?: boolean;
      check?: boolean;
      env?: Record<string, string>;
      cwd?: string;
    } = {},
  ): Promise<void> {
    const { shell = true, check = false, env, cwd } = options;

    await this.deployment.runtime.execute({
      command: command,
      shell: shell,
      check: check,
      env: env,
      cwd: cwd,
    } as Command);
  }

  /**
   * Interrupt the current session
   */
  async interruptSession(): Promise<void> {
    this.logger.info('Interrupting session');
    await this.deployment.runtime.runInSession({
      type: 'interrupt',
    } as BashInterruptAction);
  }

  /**
   * Helper methods for AgentEnvironment compatibility
   */
  getCwd(): string {
    // This would need actual implementation to track current directory
    return '/';
  }

  isAlive(): boolean {
    // Check if runtime is active
    return this._started;
  }

  /**
   * Check if the environment has been started
   */
  isStarted(): boolean {
    return this._started;
  }

  getOpenFiles?(): string[] {
    // Optional method - return empty array for now
    return [];
  }

  getGitStatus?(): string {
    // Optional method - return empty string for now
    return '';
  }

  /**
   * Reset the environment to a clean state
   * Gets called by start(), but can also be called independently
   */
  async reset(): Promise<void> {
    // Change to root directory
    await this.communicate('cd /', 25, { check: 'raise' });

    // Copy repository if needed
    await this.copyRepo();

    // Reset repository to base commit
    await this.resetRepository();

    // Notify hooks
    this._chook.onEnvironmentStartup();
  }

  /**
   * Hard reset - completely restart the environment and deployment
   */
  async hardReset(): Promise<void> {
    this.logger.info('Hard resetting environment');

    await this.close();
    await this.start();
  }

  /**
   * Close the environment
   */
  async close(): Promise<void> {
    this.logger.info('Beginning environment shutdown...');

    await this.deployment.stop();
    this._chook.onClose();
    this._started = false;
  }
}
