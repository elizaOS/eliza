/**
 * Validation utilities rules
 */

import * as fs from 'fs';
import * as path from 'path';
import { CodingRule } from './types';
import { PYTHON_CODING_RULES, TYPESCRIPT_CODING_RULES } from './general';

/**
 * Result of a validation check
 */
export interface ValidationResult {
  valid: boolean;
  file?: string;
  violations: Violation[];
  warnings: string[];
}

export interface Violation {
  rule: string;
  line?: number;
  column?: number;
  message: string;
  severity: 'error' | 'warning';
}

/**
 * Validate Python code against rules
 */
export class PythonValidator {
  constructor(_rules: CodingRule[] = PYTHON_CODING_RULES) {
    // Allow custom rules to be passed in but not used internally yet
  }

  validate(code: string, filePath?: string): ValidationResult {
    const violations: Violation[] = [];
    const warnings: string[] = [];

    // Check for type annotations
    if (!this.hasTypeAnnotations(code)) {
      violations.push({
        rule: 'python-type-annotations',
        message: 'Missing type annotations in function definitions',
        severity: 'error',
      });
    }

    // Check for os.path usage
    const osPathMatches = Array.from(code.matchAll(/import os\.path|from os import path/g));
    for (const match of osPathMatches) {
      const line = this.getLineNumber(code, match.index!);
      violations.push({
        rule: 'use-pathlib',
        line,
        message: 'Use pathlib instead of os.path',
        severity: 'error',
      });
    }

    // Check for file open patterns
    const openMatches = Array.from(code.matchAll(/with\s+open\s*\([^)]+\)\s*as/g));
    for (const match of openMatches) {
      const line = this.getLineNumber(code, match.index!);
      if (!code.slice(Math.max(0, match.index! - 100), match.index!).includes('Path')) {
        violations.push({
          rule: 'use-pathlib',
          line,
          message: 'Use Path.read_text() or Path.write_text() instead of open()',
          severity: 'error',
        });
      }
    }

    // Check for argparse usage in main scripts
    if (filePath && this.isMainScript(filePath) && !code.includes('argparse')) {
      warnings.push('Consider using argparse for command-line interfaces');
    }

    // Check for excessive comments
    const commentDensity = this.calculateCommentDensity(code);
    if (commentDensity > 0.3) {
      warnings.push(
        `High comment density (${(commentDensity * 100).toFixed(1)}%). Keep comments minimal and focused on complex logic.`,
      );
    }

    return {
      valid: violations.filter((v) => v.severity === 'error').length === 0,
      file: filePath,
      violations,
      warnings,
    };
  }

  private hasTypeAnnotations(code: string): boolean {
    // Check for function definitions with type hints
    // Match all function definitions
    const funcPattern = /def\s+\w+\s*\([^)]*\)\s*(?:->.*?)?:/g;
    const funcs = code.match(funcPattern) || [];

    if (funcs.length === 0) {
      return true;
    } // No functions to check

    // Check if functions have return type annotations (->)
    const typedFuncs = funcs.filter((f) => f.includes('->'));
    return typedFuncs.length > funcs.length * 0.8; // At least 80% typed
  }

  private getLineNumber(code: string, index: number): number {
    return code.slice(0, index).split('\n').length;
  }

  private isMainScript(filePath: string): boolean {
    const filename = path.basename(filePath);
    return filename.startsWith('run_') || filename.includes('main') || filename.includes('cli');
  }

  private calculateCommentDensity(code: string): number {
    const lines = code.split('\n');
    const commentLines = lines.filter((line) => {
      const trimmed = line.trim();
      return trimmed.startsWith('#') || trimmed.startsWith('"""') || trimmed.startsWith("'''");
    });
    return lines.length > 0 ? commentLines.length / lines.length : 0;
  }
}

/**
 * Validate TypeScript code against rules
 */
export class TypeScriptValidator {
  constructor(_rules: CodingRule[] = TYPESCRIPT_CODING_RULES) {
    // Allow custom rules to be passed in but not used internally yet
  }

