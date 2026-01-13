/**
 * Repository management
 * Converted from sweagent/environment/repo.py
 */

import { z } from 'zod';
import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';

import { parseGhRepoUrl } from '../utils/github';
import { getLogger } from '../utils/log';
import { AbstractDeployment } from './deployment';
import { Command, UploadRequest } from './runtime';

const logger = getLogger('repo');

/**
 * Repository protocol interface
 */
export interface Repo {
  baseCommit: string;
  repoName: string;
  copy(deployment: AbstractDeployment): Promise<void>;
  getResetCommands(): string[];
}

/**
 * Get git reset commands
 */
function getGitResetCommands(baseCommit: string): string[] {
  return [
    'git fetch',
    'git status',
    'git restore .',
    'git reset --hard',
    `git checkout ${baseCommit}`,
    'git clean -fdq',
  ];
}

/**
 * Pre-existing repository configuration
 */
export const PreExistingRepoConfigSchema = z.object({
  repoName: z.string().describe('The repo name (must be at root of deployment)'),
  baseCommit: z.string().default('HEAD'),
  type: z.literal('preexisting'),
  reset: z.boolean().default(true),
});

export type PreExistingRepoConfig = z.infer<typeof PreExistingRepoConfigSchema>;

export class PreExistingRepo implements Repo {
  repoName: string;
  baseCommit: string;
  reset: boolean;

  constructor(config: PreExistingRepoConfig) {
    this.repoName = config.repoName;
    this.baseCommit = config.baseCommit;
    this.reset = config.reset;
  }

  async copy(_deployment: AbstractDeployment): Promise<void> {
    logger.info(`Using pre-existing repository ${this.repoName}`);
  }

  getResetCommands(): string[] {
    if (!this.reset) {
      return [];
    }
    return getGitResetCommands(this.baseCommit);
  }
}

/**
 * Local repository configuration
 */
export const LocalRepoConfigSchema = z.object({
  path: z.string().transform((p) => path.resolve(p)),
  baseCommit: z.string().default('HEAD'),
  type: z.literal('local'),
});

export type LocalRepoConfig = z.infer<typeof LocalRepoConfigSchema>;

export class LocalRepo implements Repo {
  path: string;
  baseCommit: string;
  repoName: string;

  constructor(config: LocalRepoConfig) {
    this.path = config.path;
    this.baseCommit = config.baseCommit;
    this.repoName = path.basename(this.path).replace(' ', '-').replace("'", ''); // Match Python sanitization
  }

  private checkValidRepo(): void {
    if (!fs.existsSync(this.path)) {
      throw new Error(`Could not find git repository at path=${this.path}`);
    }

    const gitPath = path.join(this.path, '.git');
    if (!fs.existsSync(gitPath)) {
      throw new Error(`${this.path} is not a git repository`);
    }

    // Check if repo is dirty (has uncommitted changes)
    // Note: This is a simplified check - Python uses GitPython for this
    const status = execSync('git status --porcelain', { cwd: this.path }).toString();
    if (status.trim() && !process.env.PYTEST_CURRENT_TEST) {
      throw new Error(`Local git repository ${this.path} is dirty. Please commit or stash changes.`);
    }
  }

  async copy(deployment: AbstractDeployment): Promise<void> {
    this.checkValidRepo(); // Check valid repo first

    logger.info(`Copying local repository from ${this.path}`);

    // Upload repository to deployment
    await deployment.runtime.upload({
      sourcePath: this.path,
      targetPath: `/${this.repoName}`,
    } as UploadRequest);

    // Change permissions
    const result = await deployment.runtime.execute({
      command: `chown -R root:root ${this.repoName}`,
      shell: true,
    } as Command);

    if (result.exitCode !== 0) {
      const msg = `Failed to change permissions on copied repository (exit code: ${result.exitCode}, stdout: ${result.stdout}, stderr: ${result.stderr})`;
      throw new Error(msg);
    }
  }

  getResetCommands(): string[] {
    return getGitResetCommands(this.baseCommit);
  }
}

/**
 * GitHub repository configuration
 */
export const GithubRepoConfigSchema = z.object({
  githubUrl: z.string(),
  baseCommit: z.string().default('HEAD'),
  cloneTimeout: z.number().default(500),
  type: z.literal('github'),
});

export type GithubRepoConfig = z.infer<typeof GithubRepoConfigSchema>;

export class GithubRepo implements Repo {
  githubUrl: string;
  baseCommit: string;
  cloneTimeout: number;
  repoName: string;
  constructor(config: GithubRepoConfig) {
    // Handle short form github URLs (org/repo)
    if (config.githubUrl.split('/').length === 2 && !config.githubUrl.includes('://')) {
      this.githubUrl = `https://github.com/${config.githubUrl}`;
    } else {
      this.githubUrl = config.githubUrl;
    }

    this.baseCommit = config.baseCommit;
    this.cloneTimeout = config.cloneTimeout;

    const parsed = parseGhRepoUrl(this.githubUrl);
    this.repoName = `${parsed.owner}__${parsed.repo}`;
  }

  private getUrlWithToken(token: string): string {
    if (!token) {
      return this.githubUrl;
    }

    // Check if @ already in URL
    if (this.githubUrl.includes('@')) {
      logger.warn('Cannot prepend token to URL. "@" found in URL');
      return this.githubUrl;
    }

    // Insert token into URL for authentication
    const urlParts = this.githubUrl.split('://');
    if (urlParts.length === 2) {
      return `https://${token}@${urlParts[1]}`;
    }

    return this.githubUrl;
  }

  async copy(deployment: AbstractDeployment): Promise<void> {
    logger.info(`Cloning GitHub repository ${this.githubUrl}`);

    const token = process.env.GITHUB_TOKEN || '';
    const url = this.getUrlWithToken(token);

    // Execute git commands directly in the deployment (matches Python implementation)
    const commands = [
      `mkdir /${this.repoName}`,
      `cd /${this.repoName}`,
      'git init',
      `git remote add origin ${url}`,
      `git fetch --depth 1 origin ${this.baseCommit}`,
      'git checkout FETCH_HEAD',
      'cd ..',
    ];

    await deployment.runtime.execute({
      command: commands.join(' && '),
      timeout: this.cloneTimeout,
      shell: true,
      check: true,
    } as Command);
  }

  getResetCommands(): string[] {
    return getGitResetCommands(this.baseCommit);
  }
}

/**
 * Union type for all repo configurations
 */
export const RepoConfigSchema = z.discriminatedUnion('type', [
  PreExistingRepoConfigSchema,
  LocalRepoConfigSchema,
  GithubRepoConfigSchema,
]);

export type RepoConfig = z.infer<typeof RepoConfigSchema>;

/**
 * Factory function to create repo from simplified input
 */
export function repoFromSimplifiedInput(
  input: string,
  baseCommit: string = 'HEAD',
  type: 'local' | 'github' | 'preexisting' | 'auto' = 'auto',
): Repo {
  if (type === 'auto') {
    // Auto-detect type
    if (input.includes('github.com')) {
      type = 'github';
    } else if (fs.existsSync(input)) {
      type = 'local';
    } else {
      type = 'preexisting';
    }
  }

  switch (type) {
    case 'github':
      return new GithubRepo({ githubUrl: input, baseCommit, type: 'github', cloneTimeout: 500 });
    case 'local':
      return new LocalRepo({ path: input, baseCommit, type: 'local' });
    case 'preexisting':
      return new PreExistingRepo({ repoName: input, baseCommit, type: 'preexisting', reset: true });
    default:
      throw new Error(`Unknown repo type: ${type}`);
  }
}
