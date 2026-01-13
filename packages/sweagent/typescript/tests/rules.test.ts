/**
 * Tests for the SWE-agent rules module
 */

import {
  PythonValidator,
  TypeScriptValidator,
  getValidator,
  formatValidationResults,
  getApplicableRules,
  PROJECT_STRUCTURE,
  getComponentByPath,
  exportAllRulesToCursor,
  PYTHON_CODING_RULES,
  TYPESCRIPT_CODING_RULES,
  type ValidationResult,
} from '../src/rules';

describe('Rules Module', () => {
  describe('PythonValidator', () => {
    const validator = new PythonValidator();

    test('should detect missing type annotations', () => {
      const code = `
def process_data(data):
    return data * 2
`;
      const result = validator.validate(code, 'test.py');
      expect(result.valid).toBe(false);
      expect(result.violations.some((v) => v.rule === 'python-type-annotations')).toBe(true);
    });

    test('should detect os.path usage', () => {
      const code = `
import os.path

def get_file_path(filename: str) -> str:
    return os.path.join('/tmp', filename)
`;
      const result = validator.validate(code, 'test.py');
      expect(result.valid).toBe(false);
      expect(result.violations.some((v) => v.rule === 'use-pathlib')).toBe(true);
    });

    test('should detect open() without pathlib', () => {
      const code = `
def read_file(filename: str) -> str:
    with open(filename, 'r') as f:
        return f.read()
`;
      const result = validator.validate(code, 'test.py');
      expect(result.valid).toBe(false);
      expect(result.violations.some((v) => v.rule === 'use-pathlib')).toBe(true);
    });

    test('should pass valid Python code', () => {
      const code = `
from pathlib import Path
from typing import List

def read_files(filenames: List[str]) -> List[str]:
    """Read multiple files using pathlib."""
    results = []
    for filename in filenames:
        content = Path(filename).read_text()
        results.append(content)
    return results
`;
      const result = validator.validate(code, 'test.py');
      expect(result.valid).toBe(true);
      expect(result.violations.filter((v) => v.severity === 'error')).toHaveLength(0);
    });
  });

  describe('TypeScriptValidator', () => {
    const validator = new TypeScriptValidator();

    test('should detect any type usage', () => {
      const code = `
function processData(data: any): any {
    return data;
}
`;
      const result = validator.validate(code, 'test.ts');
      expect(result.valid).toBe(false);
      expect(result.violations.some((v) => v.rule === 'explicit-types')).toBe(true);
    });

    test('should detect synchronous fs usage', () => {
      const code = `
import * as fs from 'fs';

function readFile(path: string): string {
    return fs.readFileSync(path, 'utf-8');
}
`;
      const result = validator.validate(code, 'test.ts');
      expect(result.violations.some((v) => v.rule === 'node-fs-promises')).toBe(true);
    });

    test('should pass valid TypeScript code', () => {
      const code = `
import { promises as fs } from 'fs';

/**
 * Read a file asynchronously
 */
export async function readFile(path: string): Promise<string> {
    return await fs.readFile(path, 'utf-8');
}
`;
      const result = validator.validate(code, 'test.ts');
      expect(result.valid).toBe(true);
      expect(result.violations.filter((v) => v.severity === 'error')).toHaveLength(0);
    });
  });

  describe('getValidator', () => {
    test('should return PythonValidator for python', () => {
      const validator = getValidator('python');
      expect(validator).toBeInstanceOf(PythonValidator);
    });

    test('should return TypeScriptValidator for typescript', () => {
      const validator = getValidator('typescript');
      expect(validator).toBeInstanceOf(TypeScriptValidator);
    });
  });

  describe('getApplicableRules', () => {
    test('should return Python rules for .py files', () => {
      const rules = getApplicableRules('test.py');
      expect(rules).toEqual(PYTHON_CODING_RULES);
    });

    test('should return TypeScript rules for .ts files', () => {
      const rules = getApplicableRules('test.ts');
      expect(rules).toEqual(TYPESCRIPT_CODING_RULES);
    });

    test('should use provided language parameter', () => {
      const rules = getApplicableRules('test.txt', 'python');
      expect(rules).toEqual(PYTHON_CODING_RULES);
    });
  });

  describe('Project Structure', () => {
    test('should have correct main entry points', () => {
      expect(PROJECT_STRUCTURE.mainEntryPoints).toHaveLength(2);
      expect(PROJECT_STRUCTURE.mainEntryPoints[0].path).toBe('sweagent/run/run_single.py');
      expect(PROJECT_STRUCTURE.mainEntryPoints[1].path).toBe('sweagent/run/run_batch.py');
    });

    test('should have correct main class', () => {
      expect(PROJECT_STRUCTURE.mainClass.name).toBe('Agent');
      expect(PROJECT_STRUCTURE.mainClass.path).toBe('sweagent/agent/agents.py');
    });

    test('should have correct execution environment', () => {
      expect(PROJECT_STRUCTURE.executionEnvironment.type).toBe('docker');
      expect(PROJECT_STRUCTURE.executionEnvironment.interfaceProject).toBe('SWE-ReX');
    });

    test('should have correct inspectors', () => {
      expect(PROJECT_STRUCTURE.inspectors).toHaveLength(2);
      const cliInspector = PROJECT_STRUCTURE.inspectors.find((i) => i.type === 'cli');
      const webInspector = PROJECT_STRUCTURE.inspectors.find((i) => i.type === 'web');
      expect(cliInspector).toBeDefined();
      expect(webInspector).toBeDefined();
    });
  });

  describe('getComponentByPath', () => {
    test('should return correct component for main agent', () => {
      const component = getComponentByPath('sweagent/agent/agents.py');
      expect(component).not.toBeNull();
      expect(component?.component).toBe('main-agent');
    });

    test('should return correct component for entry point', () => {
      const component = getComponentByPath('sweagent/run/run_single.py');
      expect(component).not.toBeNull();
      expect(component?.component).toBe('entry-point');
    });

    test('should return correct component for tool', () => {
      const component = getComponentByPath('tools/search/search_file');
      expect(component).not.toBeNull();
      expect(component?.component).toBe('tool');
    });

    test('should return null for unknown path', () => {
      const component = getComponentByPath('unknown/path.py');
      expect(component).toBeNull();
    });
  });

  describe('exportAllRulesToCursor', () => {
    test('should export rules in Cursor format', () => {
      const exported = exportAllRulesToCursor();
      expect(Object.keys(exported)).toContain('general.mdc');
      expect(Object.keys(exported)).toContain('project-overview.mdc');
    });

    test('should include frontmatter in exported rules', () => {
      const exported = exportAllRulesToCursor();
      const generalRule = exported['general.mdc'];
      expect(generalRule).toContain('---');
      expect(generalRule).toContain('alwaysApply: true');
    });
  });

  describe('formatValidationResults', () => {
    test('should format empty results correctly', () => {
      const results: ValidationResult[] = [];
      const formatted = formatValidationResults(results);
      expect(formatted).toBe('All files passed validation!');
    });

    test('should format violations correctly', () => {
      const results = [
        {
          valid: false,
          file: 'test.py',
          violations: [
            {
              rule: 'test-rule',
              line: 10,
              message: 'Test violation',
              severity: 'error' as const,
            },
          ],
          warnings: ['Test warning'],
        },
      ];
      const formatted = formatValidationResults(results);
      expect(formatted).toContain('test.py');
      expect(formatted).toContain('[ERROR:10]');
      expect(formatted).toContain('test-rule');
      expect(formatted).toContain('Test violation');
      expect(formatted).toContain('[WARNING]');
      expect(formatted).toContain('Test warning');
    });
  });
});
