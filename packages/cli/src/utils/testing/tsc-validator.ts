import { logger } from '@elizaos/core';
import { bunExec } from '../bun-exec.js';
import path from 'node:path';
import { existsSync } from 'node:fs';

export interface TypeCheckResult {
  success: boolean;
  errors: string[];
  warnings: string[];
}

export async function runTypeCheck(
  projectPath: string,
  strict: boolean = true
): Promise<TypeCheckResult> {
  const tsconfigPath = path.join(projectPath, 'tsconfig.json');

  if (!existsSync(tsconfigPath)) {
    return {
      success: false,
      errors: [`No tsconfig.json found at ${tsconfigPath}`],
      warnings: [],
    };
  }

  try {
    const args = ['--noEmit'];
    if (strict) {
      args.push('--strict');
    }

    // Use bun x to run the project's local TypeScript compiler
    const result = await bunExec('bun', ['x', 'tsc', ...args], {
      cwd: projectPath,
    });
    const { stdout, stderr } = result;

    const hasErrors = stderr.includes('error TS') || stdout.includes('error TS');

    return {
      success: !hasErrors,
      errors: hasErrors ? [stderr || stdout] : [],
      warnings: stderr.includes('warning') ? [stderr] : [],
    };
  } catch (error: any) {
    logger.error({ error }, 'TypeScript validation failed:');
    return {
      success: false,
      errors: [`TypeScript validation error: ${error.message}`],
      warnings: [],
    };
  }
}