  validate(code: string, filePath?: string): ValidationResult {
    const violations: Violation[] = [];
    const warnings: string[] = [];

    // Check for any type usage
    const anyMatches = Array.from(code.matchAll(/:\s*any(?:\s|$|[,\)])/g));
    for (const match of anyMatches) {
      const line = this.getLineNumber(code, match.index!);
      violations.push({
        rule: 'explicit-types',
        line,
        message: 'Avoid using any type, use explicit types instead',
        severity: 'error',
      });
    }

    // Check for missing return types
    const funcPattern = /(?:function\s+\w+|(?:const|let|var)\s+\w+\s*=\s*(?:async\s+)?(?:\([^)]*\)|[^=]+)\s*=>)[^{]*{/g;
    const funcs = code.match(funcPattern) || [];
    for (const func of funcs) {
      if (!func.includes(':') && !func.includes('void')) {
        warnings.push('Consider adding explicit return types to functions');
        break; // Only warn once
      }
    }

    // Check for synchronous fs usage
    if (code.includes('fs.readFileSync') || code.includes('fs.writeFileSync')) {
      violations.push({
        rule: 'node-fs-promises',
        message: 'Use fs.promises API instead of synchronous fs methods',
        severity: 'warning',
      });
    }

    // Check for JSDoc on exported functions
    const exportPattern = /export\s+(?:async\s+)?function\s+(\w+)/g;
    const exports = Array.from(code.matchAll(exportPattern));
    for (const match of exports) {
      const funcName = match[1];
      const funcIndex = match.index!;
      const beforeFunc = code.slice(Math.max(0, funcIndex - 200), funcIndex);
      if (!beforeFunc.includes('/**')) {
        warnings.push(`Consider adding JSDoc comments for exported function: ${funcName}`);
      }
    }

    // Check comment density
    const commentDensity = this.calculateCommentDensity(code);
    if (commentDensity > 0.25) {
      warnings.push(
        `High comment density (${(commentDensity * 100).toFixed(1)}%). Keep comments minimal and focused on complex logic.`,
      );
    }

    return {
      valid: violations.filter((v) => v.severity === 'error').length === 0,
      file: filePath,
      violations,
      warnings,
    };
  }

  private getLineNumber(code: string, index: number): number {
    return code.slice(0, index).split('\n').length;
  }

  private calculateCommentDensity(code: string): number {
    const lines = code.split('\n');
    const commentLines = lines.filter((line) => {
      const trimmed = line.trim();
      return trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*');
    });
    return lines.length > 0 ? commentLines.length / lines.length : 0;
  }
}

/**
 * Factory function to get appropriate validator
 */
export function getValidator(language: 'python' | 'typescript'): PythonValidator | TypeScriptValidator {
  return language === 'python' ? new PythonValidator() : new TypeScriptValidator();
}

/**
 * Validate a file based on its extension
 */
export async function validateFile(filePath: string): Promise<ValidationResult> {
  const ext = path.extname(filePath);
  const content = await fs.promises.readFile(filePath, 'utf-8');

  if (ext === '.py') {
    const validator = new PythonValidator();
    return validator.validate(content, filePath);
  } else if (ext === '.ts' || ext === '.tsx') {
    const validator = new TypeScriptValidator();
    return validator.validate(content, filePath);
  } else {
    return {
      valid: true,
      file: filePath,
      violations: [],
      warnings: [`Unsupported file type: ${ext}`],
    };
  }
}

/**
 * Validate multiple files
 */
export async function validateFiles(filePaths: string[]): Promise<ValidationResult[]> {
  return Promise.all(filePaths.map(validateFile));
}

/**
 * Format validation results for display
 */
export function formatValidationResults(results: ValidationResult[]): string {
  const output: string[] = [];

  for (const result of results) {
    if (result.violations.length === 0 && result.warnings.length === 0) {
      continue;
    }

    output.push(`\n${result.file || 'Unknown file'}:`);

    for (const violation of result.violations) {
      const location = violation.line ? `:${violation.line}` : '';
      const severity = violation.severity.toUpperCase();
      output.push(`  [${severity}${location}] ${violation.rule}: ${violation.message}`);
    }

    for (const warning of result.warnings) {
      output.push(`  [WARNING] ${warning}`);
    }
  }

  if (output.length === 0) {
    return 'All files passed validation!';
  }

  return output.join('\n');
}
