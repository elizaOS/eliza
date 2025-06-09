import { spawn } from 'child_process';

// Helper function to replace execa
function execCommand(command: string, args: string[], options: { stdio?: 'pipe' | 'inherit'; cwd?: string }): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || process.cwd(),
      stdio: options.stdio || 'pipe'
    });

    let stdout = '';
    let stderr = '';

    if (options.stdio === 'pipe' && child.stdout && child.stderr) {
      child.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      child.stderr.on('data', (data) => {
        stderr += data.toString();
      });
    }

    child.on('close', (code) => {
      resolve({ stdout, stderr, exitCode: code || 0 });
    });

    child.on('error', reject);
  });
}
import * as fs from 'fs-extra';
import * as path from 'node:path';
import { logger } from '@elizaos/core';

/**
 * Check if dependencies are installed and install them if needed
 */
export async function ensureDependenciesInstalled(): Promise<void> {
  try {
    const installResult = await execCommand('bun', ['install'], { stdio: 'inherit' });
  
  if (installResult.exitCode !== 0) {
    throw new Error(`Install failed with exit code ${installResult.exitCode}`);
  }
  } catch (error) {
    throw new Error(`Failed to install dependencies: ${error}`);
  }
}

/**
 * Get available disk space in GB
 */
export async function getAvailableDiskSpace(): Promise<number> {
  try {
    const result = await execCommand('df', ['-h', '.'], { stdio: 'pipe' });
    const stdout = result.stdout;
    const lines = stdout.trim().split('\n');
    
    // Find the line with filesystem data (may be wrapped)
    let dataLine = lines[1];
    let columns = dataLine.split(/\s+/);
    
    // Handle wrapped lines - if columns[3] doesn't look like a size, try combining lines
    if (columns.length < 4 || !columns[3].match(/\d+[KMGT]?i?/)) {
      dataLine = lines[1] + ' ' + lines[2];
      columns = dataLine.split(/\s+/);
    }
    
    const availableStr = columns[3];
    logger.info(`Debug: Available disk space raw: ${availableStr}`);
    
    // Updated regex to handle both single char (G, M, K, T) and double char (Gi, Mi, Ki, Ti) units
    const match = availableStr.match(/^(\d+(?:\.\d+)?)([KMGT]i?)$/i);
    if (!match) {
      logger.warn(`Could not parse disk space format: ${availableStr}`);
      return 10; // Default assumption
    }
    
    const [, size, unit] = match;
    const sizeNum = parseFloat(size);
    
    // Handle both binary (i) and decimal units
    switch (unit.toLowerCase()) {
      case 't':
      case 'ti': return sizeNum * 1024;
      case 'g':
      case 'gi': return sizeNum;
      case 'm':
      case 'mi': return sizeNum / 1024;
      case 'k':
      case 'ki': return sizeNum / (1024 * 1024);
      default: return sizeNum / (1024 * 1024 * 1024);
    }
  } catch (error) {
    logger.warn(`Failed to check disk space: ${error}. Assuming sufficient space.`);
    return 10; // Default assumption
  }
}

/**
 * Check if a command is available
 */
export async function isCommandAvailable(command: string): Promise<boolean> {
  try {
    const whichResult = await execCommand('which', [command], { stdio: 'pipe' });
    
    if (whichResult.exitCode !== 0) {
      throw new Error(`Command '${command}' not found`);
    }
    return true;
  } catch {
    return false;
  }
}

// New utility functions to reduce duplication

export async function safeFileOperation<T>(
  operation: () => Promise<T>,
  errorMessage: string
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    logger.error(`${errorMessage}: ${error}`);
    throw error;
  }
}

export async function executeWithTimeout(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    timeout?: number;
    stdio?: 'pipe' | 'inherit';
  } = {}
): Promise<{ success: boolean; output?: string; error?: string }> {
  try {
    const result = await execCommand(command, args, {
      cwd: options.cwd || process.cwd(),
      stdio: options.stdio || 'pipe',
    });

    return {
      success: result.exitCode === 0,
      output: result.stdout,
      error: result.stderr
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function createFileWithContent(
  filePath: string,
  content: string,
  options: { overwrite?: boolean } = {}
): Promise<boolean> {
  try {
    if (!options.overwrite && await fs.pathExists(filePath)) {
      logger.warn(`File already exists: ${filePath}`);
      return false;
    }

    await fs.ensureDir(path.dirname(filePath));
    await fs.writeFile(filePath, content);
    logger.info(`Created file: ${filePath}`);
    return true;
  } catch (error) {
    logger.error(`Failed to create file ${filePath}: ${error}`);
    return false;
  }
}

export async function deleteFileOrDirectory(filePath: string): Promise<boolean> {
  try {
    if (await fs.pathExists(filePath)) {
      await fs.remove(filePath);
      logger.info(`Deleted: ${filePath}`);
      return true;
    }
    return false;
  } catch (error) {
    logger.error(`Failed to delete ${filePath}: ${error}`);
    return false;
  }
}

export function createProgressTracker(totalSteps: number) {
  let currentStep = 0;

  return {
    next: (stepName: string) => {
      currentStep++;
      const percentage = Math.round((currentStep / totalSteps) * 100);
      logger.info(`[${currentStep}/${totalSteps} - ${percentage}%] ${stepName}`);
    },
    complete: () => {
      logger.info(`✅ All ${totalSteps} steps completed successfully`);
    }
  };
}

export async function validateEnvironmentFile(repoPath: string): Promise<string[]> {
  const envPath = path.join(repoPath, '.env');
  const missingVars: string[] = [];

  if (!await fs.pathExists(envPath)) {
    return ['OPENAI_API_KEY']; // Always required
  }

  const envContent = await fs.readFile(envPath, 'utf-8');
  
  // Check for required variables
  const requiredVars = ['OPENAI_API_KEY'];
  
  for (const varName of requiredVars) {
    if (!envContent.includes(`${varName}=`)) {
      missingVars.push(varName);
    }
  }

  return missingVars;
}

export function parseErrorOutput(output: string): {
  type: 'build' | 'test' | 'lint' | 'unknown';
  critical: boolean;
  message: string;
  file?: string;
  line?: number;
} {
  // Build errors
  if (output.includes('TS') && output.includes('error')) {
    const fileMatch = output.match(/(\S+\.ts)\((\d+),\d+\):/);
    return {
      type: 'build',
      critical: true,
      message: output,
      file: fileMatch?.[1],
      line: fileMatch?.[2] ? parseInt(fileMatch[2]) : undefined
    };
  }

  // Test errors
  if (output.includes('FAIL') || output.includes('Test failed')) {
    return {
      type: 'test',
      critical: true,
      message: output
    };
  }

  // Lint errors
  if (output.includes('prettier') || output.includes('format')) {
    return {
      type: 'lint',
      critical: false,
      message: output
    };
  }

  return {
    type: 'unknown',
    critical: true,
    message: output
  };
}
