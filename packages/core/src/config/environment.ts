import dotenv from 'dotenv';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { type RuntimeSettings } from '../types';

/**
 * Find the .env file in the project
 */
export function findEnvFile(): string | null {
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

/**
 * Load environment configuration for runtime
 * Loads environment variables from the project's .env file and returns them as runtime settings.
 */
export async function loadEnvConfig(envPath?: string): Promise<RuntimeSettings> {
  // Try to find and load .env file
  const resolvedPath = envPath || findEnvFile();
  if (resolvedPath) {
    const result = dotenv.config({ path: resolvedPath });
    if (result.error) {
      throw result.error;
    }
  }
  return process.env as RuntimeSettings;
}
