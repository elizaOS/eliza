import Anthropic from '@anthropic-ai/sdk';
import { logger } from '@elizaos/core';
import { execa } from 'execa';
import * as fs from 'fs-extra';
import * as path from 'node:path';
import { globby } from 'globby';
import { getAvailableDiskSpace } from '../utils.js';
import { MIN_DISK_SPACE_GB } from '../config.js';
import { getDummyValueForEnvVar } from './migration-utilities.js';
import { EnvPrompter, type EnvVarPrompt } from '../env-prompter.js';

/**
 * Environment management for migration process
 */
export class EnvironmentManager {
  private anthropic: Anthropic | null = null;

  constructor(private repoPath: string) {}

  /**
   * Initialize Anthropic client
   */
  async initializeAnthropic(): Promise<void> {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      logger.error('ANTHROPIC_API_KEY not found in environment.');
      throw new Error('ANTHROPIC_API_KEY is required for migration');
    }

    this.anthropic = new Anthropic({ apiKey });
  }

  /**
   * Check available disk space
   */
  async checkDiskSpace(): Promise<void> {
    const diskSpace = await getAvailableDiskSpace();
    if (diskSpace < MIN_DISK_SPACE_GB) {
      throw new Error(
        `Insufficient disk space. Need at least ${MIN_DISK_SPACE_GB}GB free, but only ${diskSpace.toFixed(2)}GB available.`
      );
    }
  }

  /**
   * Setup test environment with required dependencies and environment variables
   */
  async setupTestEnvironment(): Promise<void> {
    logger.info('🔧 Setting up test environment...');

    try {
      // Check if bun is available
      await execa('bun', ['--version'], {
        cwd: this.repoPath,
        stdio: 'pipe'
      });
    } catch (error) {
      logger.warn('⚠️  Bun not found, trying npm...');
    }

    // Install dependencies if needed
    try {
      const packageJsonPath = path.join(this.repoPath, 'package.json');
      const packageJson = await fs.readJson(packageJsonPath);
      
      if (!packageJson.dependencies?.['@elizaos/core']) {
        logger.info('📦 Installing @elizaos/core dependency...');
        try {
          await execa('bun', ['add', '@elizaos/core'], {
            cwd: this.repoPath,
            stdio: 'pipe',
            timeout: 60000
          });
        } catch (bunError) {
          await execa('npm', ['install', '@elizaos/core'], {
            cwd: this.repoPath,
            stdio: 'pipe',
            timeout: 60000
          });
        }
      }
    } catch (error) {
      logger.warn('Could not install dependencies:', error);
    }

    // Setup environment variables for testing
    await this.setupTestEnvVars();

    logger.info('✅ Test environment setup complete');
  }

  /**
   * Setup test environment variables
   */
  private async setupTestEnvVars(): Promise<void> {
    const requiredVars = await this.detectRequiredEnvVars();
    
    for (const envVar of requiredVars) {
      if (!process.env[envVar]) {
        const dummyValue = getDummyValueForEnvVar(envVar);
        process.env[envVar] = dummyValue;
        logger.info(`🔧 Set test value for ${envVar}`);
      }
    }
  }

  /**
   * Detect required environment variables from the codebase
   */
  async detectRequiredEnvVars(): Promise<string[]> {
    const envVars = new Set<string>();
    
    try {
      // Get all TypeScript files
      const files = await globby(['src/**/*.ts', '*.ts'], {
        cwd: this.repoPath,
        ignore: ['node_modules/**', 'dist/**']
      });

      for (const file of files) {
        const filePath = path.join(this.repoPath, file);
        const content = await fs.readFile(filePath, 'utf-8');
        
        // Look for process.env.VAR_NAME patterns
        const envPattern = /process\.env\.([A-Z_][A-Z0-9_]*)/g;
        let match: RegExpExecArray | null;
        
        match = envPattern.exec(content);
        while (match !== null) {
          const envVar = match[1];
          // Skip common Node.js env vars
          if (!['NODE_ENV', 'PATH', 'HOME', 'USER', 'PWD'].includes(envVar)) {
            envVars.add(envVar);
          }
          match = envPattern.exec(content);
        }
        
        // Look for runtime.getSetting patterns  
        const settingPattern = /runtime\.getSetting\(['"]([A-Z_][A-Z0-9_]*)['"]\)/g;
        match = settingPattern.exec(content);
        while (match !== null) {
          envVars.add(match[1]);
          match = settingPattern.exec(content);
        }
      }
      
      // Check package.json for scripts that might need env vars
      const packageJsonPath = path.join(this.repoPath, 'package.json');
      if (await fs.pathExists(packageJsonPath)) {
        const packageJson = await fs.readJson(packageJsonPath);
        const scripts = packageJson.scripts || {};
        
        for (const script of Object.values(scripts)) {
          if (typeof script === 'string') {
            const envPattern = /\$\{?([A-Z_][A-Z0-9_]*)\}?/g;
            let match: RegExpExecArray | null;
            match = envPattern.exec(script);
            while (match !== null) {
              envVars.add(match[1]);
              match = envPattern.exec(script);
            }
          }
        }
      }
      
    } catch (error) {
      logger.warn('Could not detect required env vars:', error);
    }

    return Array.from(envVars);
  }

  /**
   * Handle missing environment variables by prompting user or setting dummy values
   */
  async handleMissingEnvVars(output: string): Promise<void> {
    // Extract env var names from error output
    const envVarPattern = /(?:Environment variable|env var|variable)\s+['"']?([A-Z_][A-Z0-9_]*)['"']?\s+(?:is|not|undefined|missing)/gi;
    const missingVars = new Set<string>();
    
    let match: RegExpExecArray | null;
    match = envVarPattern.exec(output);
    while (match !== null) {
      missingVars.add(match[1]);
      match = envVarPattern.exec(output);
    }
    
    // Also check for process.env.VAR_NAME patterns in error messages
    const processEnvPattern = /process\.env\.([A-Z_][A-Z0-9_]*)/g;
    match = processEnvPattern.exec(output);
    while (match !== null) {
      if (!process.env[match[1]]) {
        missingVars.add(match[1]);
      }
      match = processEnvPattern.exec(output);
    }
    
    if (missingVars.size === 0) return;
    
    logger.info(`🔧 Setting up ${missingVars.size} missing environment variables...`);
    
    for (const envVar of missingVars) {
      if (!process.env[envVar]) {
        // For testing, set dummy values
        const dummyValue = getDummyValueForEnvVar(envVar);
        process.env[envVar] = dummyValue;
        logger.info(`🔧 Set test value for ${envVar}: ${dummyValue.substring(0, 20)}...`);
      }
    }
  }

  /**
   * Validate environment setup
   */
  async validateEnvironment(): Promise<string[]> {
    const issues: string[] = [];

    // Check Node.js version
    try {
      const nodeVersion = process.version;
      const majorVersion = Number.parseInt(nodeVersion.slice(1).split('.')[0]);
      if (majorVersion < 18) {
        issues.push(`Node.js version ${nodeVersion} is too old. Requires Node.js 18+`);
      }
    } catch (error) {
      issues.push('Could not determine Node.js version');
    }

    // Check for required tools
    const requiredTools = ['git'];
    for (const tool of requiredTools) {
      try {
        await execa(tool, ['--version'], { stdio: 'pipe' });
      } catch (error) {
        issues.push(`Required tool not found: ${tool}`);
      }
    }

    // Check disk space
    try {
      const diskSpace = await getAvailableDiskSpace();
      if (diskSpace < MIN_DISK_SPACE_GB) {
        issues.push(`Insufficient disk space: ${diskSpace.toFixed(2)}GB available, ${MIN_DISK_SPACE_GB}GB required`);
      }
    } catch (error) {
      issues.push('Could not check disk space');
    }

    // Check required environment variables
    const requiredEnvVars = ['ANTHROPIC_API_KEY'];
    for (const envVar of requiredEnvVars) {
      if (!process.env[envVar]) {
        issues.push(`Missing required environment variable: ${envVar}`);
      }
    }

    return issues;
  }

  /**
   * Get current environment info
   */
  getEnvironmentInfo(): Record<string, string> {
    return {
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      cwd: process.cwd(),
      repoPath: this.repoPath,
      hasAnthropicKey: String(!!process.env.ANTHROPIC_API_KEY),
    };
  }
} 