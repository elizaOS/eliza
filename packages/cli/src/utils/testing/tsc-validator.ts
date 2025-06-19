import { logger } from '@elizaos/core';
import { execa } from 'execa';
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

    const { stdout, stderr } = await execa('tsc', args, {
      cwd: projectPath,
      reject: false,
    });

    const hasErrors = stderr.includes('error TS') || stdout.includes('error TS');

    return {
      success: !hasErrors,
      errors: hasErrors ? [stderr || stdout] : [],
      warnings: stderr.includes('warning') ? [stderr] : [],
    };
  } catch (error: any) {
    logger.error('TypeScript validation failed:', error);
    return {
      success: false,
      errors: [`TypeScript validation error: ${error.message}`],
      warnings: [],
    };
  }
}
