/**
 * Status environment hook
 * Converted from sweagent/environment/hooks/status.py
 */

import { EnvHook } from './abstract';
import { Repo, RepoConfig } from '../repo';

/**
 * Status update callback type
 */
export type StatusCallback = (id: string, message: string) => void;

/**
 * Environment hook that updates status messages
 */
export class SetStatusEnvironmentHook extends EnvHook {
  private callable: StatusCallback;
  private id: string;

  constructor(id: string, callable: StatusCallback) {
    super();
    this.id = id;
    this.callable = callable;
  }

  private update(message: string): void {
    this.callable(this.id, message);
  }

  onCopyRepoStarted(repo: Repo | RepoConfig): void {
    const repoName = 'repoName' in repo ? repo.repoName : 'unknown';
    this.update(`Copying repo ${repoName}`);
  }

  onStartDeployment(): void {
    this.update('Starting deployment');
  }

  onInstallEnvStarted(): void {
    this.update('Installing environment');
  }

  onEnvironmentStartup(): void {
    this.update('Starting environment');
  }

  onClose(): void {
    this.update('Closing environment');
  }
}
