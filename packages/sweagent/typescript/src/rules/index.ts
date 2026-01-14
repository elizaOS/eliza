/**
 * Main rules module
 * Exports all rule configurations, validators, and utilities
 */

// Configuration exports
export {
  CURSOR_RULES,
  exportAllRulesToCursor,
  exportToCursorFormat,
  RULES_CONFIG,
} from "./config";

// General coding rules
export {
  GENERAL_CODING_GUIDELINES,
  getApplicableRules,
  PYTHON_CODING_RULES,
  TYPESCRIPT_CODING_GUIDELINES,
  TYPESCRIPT_CODING_RULES,
  validateAgainstRules,
} from "./general";

// Project structure and overview
export {
  ENTRY_POINTS,
  EXECUTION_ENVIRONMENT,
  getComponentByPath,
  getPythonModules,
  INSPECTORS,
  MAIN_AGENT_CLASS,
  PROJECT_OVERVIEW,
  PROJECT_STRUCTURE,
  SWE_ENV_CLASS,
  TOOLS_INFO,
  TYPESCRIPT_EQUIVALENTS,
} from "./project-overview";
// Type exports
export * from "./types";
// Validators
export {
  formatValidationResults,
  getValidator,
  PythonValidator,
  TypeScriptValidator,
  type ValidationResult,
  type Violation,
  validateFile,
  validateFiles,
} from "./validators";

import { RULES_CONFIG } from "./config";
import { getApplicableRules } from "./general";
import { getComponentByPath } from "./project-overview";
import {
  PythonValidator,
  TypeScriptValidator,
  validateFile,
} from "./validators";

/**
 * Default export with all rules and utilities
 */
export default {
  config: RULES_CONFIG,
  validators: {
    python: new PythonValidator(),
    typescript: new TypeScriptValidator(),
  },
  utils: {
    getComponentByPath,
    getApplicableRules,
    validateFile,
  },
};
