/**
 * General coding guidelines project
 */

import { CodingGuidelines, CodingRule } from './types';

/**
 * Python coding rules (original project language)
 */
export const PYTHON_CODING_RULES: CodingRule[] = [
  {
    id: 'python-type-annotations',
    category: 'style',
    rule: 'Use python with type annotations',
    enforcement: 'required',
  },
  {
    id: 'python-version',
    category: 'style',
    rule: 'Target python 3.11 or higher',
    enforcement: 'required',
  },
  {
    id: 'use-pathlib',
    category: 'filesystem',
    rule: 'Use pathlib instead of os.path',
    enforcement: 'required',
    alternatives: ['Path.read_text() over with...open() constructs'],
  },
  {
    id: 'use-argparse',
    category: 'api',
    rule: 'Use argparse to add interfaces',
    enforcement: 'required',
  },
  {
    id: 'minimal-comments',
    category: 'documentation',
    rule: 'Keep code comments to a minimum and only highlight particularly logically challenging things',
    enforcement: 'recommended',
  },
  {
    id: 'no-readme-append',
    category: 'documentation',
    rule: 'Do not append to the README unless specifically requested',
    enforcement: 'required',
  },
];

/**
 * TypeScript coding rules (for converted modules)
 */
export const TYPESCRIPT_CODING_RULES: CodingRule[] = [
  {
    id: 'typescript-strict',
    category: 'style',
    rule: 'Use strict TypeScript configuration',
    enforcement: 'required',
  },
  {
    id: 'explicit-types',
    category: 'style',
    rule: 'Use explicit type annotations for function parameters and return types',
    enforcement: 'required',
  },
  {
    id: 'node-fs-promises',
    category: 'filesystem',
    rule: 'Use fs.promises API for file operations',
    enforcement: 'required',
    alternatives: ['fs/promises module'],
  },
  {
    id: 'commander-or-yargs',
    category: 'api',
    rule: 'Use commander.js or yargs for CLI interfaces',
    enforcement: 'recommended',
    alternatives: ['commander', 'yargs'],
  },
  {
    id: 'minimal-comments',
    category: 'documentation',
    rule: 'Keep code comments to a minimum and only highlight particularly logically challenging things',
    enforcement: 'recommended',
  },
  {
    id: 'jsdoc-public-api',
    category: 'documentation',
    rule: 'Use JSDoc comments for public APIs and exported functions',
    enforcement: 'recommended',
  },
];

/**
 * General coding guidelines configuration
 */
export const GENERAL_CODING_GUIDELINES: CodingGuidelines = {
  language: 'python',
  version: '3.11',
  rules: PYTHON_CODING_RULES,
};

/**
 * TypeScript coding guidelines configuration
 */
export const TYPESCRIPT_CODING_GUIDELINES: CodingGuidelines = {
  language: 'typescript',
  version: '5.0',
  rules: TYPESCRIPT_CODING_RULES,
};

/**
 * Helper function to validate code against rules
 */
export function validateAgainstRules(
  code: string,
  guidelines: CodingGuidelines,
): { valid: boolean; violations: string[] } {
  const violations: string[] = [];

  // Basic validation examples (extend as needed)
  if (guidelines.language === 'python') {
    // Check for os.path usage
    if (code.includes('os.path') && !code.includes('pathlib')) {
      violations.push('Use pathlib instead of os.path');
    }

    // Check for open() without pathlib
    if (code.match(/with\s+open\s*\(/) && !code.includes('Path')) {
      violations.push('Use Path.read_text() over with...open() constructs');
    }
  }

  if (guidelines.language === 'typescript') {
    // Check for any type usage
    if (code.match(/:\s*any(?:\s|$|,|\))/)) {
      violations.push('Avoid using any type, use explicit types instead');
    }
  }

  return {
    valid: violations.length === 0,
    violations,
  };
}

/**
 * Get applicable rules for a file
 */
export function getApplicableRules(filePath: string, language?: 'python' | 'typescript'): CodingRule[] {
  const lang = language || (filePath.endsWith('.py') ? 'python' : 'typescript');
  return lang === 'python' ? PYTHON_CODING_RULES : TYPESCRIPT_CODING_RULES;
}
