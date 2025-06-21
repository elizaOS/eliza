import { logger } from '@elizaos/core';
import * as fs from 'fs-extra';
import * as path from 'node:path';
import simpleGit, { type SimpleGit } from 'simple-git';
import { BRANCH_NAME } from '../config.js';

/**
 * Repository management for Git operations and input handling
 * ENHANCED: Added robust error handling, timeouts, and recovery mechanisms
 */
export class RepositoryManager {
  private git: SimpleGit;
  private repoPath: string | null = null;
  private isGitHub = false;
  private originalPath: string | null = null;

  constructor() {
    // Configure git with better error handling
    this.git = simpleGit({
      maxConcurrentProcesses: 1, // Prevent concurrent git operations
    });
  }

  /**
   * Handle input (clone if GitHub URL, validate if folder) with enhanced error handling
   */
  async handleInput(input: string): Promise<void> {
    try {
      if (input.startsWith('https://github.com/')) {
        await this.handleGitHubInput(input);
      } else {
        await this.handleLocalInput(input);
      }
    } catch (error) {
      logger.error(`Failed to handle input: ${input}`, error);
      throw new Error(`Repository setup failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Handle GitHub URL input with robust cloning logic
   */
  private async handleGitHubInput(input: string): Promise<void> {
    this.isGitHub = true;
    this.originalPath = input;
    
    const repoName = input.split('/').slice(-2).join('/').replace('.git', '');
    const repoFolder = repoName.split('/')[1] || repoName;
    this.repoPath = path.join(process.cwd(), 'cloned_repos', repoFolder);
    
    // Ensure parent directory exists
    await fs.ensureDir(path.dirname(this.repoPath));

    try {
      if (await fs.pathExists(this.repoPath)) {
        logger.info(`Repository already exists at ${this.repoPath}, attempting to update...`);
        await this.handleExistingRepository(input);
      } else {
        logger.info(`Cloning repository to ${this.repoPath}...`);
        await this.cloneRepository(input);
      }

      // Switch to appropriate branch with enhanced detection
      await this.switchToDefaultBranch();
      
    } catch (error) {
      // If anything fails, clean up and retry with fresh clone
      logger.warn(`Repository operation failed, attempting clean clone...`, error);
      await this.cleanupAndRetryClone(input);
    }
  }

  /**
   * Handle existing repository with fetch and fallback to clean clone
   */
  private async handleExistingRepository(input: string): Promise<void> {
    if (!this.repoPath) {
      throw new Error('Repository path not set');
    }
    
    this.git = simpleGit(this.repoPath);
    
    try {
      // Try to fetch updates
      await this.git.fetch(['--all']);
      logger.info('✅ Repository updated successfully');
    } catch (fetchError) {
      logger.warn('Failed to fetch updates, performing clean clone...', fetchError);
      // Remove existing directory and clone fresh
      await fs.remove(this.repoPath);
      await this.cloneRepository(input);
    }
  }

  /**
   * Clone repository with retry logic
   */
  private async cloneRepository(input: string): Promise<void> {
    if (!this.repoPath) {
      throw new Error('Repository path not set');
    }
    
    const maxRetries = 3;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await simpleGit().clone(input, this.repoPath, ['--depth', '1']);
        this.git = simpleGit(this.repoPath);
        logger.info('✅ Repository cloned successfully (attempt ' + attempt + ')');
        return;
      } catch (error) {
        lastError = error as Error;
        logger.warn('Clone attempt ' + attempt + ' failed:', error);
        
        if (attempt < maxRetries) {
          // Clean up failed attempt and wait before retry
          if (await fs.pathExists(this.repoPath)) {
            await fs.remove(this.repoPath);
          }
          await this.delay(2000 * attempt); // Exponential backoff
        }
      }
    }

    throw new Error('Failed to clone repository after ' + maxRetries + ' attempts: ' + (lastError?.message || 'Unknown error'));
  }

  /**
   * Cleanup and retry clone as last resort
   */
  private async cleanupAndRetryClone(input: string): Promise<void> {
    if (!this.repoPath) {
      throw new Error('Repository path not set');
    }
    
    try {
      if (await fs.pathExists(this.repoPath)) {
        await fs.remove(this.repoPath);
      }
      await this.cloneRepository(input);
      await this.switchToDefaultBranch();
    } catch (error) {
      throw new Error('Complete repository setup failed: ' + (error instanceof Error ? error.message : 'Unknown error'));
    }
  }

  /**
   * Switch to default branch with enhanced detection
   */
  private async switchToDefaultBranch(): Promise<void> {
    try {
      const branches = await this.git.branch(['--all']);
      const currentBranch = branches.current;
      
      // Priority order: 0.x (V1 branch) > main > master
      const branchPriority = ['0.x', 'main', 'master'];
      
      for (const targetBranch of branchPriority) {
        const localExists = branches.all.includes(targetBranch);
        const remoteExists = branches.all.includes('remotes/origin/' + targetBranch);
        
        if (localExists || remoteExists) {
          if (currentBranch !== targetBranch) {
            logger.info('Switching to branch: ' + targetBranch);
            try {
              if (localExists) {
                await this.git.checkout(targetBranch);
              } else {
                await this.git.checkout(['-b', targetBranch, 'origin/' + targetBranch]);
              }
              logger.info('✅ Switched to branch: ' + targetBranch);
            } catch (checkoutError) {
              logger.warn('Failed to switch to ' + targetBranch + ':', checkoutError);
              continue; // Try next branch
            }
          }
          return; // Successfully on target branch
        }
      }
      
      logger.info('Using current branch: ' + currentBranch);
    } catch (error) {
      logger.warn('Branch detection failed, using current branch:', error);
      // Don't fail the entire process for branch switching issues
    }
  }

  /**
   * Handle local input with validation
   */
  private async handleLocalInput(input: string): Promise<void> {
    this.repoPath = path.resolve(input);
    
    if (!(await fs.pathExists(this.repoPath))) {
      throw new Error('Folder not found: ' + this.repoPath);
    }

    // Verify it's a git repository
    const gitDir = path.join(this.repoPath, '.git');
    if (!(await fs.pathExists(gitDir))) {
      throw new Error('Not a git repository: ' + this.repoPath);
    }

    this.git = simpleGit(this.repoPath);
    
    // Verify git repository is valid
    try {
      await this.git.status();
      logger.info('✅ Local repository validated: ' + this.repoPath);
    } catch (error) {
      throw new Error('Invalid git repository: ' + (error instanceof Error ? error.message : 'Unknown error'));
    }
  }

  /**
   * Create/checkout migration branch with enhanced error handling
   */
  async createBranch(): Promise<void> {
    try {
      const branches = await this.git.branch(['--all']);
      const currentBranch = branches.current;

      const localBranchExists = branches.all.includes(BRANCH_NAME);
      const remoteBranchExists = branches.all.includes('remotes/origin/' + BRANCH_NAME);

      if (localBranchExists || remoteBranchExists) {
        await this.handleExistingMigrationBranch(currentBranch, localBranchExists, remoteBranchExists);
      } else {
        await this.createNewMigrationBranch();
      }

      logger.info('✅ Migration branch ready: ' + BRANCH_NAME);
    } catch (error) {
      logger.error('Failed to create/checkout migration branch:', error);
      throw new Error('Branch creation failed: ' + (error instanceof Error ? error.message : 'Unknown error'));
    }
  }

  /**
   * Handle existing migration branch with conflict resolution
   */
  private async handleExistingMigrationBranch(
    currentBranch: string, 
    localExists: boolean, 
    remoteExists: boolean
  ): Promise<void> {
    if (currentBranch === BRANCH_NAME) {
      logger.info('Already on migration branch: ' + BRANCH_NAME);
      return;
    }

    try {
      if (localExists) {
        // Try to checkout existing local branch
        await this.git.checkout(BRANCH_NAME);
      } else if (remoteExists) {
        // Create local branch from remote
        try {
          await this.git.fetch('origin', BRANCH_NAME);
          await this.git.checkout(['-b', BRANCH_NAME, 'origin/' + BRANCH_NAME]);
        } catch (fetchError) {
          // Fallback: create new branch if remote tracking fails
          logger.warn('Failed to track remote branch, creating new branch');
          await this.createNewMigrationBranch();
        }
      }
    } catch (checkoutError) {
      logger.warn('Checkout failed, attempting branch reset...', checkoutError);
      
      // Force reset branch as last resort
      try {
        if (localExists) {
          await this.git.deleteLocalBranch(BRANCH_NAME, true);
        }
        await this.createNewMigrationBranch();
      } catch (resetError) {
        throw new Error('Cannot resolve branch conflicts: ' + (resetError instanceof Error ? resetError.message : 'Unknown error'));
      }
    }
  }

  /**
   * Create new migration branch
   */
  private async createNewMigrationBranch(): Promise<void> {
    try {
      await this.git.checkoutLocalBranch(BRANCH_NAME);
      logger.info('✅ Created new migration branch: ' + BRANCH_NAME);
    } catch (error) {
      throw new Error('Failed to create branch: ' + (error instanceof Error ? error.message : 'Unknown error'));
    }
  }

  /**
   * Get current repository path
   */
  getRepositoryPath(): string | null {
    return this.repoPath;
  }

  /**
   * Get git instance for advanced operations
   */
  getGitInstance(): SimpleGit {
    return this.git;
  }

  /**
   * Get current branch name with error handling
   */
  async getCurrentBranch(): Promise<string> {
    try {
      const branches = await this.git.branch();
      return branches.current;
    } catch (error) {
      logger.warn('Failed to get current branch, returning unknown:', error);
      return 'unknown';
    }
  }

  /**
   * Switch to a specific branch with error handling
   */
  async switchToBranch(branchName: string): Promise<void> {
    try {
      await this.git.checkout(branchName);
      logger.info('✅ Switched to branch: ' + branchName);
    } catch (error) {
      logger.error('Failed to switch to branch ' + branchName + ':', error);
      throw new Error('Branch switch failed: ' + (error instanceof Error ? error.message : 'Unknown error'));
    }
  }

  /**
   * Push the current branch to origin with enhanced error handling
   */
  async pushBranch(): Promise<void> {
    try {
      const currentBranch = await this.getCurrentBranch();
      
      if (currentBranch === 'unknown') {
        logger.warn('⚠️  Cannot push: unknown current branch');
        return;
      }

      // Try standard push first
      try {
        await this.git.push('origin', currentBranch);
        logger.info('✅ Successfully pushed branch ' + currentBranch + ' to origin');
        return;
      } catch (pushError) {
        logger.warn('Standard push failed, trying with upstream...', pushError);
      }

      // Try push with upstream
      try {
        await this.git.push(['-u', 'origin', currentBranch]);
        logger.info('✅ Successfully pushed branch ' + currentBranch + ' with upstream set');
      } catch (upstreamError) {
        // Push failure is not critical for migration success
        logger.warn('⚠️  Could not push branch ' + currentBranch + '. This is not critical for migration.');
        logger.warn('You can push manually later with: git push -u origin', currentBranch);
        
        // Log specific error details for debugging
        if (upstreamError instanceof Error) {
          if (upstreamError.message.includes('permission denied')) {
            logger.warn('   → Check your Git credentials and repository permissions');
          } else if (upstreamError.message.includes('network')) {
            logger.warn('   → Network issue detected, try again later');
          } else {
            logger.warn('   → Error: ' + upstreamError.message);
          }
        }
      }
    } catch (error) {
      logger.warn('⚠️  Push operation failed, continuing migration...', error);
      // Don't throw - push failure shouldn't stop migration
    }
  }

  /**
   * Get repository information
   */
  getRepositoryInfo(): {
    repoPath: string | null;
    isGitHub: boolean;
    originalPath: string | null;
  } {
    return {
      repoPath: this.repoPath,
      isGitHub: this.isGitHub,
      originalPath: this.originalPath,
    };
  }

  /**
   * Utility method for delays
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Validate repository state before migration
   */
  async validateRepositoryState(): Promise<{
    isValid: boolean;
    issues: string[];
    warnings: string[];
  }> {
    const issues: string[] = [];
    const warnings: string[] = [];

    try {
      if (!this.repoPath) {
        issues.push('Repository path not set');
        return { isValid: false, issues, warnings };
      }

      // Check if repository exists and is accessible
      if (!(await fs.pathExists(this.repoPath))) {
        issues.push('Repository path does not exist');
        return { isValid: false, issues, warnings };
      }

      // Check git status
      try {
        const status = await this.git.status();
        
        if (status.files.length > 0) {
          warnings.push('Repository has ' + status.files.length + ' uncommitted changes');
        }

        if (status.behind > 0) {
          warnings.push('Repository is ' + status.behind + ' commits behind origin');
        }
      } catch (statusError) {
        warnings.push('Could not check git status');
      }

      // Check if package.json exists
      const packageJsonPath = path.join(this.repoPath, 'package.json');
      if (!(await fs.pathExists(packageJsonPath))) {
        issues.push('No package.json found in repository');
      }

    } catch (error) {
      issues.push('Repository validation failed: ' + (error instanceof Error ? error.message : 'Unknown error'));
    }

    return {
      isValid: issues.length === 0,
      issues,
      warnings,
    };
  }
} 