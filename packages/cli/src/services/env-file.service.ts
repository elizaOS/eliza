import { promises as fs } from 'node:fs';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { logger } from '@elizaos/core';
import { UserEnvironment } from '@/src/utils';

export interface EnvVarEntry {
  key: string;
  value: string;
  comment?: string;
}

export interface WriteOptions {
  preserveComments?: boolean;
  createBackup?: boolean;
  updateProcessEnv?: boolean;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Unified service for managing environment files
 */
export class EnvFileService {
  private filePath: string;

  constructor(filePath?: string) {
    this.filePath = filePath || '';
  }

  /**
   * Initialize the service with the appropriate file path
   */
  async initialize(): Promise<void> {
    if (!this.filePath) {
      const envInfo = await UserEnvironment.getInstanceInfo();
      this.filePath = envInfo.paths.envFilePath;
    }
  }

  /**
   * Get the current environment file path
   */
  getFilePath(): string {
    return this.filePath;
  }

  /**
   * Read and parse the environment file
   */
  async read(): Promise<Record<string, string>> {
    const result: Record<string, string> = {};

    try {
      if (!existsSync(this.filePath)) {
        return result;
      }

      const content = await fs.readFile(this.filePath, 'utf-8');
      const lines = content.split('\n');

      for (const line of lines) {
        const trimmedLine = line.trim();
        if (trimmedLine && !trimmedLine.startsWith('#')) {
          const separatorIndex = trimmedLine.indexOf('=');
          if (separatorIndex > 0) {
            const key = trimmedLine.substring(0, separatorIndex).trim();
            const value = trimmedLine.substring(separatorIndex + 1).trim();
            result[key] = value;
          }
        }
      }
    } catch (error) {
      logger.error(`Error reading environment file: ${error}`);
    }

    return result;
  }

  /**
   * Read environment file with comments preserved
   */
  async readWithComments(): Promise<EnvVarEntry[]> {
    const entries: EnvVarEntry[] = [];

    try {
      if (!existsSync(this.filePath)) {
        return entries;
      }

      const content = await fs.readFile(this.filePath, 'utf-8');
      const lines = content.split('\n');
      let currentComment: string | undefined;

      for (const line of lines) {
        const trimmedLine = line.trim();

        if (trimmedLine.startsWith('#')) {
          // Accumulate comments
          const comment = trimmedLine.substring(1).trim();
          currentComment = currentComment ? `${currentComment}\n${comment}` : comment;
        } else if (trimmedLine && !trimmedLine.startsWith('#')) {
          const separatorIndex = trimmedLine.indexOf('=');
          if (separatorIndex > 0) {
            const key = trimmedLine.substring(0, separatorIndex).trim();
            const value = trimmedLine.substring(separatorIndex + 1).trim();
            entries.push({
              key,
              value,
              comment: currentComment,
            });
            currentComment = undefined;
          }
        } else if (!trimmedLine) {
          // Reset comment on empty lines
          currentComment = undefined;
        }
      }
    } catch (error) {
      logger.error(`Error reading environment file with comments: ${error}`);
    }

    return entries;
  }

  /**
   * Write environment variables to file
   */
  async write(vars: Record<string, string>, options: WriteOptions = {}): Promise<void> {
    const { preserveComments = false, createBackup = false, updateProcessEnv = true } = options;

    try {
      const dir = path.dirname(this.filePath);
      if (!existsSync(dir)) {
        await fs.mkdir(dir, { recursive: true });
      }

      // Create backup if requested
      if (createBackup && existsSync(this.filePath)) {
        const backupPath = `${this.filePath}.${Date.now()}.bak`;
        await fs.copyFile(this.filePath, backupPath);
        logger.info(`Created backup at ${backupPath}`);
      }

      let content = '';
      // Create a shallow copy to avoid mutating the input
      const varsCopy = { ...vars };

      if (preserveComments) {
        // Preserve existing comments
        const existingEntries = await this.readWithComments();
        const existingKeys = new Set(existingEntries.map((e) => e.key));

        // Write existing entries with their comments
        for (const entry of existingEntries) {
          if (Object.prototype.hasOwnProperty.call(varsCopy, entry.key)) {
            if (entry.comment) {
              content += `# ${entry.comment.replace(/\n/g, '\n# ')}\n`;
            }
            content += `${entry.key}=${varsCopy[entry.key]}\n`;
            delete varsCopy[entry.key];
          }
        }

        // Add any new entries
        if (Object.keys(varsCopy).length > 0 && content) {
          content += '\n';
        }
      }

      // Write remaining variables
      for (const [key, value] of Object.entries(varsCopy)) {
        // Only write string values (env vars must be strings)
        if (typeof value === 'string') {
          content += `${key}=${value}\n`;

          // Update process.env if requested
          if (updateProcessEnv) {
            process.env[key] = value;
          }
        }
      }

      await fs.writeFile(this.filePath, content, 'utf-8');
      logger.info(`Environment variables saved to ${this.filePath}`);
    } catch (error) {
      logger.error(`Error writing environment file: ${error}`);
      throw error;
    }
  }

