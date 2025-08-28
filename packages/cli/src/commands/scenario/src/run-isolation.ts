/**
 * Run Isolation System for Matrix Testing
 *
 * This module provides complete isolation between scenario runs to prevent
 * interference and ensure clean execution environments. Each run gets its own
 * temporary directory, database instance, and log files.
 *
 * Required by ticket #5782 - Acceptance Criterion 2.
 */

import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
// Import will be done dynamically to avoid circular dependencies

/**
 * Represents a completely isolated environment for a single scenario run.
 */
export interface IsolationContext {
  /** Unique identifier for this run */
  runId: string;
  /** Root temporary directory for this run */
  tempDir: string;
  /** Path to isolated database directory */
  dbPath: string;
  /** Path to log file for this run */
  logPath: string;
  /** Path to temporary scenario file with overrides applied */
  scenarioPath: string;
  /** Cleanup function that removes all artifacts */
  cleanup: () => Promise<void>;
}

/**
 * Global run sequence counter for generating unique run IDs.
 */
let runSequence = 0;

/**
 * Resets the run sequence counter (useful for testing).
 */
export function resetRunSequence(): void {
  runSequence = 0;
}

/**
 * Generates a unique run ID with sequence number and hash.
 *
 * @returns Unique run ID in format "run-XXX-hash"
 */
export function generateRunId(): string {
  const sequence = String(runSequence++).padStart(3, '0');
  const hash = Math.random().toString(16).substring(2, 10);
  return `run-${sequence}-${hash}`;
}

/**
 * Creates a completely isolated environment for a scenario run.
 *
 * This function sets up:
 * - Isolated temporary directory
 * - Separate database path
 * - Individual log file
 * - Clean environment state
 *
 * @param runId - Unique identifier for this run
 * @param outputDir - Base output directory for the matrix execution
 * @returns Isolation context with cleanup function
 */
export async function createIsolatedEnvironment(
  runId: string,
  outputDir: string
): Promise<IsolationContext> {
  // Create isolated temporary directory
  const tempDir = join(outputDir, 'temp', runId);
  await fs.mkdir(tempDir, { recursive: true });

  // Set up isolated paths
  const dbPath = join(tempDir, 'database');
  const logsDir = join(tempDir, 'logs');
  const logPath = join(logsDir, 'run.log');
  const scenarioPath = join(tempDir, 'scenario.yaml');

  // Create necessary subdirectories
  await fs.mkdir(dirname(logPath), { recursive: true });
  await fs.mkdir(dbPath, { recursive: true });

  // Create cleanup function
  const cleanup = async () => {
    await cleanupIsolatedEnvironment({
      runId,
      tempDir,
      dbPath,
      logPath,
      scenarioPath,
      cleanup: () => Promise.resolve(),
    });
  };

  return {
    runId,
    tempDir,
    dbPath,
    logPath,
    scenarioPath,
    cleanup,
  };
}

/**
 * Completely removes an isolated environment and all its artifacts.
 *
 * @param context - The isolation context to clean up
 */
export async function cleanupIsolatedEnvironment(context: IsolationContext): Promise<void> {
  try {
    // Remove the entire temporary directory tree
    await fs.rm(context.tempDir, { recursive: true, force: true });
  } catch (error) {
    // Log cleanup errors but don't throw - cleanup should be resilient
    console.warn(`Warning: Failed to cleanup isolated environment ${context.runId}:`, error);
  }
}

/**
 * Ensures the isolated database directory is properly configured.
 *
 * @param dbPath - Path to the isolated database directory
 */
