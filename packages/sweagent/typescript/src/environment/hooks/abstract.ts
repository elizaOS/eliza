/**
 * Environment hooks
 * Converted from sweagent/environment/hooks/abstract.py
 */

import { Repo, RepoConfig } from '../repo';

// Environment interface for hooks
interface EnvironmentInstance {
  deployment?: unknown;
  repo?: Repo | null;
  [key: string]: unknown;
}

/**
 * Abstract environment hook interface
 */
export abstract class EnvHook {
  /**
   * Called when the environment is initialized
   */
  onInit(_env: EnvironmentInstance): void {
    // Default implementation - do nothing
  }

  /**
   * Called when repository copying starts
   */
  onCopyRepoStarted(_repo: Repo | RepoConfig): void {
    // Default implementation - do nothing
  }

  /**
   * Called when deployment starts
   */
  onStartDeployment(): void {
    // Default implementation - do nothing
  }

  /**
   * Called when environment installation starts
   */
  onInstallEnvStarted(): void {
    // Default implementation - do nothing
  }

  /**
   * Called when the environment is closing
   */
  onClose(): void {
    // Default implementation - do nothing
  }

  /**
   * Called when the environment startup is complete
   */
  onEnvironmentStartup(): void {
    // Default implementation - do nothing
  }
}

/**
 * Combined environment hooks - allows multiple hooks to be registered
 */
export class CombinedEnvHooks extends EnvHook {
  private hooks: EnvHook[] = [];

  addHook(hook: EnvHook): void {
    this.hooks.push(hook);
  }

  onInit(env: EnvironmentInstance): void {
    for (const hook of this.hooks) {
      try {
        hook.onInit(env);
      } catch (error) {
        console.error('Hook error in onInit:', error);
        // Continue with other hooks
      }
    }
  }

  onCopyRepoStarted(repo: Repo | RepoConfig): void {
    for (const hook of this.hooks) {
      try {
        hook.onCopyRepoStarted(repo);
      } catch (error) {
        console.error('Hook error in onCopyRepoStarted:', error);
        // Continue with other hooks
      }
    }
  }

  onStartDeployment(): void {
    for (const hook of this.hooks) {
      try {
        hook.onStartDeployment();
      } catch (error) {
        console.error('Hook error in onStartDeployment:', error);
        // Continue with other hooks
      }
    }
  }

  onInstallEnvStarted(): void {
    for (const hook of this.hooks) {
      try {
        hook.onInstallEnvStarted();
      } catch (error) {
        console.error('Hook error in onInstallEnvStarted:', error);
        // Continue with other hooks
      }
    }
  }

  onClose(): void {
    for (const hook of this.hooks) {
      try {
        hook.onClose();
      } catch (error) {
        console.error('Hook error in onClose:', error);
        // Continue with other hooks
      }
    }
  }

  onEnvironmentStartup(): void {
    for (const hook of this.hooks) {
      try {
        hook.onEnvironmentStartup();
      } catch (error) {
        console.error('Hook error in onEnvironmentStartup:', error);
        // Continue with other hooks
      }
    }
  }
}
