/**
 * Tests for the SWE-agent rules module
 */

import { describe, expect, it } from "vitest";
import {
  exportAllRulesToCursor,
  formatValidationResults,
  getApplicableRules,
  getComponentByPath,
  getValidator,
  PROJECT_STRUCTURE,
  PYTHON_CODING_RULES,
  PythonValidator,
  TYPESCRIPT_CODING_RULES,
  TypeScriptValidator,
  type ValidationResult,
} from "../src/rules";

describe("Rules Module", () => {
  describe("PythonValidator", () => {
    const validator = new PythonValidator();

    it("should detect missing type annotations", () => {
      const code = `
def process_data(data):
    return data * 2
`;
      const result = validator.validate(code, "test.py");
      expect(result.valid).toBe(false);
      expect(
        result.violations.some((v) => v.rule === "python-type-annotations"),
      ).toBe(true);
    });

    it("should detect os.path usage", () => {
      const code = `
import os.path

def get_file_path(filename: str) -> str:
    return os.path.join('/tmp', filename)
`;
      const result = validator.validate(code, "test.py");
      expect(result.valid).toBe(false);
      expect(result.violations.some((v) => v.rule === "use-pathlib")).toBe(
        true,
      );
    });

    it("should detect open() without pathlib", () => {
      const code = `
def read_file(filename: str) -> str:
    with open(filename, 'r') as f:
        return f.read()
`;
      const result = validator.validate(code, "test.py");
      expect(result.valid).toBe(false);
      expect(result.violations.some((v) => v.rule === "use-pathlib")).toBe(
        true,
      );
    });

    it("should pass valid Python code", () => {
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
      const result = validator.validate(code, "test.py");
      expect(result.valid).toBe(true);
      expect(
        result.violations.filter((v) => v.severity === "error"),
      ).toHaveLength(0);
    });
  });

  describe("TypeScriptValidator", () => {
    const validator = new TypeScriptValidator();

    it("should detect any type usage", () => {
      const code = `
function processData(data: any): any {
    return data;
}
`;
      const result = validator.validate(code, "test.ts");
      expect(result.valid).toBe(false);
      expect(result.violations.some((v) => v.rule === "explicit-types")).toBe(
        true,
      );
    });

    it("should detect synchronous fs usage", () => {
      const code = `
import * as fs from 'fs';

function readFile(path: string): string {
    return fs.readFileSync(path, 'utf-8');
}
`;
      const result = validator.validate(code, "test.ts");
      expect(result.violations.some((v) => v.rule === "node-fs-promises")).toBe(
        true,
      );
    });

    it("should pass valid TypeScript code", () => {
      const code = `
import { promises as fs } from 'fs';

/**
 * Read a file asynchronously
 */
export async function readFile(path: string): Promise<string> {
    return await fs.readFile(path, 'utf-8');
}
`;
      const result = validator.validate(code, "test.ts");
      expect(result.valid).toBe(true);
      expect(
        result.violations.filter((v) => v.severity === "error"),
      ).toHaveLength(0);
    });
  });

  describe("getValidator", () => {
    it("should return PythonValidator for python", () => {
      const validator = getValidator("python");
      expect(validator).toBeInstanceOf(PythonValidator);
    });

    it("should return TypeScriptValidator for typescript", () => {
      const validator = getValidator("typescript");
      expect(validator).toBeInstanceOf(TypeScriptValidator);
    });
  });

  describe("getApplicableRules", () => {
    it("should return Python rules for .py files", () => {
      const rules = getApplicableRules("test.py");
      expect(rules).toEqual(PYTHON_CODING_RULES);
    });

    it("should return TypeScript rules for .ts files", () => {
      const rules = getApplicableRules("test.ts");
      expect(rules).toEqual(TYPESCRIPT_CODING_RULES);
    });

    it("should use provided language parameter", () => {
      const rules = getApplicableRules("test.txt", "python");
      expect(rules).toEqual(PYTHON_CODING_RULES);
    });
  });

  describe("Project Structure", () => {
    it("should have correct main entry points", () => {
      expect(PROJECT_STRUCTURE.mainEntryPoints).toHaveLength(2);
      expect(PROJECT_STRUCTURE.mainEntryPoints[0].path).toBe(
        "sweagent/run/run_single.py",
      );
      expect(PROJECT_STRUCTURE.mainEntryPoints[1].path).toBe(
        "sweagent/run/run_batch.py",
      );
    });

    it("should have correct main class", () => {
      expect(PROJECT_STRUCTURE.mainClass.name).toBe("Agent");
      expect(PROJECT_STRUCTURE.mainClass.path).toBe("sweagent/agent/agents.py");
    });

    it("should have correct execution environment", () => {
      expect(PROJECT_STRUCTURE.executionEnvironment.type).toBe("docker");
      expect(PROJECT_STRUCTURE.executionEnvironment.interfaceProject).toBe(
        "SWE-ReX",
      );
    });

    it("should have correct inspectors", () => {
      expect(PROJECT_STRUCTURE.inspectors).toHaveLength(2);
      const cliInspector = PROJECT_STRUCTURE.inspectors.find(
        (i) => i.type === "cli",
      );
      const webInspector = PROJECT_STRUCTURE.inspectors.find(
        (i) => i.type === "web",
      );
      expect(cliInspector).toBeDefined();
      expect(webInspector).toBeDefined();
    });
  });

  describe("getComponentByPath", () => {
    it("should return correct component for main agent", () => {
      const component = getComponentByPath("sweagent/agent/agents.py");
      expect(component).not.toBeNull();
      expect(component?.component).toBe("main-agent");
    });

    it("should return correct component for entry point", () => {
      const component = getComponentByPath("sweagent/run/run_single.py");
      expect(component).not.toBeNull();
      expect(component?.component).toBe("entry-point");
    });

    it("should return correct component for tool", () => {
      const component = getComponentByPath("tools/search/search_file");
      expect(component).not.toBeNull();
      expect(component?.component).toBe("tool");
    });

    it("should return null for unknown path", () => {
      const component = getComponentByPath("unknown/path.py");
      expect(component).toBeNull();
    });
  });

  describe("exportAllRulesToCursor", () => {
    it("should export rules in Cursor format", () => {
      const exported = exportAllRulesToCursor();
      expect(Object.keys(exported)).toContain("general.mdc");
      expect(Object.keys(exported)).toContain("project-overview.mdc");
    });

    it("should include frontmatter in exported rules", () => {
      const exported = exportAllRulesToCursor();
      const generalRule = exported["general.mdc"];
      expect(generalRule).toContain("---");
      expect(generalRule).toContain("alwaysApply: true");
    });
  });

  describe("formatValidationResults", () => {
    it("should format empty results correctly", () => {
      const results: ValidationResult[] = [];
      const formatted = formatValidationResults(results);
      expect(formatted).toBe("All files passed validation!");
    });

    it("should format violations correctly", () => {
      const results = [
        {
          valid: false,
          file: "test.py",
          violations: [
            {
              rule: "test-rule",
              line: 10,
              message: "Test violation",
              severity: "error" as const,
            },
          ],
          warnings: ["Test warning"],
        },
      ];
      const formatted = formatValidationResults(results);
      expect(formatted).toContain("test.py");
      expect(formatted).toContain("[ERROR:10]");
      expect(formatted).toContain("test-rule");
      expect(formatted).toContain("Test violation");
      expect(formatted).toContain("[WARNING]");
      expect(formatted).toContain("Test warning");
    });
  });
});
