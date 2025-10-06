import dotenv from 'dotenv';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { type RuntimeSettings } from '../types';

/**
 * Manages environment configuration loading and access
 */
export class EnvironmentConfig {
  /**
   * Load environment configuration for runtime
   *
   * Loads environment variables from the project's .env file and returns them as runtime settings.
   */
  static async loadEnvConfig(): Promise<RuntimeSettings> {
    // Try to find and load .env file
    const envPath = EnvironmentConfig.findEnvFile();
    if (envPath) {
      dotenv.config({ path: envPath });
    }
    return process.env as RuntimeSettings;
  }

  /**
   * Find the .env file in the project
   */
  static findEnvFile(): string | null {
    const possiblePaths = [
      path.join(process.cwd(), '.env'),
      path.join(process.cwd(), '.env.local'),
    ];

    for (const envPath of possiblePaths) {
      if (fs.existsSync(envPath)) {
        return envPath;
      }
    }

    return null;
  }
}