  /**
   * Update a single environment variable
   */
  async update(key: string, value: string, options: WriteOptions = {}): Promise<void> {
    const vars = await this.read();
    vars[key] = value;

    // Update process.env by default for single updates
    if (options.updateProcessEnv !== false) {
      process.env[key] = value;
    }

    await this.write(vars, { preserveComments: true, ...options });
  }

  /**
   * Update multiple environment variables
   */
  async updateMany(updates: Record<string, string>, options: WriteOptions = {}): Promise<void> {
    const vars = await this.read();
    Object.assign(vars, updates);

    // Update process.env by default
    if (options.updateProcessEnv !== false) {
      for (const [key, value] of Object.entries(updates)) {
        process.env[key] = value;
      }
    }

    await this.write(vars, { preserveComments: true, ...options });
  }

  /**
   * Delete an environment variable
   */
  async delete(key: string): Promise<void> {
    const vars = await this.read();
    delete vars[key];
    delete process.env[key];
    await this.write(vars, { preserveComments: true });
  }

  /**
   * Check if a key exists
   */
  async exists(key: string): Promise<boolean> {
    const vars = await this.read();
    return Object.prototype.hasOwnProperty.call(vars, key);
  }

  /**
   * Get a single environment variable value
   */
  async get(key: string): Promise<string | undefined> {
    const vars = await this.read();
    return vars[key];
  }

  /**
   * Create a backup of the current environment file
   */
  async backup(): Promise<string> {
    if (!existsSync(this.filePath)) {
      throw new Error('No environment file to backup');
    }

    const backupPath = `${this.filePath}.${Date.now()}.bak`;
    await fs.copyFile(this.filePath, backupPath);
    return backupPath;
  }

  /**
   * Validate the environment file
   */
  async validate(): Promise<ValidationResult> {
    const errors: string[] = [];

    try {
      if (!existsSync(this.filePath)) {
        return { valid: true, errors: [] };
      }

      const content = await fs.readFile(this.filePath, 'utf-8');
      const lines = content.split('\n');

      lines.forEach((line, index) => {
        const trimmedLine = line.trim();
        if (trimmedLine && !trimmedLine.startsWith('#')) {
          const separatorIndex = trimmedLine.indexOf('=');
          if (separatorIndex < 1) {
            errors.push(`Line ${index + 1}: Invalid format (missing '=' separator)`);
          } else {
            const key = trimmedLine.substring(0, separatorIndex).trim();
            if (!/^[A-Z_][A-Z0-9_]*$/i.test(key)) {
              errors.push(`Line ${index + 1}: Invalid key format '${key}'`);
            }
          }
        }
      });
    } catch (error) {
      errors.push(`Error reading file: ${error}`);
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }
}

// Singleton instance for global use
let globalInstance: EnvFileService | null = null;

/**
 * Get the global EnvFileService instance
 */
export async function getEnvFileService(): Promise<EnvFileService> {
  if (!globalInstance) {
    globalInstance = new EnvFileService();
    await globalInstance.initialize();
  }
  return globalInstance;
}

/**
 * Create a new EnvFileService instance for a specific file
 */
export function createEnvFileService(filePath: string): EnvFileService {
  return new EnvFileService(filePath);
}
