/**
 * Example usage of the SWE-agent rules module
 */

import {
  getApplicableRules,
  PROJECT_STRUCTURE,
  getComponentByPath,
  exportAllRulesToCursor,
  PythonValidator,
  TypeScriptValidator,
} from './index';

// Example 1: Validate a Python file
async function validatePythonExample() {
  console.log('=== Python Validation Example ===');

  const pythonCode = `
def process_data(data):
    # This function needs type annotations
    with open('data.txt') as f:
        content = f.read()
    return content
`;

  const validator = new PythonValidator();
  const result = validator.validate(pythonCode, 'example.py');

  console.log('Valid:', result.valid);
  console.log('Violations:', result.violations);
  console.log('Warnings:', result.warnings);
}

// Example 2: Validate a TypeScript file
async function validateTypeScriptExample() {
  console.log('\n=== TypeScript Validation Example ===');

  const tsCode = `
function processData(data: unknown) {
  const fs = require('fs');
  const content = fs.readFileSync('data.txt', 'utf-8');
  return content;
}
`;

  const validator = new TypeScriptValidator();
  const result = validator.validate(tsCode, 'example.ts');

  console.log('Valid:', result.valid);
  console.log('Violations:', result.violations);
  console.log('Warnings:', result.warnings);
}

// Example 3: Get project structure information
function projectStructureExample() {
  console.log('\n=== Project Structure Example ===');

  // Get information about a specific component
  const agentInfo = getComponentByPath('sweagent/agent/agents.py');
  console.log('Agent component:', agentInfo);

  // Access project structure directly
  console.log('\nMain entry points:');
  PROJECT_STRUCTURE.mainEntryPoints.forEach((entry) => {
    console.log(`  - ${entry.path}: ${entry.description}`);
  });

  console.log('\nInspectors:');
  PROJECT_STRUCTURE.inspectors.forEach((inspector) => {
    console.log(`  - ${inspector.name} (${inspector.type}): ${inspector.path}`);
  });
}

// Example 4: Get applicable rules for different file types
function rulesExample() {
  console.log('\n=== Rules Example ===');

  console.log('Python rules:');
  const pythonRules = getApplicableRules('example.py');
  pythonRules.forEach((rule) => {
    console.log(`  - ${rule.id}: ${rule.rule}`);
  });

  console.log('\nTypeScript rules:');
  const tsRules = getApplicableRules('example.ts');
  tsRules.forEach((rule) => {
    console.log(`  - ${rule.id}: ${rule.rule}`);
  });
}

// Example 5: Export rules to Cursor IDE format
function exportExample() {
  console.log('\n=== Export Example ===');

  const cursorRules = exportAllRulesToCursor();

  console.log('Exported rules:');
  Object.keys(cursorRules).forEach((filename) => {
    console.log(`  - ${filename} (${cursorRules[filename].length} bytes)`);
  });
}

// Run all examples
async function runExamples() {
  await validatePythonExample();
  await validateTypeScriptExample();
  projectStructureExample();
  rulesExample();
  exportExample();
}

// Execute if run directly
if (require.main === module) {
  runExamples().catch(console.error);
}

export { runExamples };