export async function ensureIsolatedDatabase(dbPath: string): Promise<void> {
  try {
    // Ensure database directory exists
    await fs.mkdir(dbPath, { recursive: true });

    // Create database configuration file for isolation
    const dbConfig = {
      type: 'pglite',
      path: dbPath,
      isolated: true,
      temporary: true,
    };

    const configPath = join(dbPath, 'config.json');
    await fs.writeFile(configPath, JSON.stringify(dbConfig, null, 2));
  } catch (error) {
    throw new Error(
      `Failed to setup isolated database: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Writes a temporary scenario file with parameter overrides applied.
 *
 * @param scenarioPath - Path where the temporary scenario should be written
 * @param baseScenario - The base scenario object to modify
 * @param parameters - Parameter overrides to apply
 */
export async function writeTemporaryScenario(
  scenarioPath: string,
  baseScenario: any,
  parameters: Record<string, any>
): Promise<void> {
  try {
    // Simple parameter application for isolated runs
    // Create a deep copy of the base scenario
    const modifiedScenario = JSON.parse(JSON.stringify(baseScenario));

    // Apply simple parameter overrides
    for (const [path, value] of Object.entries(parameters)) {
      setNestedProperty(modifiedScenario, path, value);
    }

    // Write the modified scenario to the temporary file
    await fs.writeFile(scenarioPath, JSON.stringify(modifiedScenario, null, 2));
  } catch (error) {
    throw new Error(
      `Failed to write temporary scenario: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Simple utility to set nested properties using dot notation.
 * This is a simplified version that avoids complex dependencies.
 */
function setNestedProperty(obj: any, path: string, value: any): void {
  const keys = path.split('.');
  let current = obj;

  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];

    // Handle array access like "run[0]"
    const arrayMatch = key.match(/^(.+)\[(\d+)\]$/);
    if (arrayMatch) {
      const [, arrayKey, indexStr] = arrayMatch;
      const index = parseInt(indexStr, 10);

      if (!current[arrayKey]) {
        current[arrayKey] = [];
      }
      if (!current[arrayKey][index]) {
        current[arrayKey][index] = {};
      }
      current = current[arrayKey][index];
    } else {
      if (!current[key]) {
        current[key] = {};
      }
      current = current[key];
    }
  }

  // Set the final value
  const finalKey = keys[keys.length - 1];
  const arrayMatch = finalKey.match(/^(.+)\[(\d+)\]$/);
  if (arrayMatch) {
    const [, arrayKey, indexStr] = arrayMatch;
    const index = parseInt(indexStr, 10);

    if (!current[arrayKey]) {
      current[arrayKey] = [];
    }
    current[arrayKey][index] = value;
  } else {
    current[finalKey] = value;
  }
}

/**
 * Validates that an isolation context is properly set up.
 *
 * @param context - The isolation context to validate
 * @returns True if the context is valid and ready for use
 */
export async function validateIsolationContext(context: IsolationContext): Promise<boolean> {
  try {
    // Check that all required directories exist
    const tempDirExists = await fs
      .access(context.tempDir)
      .then(() => true)
      .catch(() => false);
    const dbDirExists = await fs
      .access(context.dbPath)
      .then(() => true)
      .catch(() => false);
    const logDirExists = await fs
      .access(dirname(context.logPath))
      .then(() => true)
      .catch(() => false);

    return tempDirExists && dbDirExists && logDirExists;
  } catch {
    return false;
  }
}

/**
 * Creates environment variables for isolated execution.
 *
 * @param context - The isolation context
 * @returns Environment variables object
 */
export function createIsolatedEnvironmentVariables(
  context: IsolationContext
): Record<string, string> {
  const baseEnv = { ...process.env };

  // Override database-related environment variables for isolation
  const isolatedEnv = {
    ...baseEnv,
    // Point to isolated database
    DATABASE_URL: `file://${context.dbPath}/database.db`,
    PGLITE_DATABASE_PATH: context.dbPath,

    // Set isolated temp directory
    TMPDIR: context.tempDir,
    TEMP: context.tempDir,
    TMP: context.tempDir,

    // Set log configuration
    LOG_FILE: context.logPath,
    LOG_LEVEL: 'debug',

    // Mark as isolated execution
    ELIZA_ISOLATED_RUN: 'true',
    ELIZA_RUN_ID: context.runId,

    // Disable any global state or caching
    DISABLE_GLOBAL_CACHE: 'true',
    FORCE_ISOLATED_MODE: 'true',
  };

  return isolatedEnv;
}

/**
 * Gets the current system temporary directory with a unique subdirectory.
 *
 * @param prefix - Prefix for the temporary directory name
 * @returns Path to a unique temporary directory
 */
export function getIsolatedTempDir(prefix: string = 'eliza-matrix'): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  return join(tmpdir(), `${prefix}-${timestamp}-${random}`);
}

/**
 * Estimates disk space required for a scenario run.
 *
 * @param baseScenario - The scenario that will be executed
 * @returns Estimated disk space in bytes
 */
export function estimateRunDiskSpace(baseScenario: any): number {
  // Basic estimation based on scenario complexity
  const baseSize = 50 * 1024 * 1024; // 50 MB base
  const runCount = baseScenario.run?.length || 1;
  const evaluationCount =
    baseScenario.run?.reduce((sum: number, run: any) => sum + (run.evaluations?.length || 0), 0) ||
    0;

  // Estimate additional space based on complexity
  const complexityMultiplier = 1 + runCount * 0.1 + evaluationCount * 0.05;

  return Math.ceil(baseSize * complexityMultiplier);
}

/**
 * Checks if there's sufficient disk space for a matrix run.
 *
 * @param outputDir - Directory where matrix output will be stored
 * @param estimatedSpace - Estimated space required in bytes
 * @returns True if there's sufficient space
 */
export async function checkDiskSpace(outputDir: string, _estimatedSpace: number): Promise<boolean> {
  try {
    await fs.stat(outputDir);
    // This is a simplified check - in a real implementation you'd check available disk space
    // For now, we'll assume there's enough space if the directory exists
    return true;
  } catch {
    // Directory doesn't exist, try to create it to test writability
    try {
      await fs.mkdir(outputDir, { recursive: true });
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Monitors an isolated environment for resource usage during execution.
 *
 * @param context - The isolation context to monitor
 * @returns Resource usage information
 */
export async function monitorIsolatedResources(context: IsolationContext): Promise<{
  diskUsage: number;
  fileCount: number;
  directorySize: number;
}> {
  try {
    // Calculate directory size and file count
    let totalSize = 0;
    let fileCount = 0;

    async function calculateSize(dirPath: string): Promise<void> {
      try {
        const entries = await fs.readdir(dirPath, { withFileTypes: true });

        for (const entry of entries) {
          const fullPath = join(dirPath, entry.name);

          if (entry.isDirectory()) {
            await calculateSize(fullPath);
          } else {
            const stats = await fs.stat(fullPath);
            totalSize += stats.size;
            fileCount++;
          }
        }
      } catch {
        // Ignore errors for individual files/directories
      }
    }

    await calculateSize(context.tempDir);

    return {
      diskUsage: totalSize,
      fileCount,
      directorySize: totalSize,
    };
  } catch {
    return {
      diskUsage: 0,
      fileCount: 0,
      directorySize: 0,
    };
  }
}
