# SWE-agent Rules Module

This TypeScript module provides a comprehensive rules system for the SWE-agent project, including coding guidelines, project structure documentation, and validation utilities.

## Overview

The rules module converts the original Cursor IDE rules (`.mdc` files) into a structured TypeScript implementation that can be:
- Programmatically accessed and validated
- Used for code linting and quality checks
- Exported back to Cursor IDE format
- Extended with new rules and validators

## Structure

```
src/rules/
├── types.ts           # TypeScript type definitions for rules
├── general.ts         # General coding guidelines for Python and TypeScript
├── project-overview.ts # Project structure and component information
├── validators.ts      # Code validation utilities
├── config.ts         # Complete rules configuration
├── cli.ts            # Command-line interface for rules
├── index.ts          # Main module exports
└── README.md         # This file
```

## Features

### 1. Type-Safe Rule Definitions

All rules are defined with strict TypeScript types, ensuring consistency and preventing errors:

```typescript
import { CodingRule, ProjectStructure } from './rules/types';
```

### 2. Language-Specific Validators

The module includes validators for both Python and TypeScript:

```typescript
import { PythonValidator, TypeScriptValidator } from './rules/validators';

const pythonValidator = new PythonValidator();
const result = pythonValidator.validate(code, 'example.py');
```

### 3. Project Structure Documentation

Access project structure information programmatically:

```typescript
import { PROJECT_STRUCTURE, getComponentByPath } from './rules/project-overview';

const component = getComponentByPath('sweagent/agent/agents.py');
// Returns: { component: 'main-agent', description: 'Main class that governs agent behavior' }
```

### 4. CLI Tool

A command-line interface for validating files and managing rules:

```bash
# Validate files
npx swe-rules validate src/**/*.ts

# List all rules
npx swe-rules list-rules --language typescript

# Export rules to Cursor IDE format
npx swe-rules export --output .cursor/rules

# Show project information
npx swe-rules info
```

## Usage Examples

### Basic Validation

```typescript
import { validateFile, formatValidationResults } from './rules/validators';

// Validate a single file
const result = await validateFile('path/to/file.py');

// Format results for display
console.log(formatValidationResults([result]));
```

### Get Applicable Rules

```typescript
import { getApplicableRules } from './rules/general';

// Get rules for a Python file
const rules = getApplicableRules('example.py', 'python');
```

### Export to Cursor Format

```typescript
import { exportAllRulesToCursor } from './rules/config';

// Export all rules to Cursor IDE format
const cursorRules = exportAllRulesToCursor();
// Returns: { 'general.mdc': '...', 'project-overview.mdc': '...' }
```

## Validation Rules

### Python Rules
- **python-type-annotations**: Use type annotations in function definitions
- **python-version**: Target Python 3.11 or higher
- **use-pathlib**: Use pathlib instead of os.path
- **use-argparse**: Use argparse for CLI interfaces
- **minimal-comments**: Keep comments minimal and focused
- **no-readme-append**: Don't modify README unless requested

### TypeScript Rules
- **typescript-strict**: Use strict TypeScript configuration
- **explicit-types**: Use explicit type annotations
- **node-fs-promises**: Use fs.promises API
- **commander-or-yargs**: Use commander.js or yargs for CLIs
- **jsdoc-public-api**: Document public APIs with JSDoc

## API Reference

### Types

- `Rule`: Cursor IDE rule structure
- `CodingRule`: Individual coding guideline
- `ProjectStructure`: Project organization information
- `ValidationResult`: Result of code validation
- `Violation`: Specific rule violation

### Validators

- `PythonValidator`: Validates Python code against rules
- `TypeScriptValidator`: Validates TypeScript code against rules
- `getValidator(language)`: Factory function for validators
- `validateFile(path)`: Validates a single file
- `validateFiles(paths)`: Validates multiple files

### Configuration

- `RULES_CONFIG`: Complete rules configuration
- `CURSOR_RULES`: Rules in Cursor IDE format
- `getLanguageConfig(language)`: Get language-specific config

### Utilities

- `getComponentByPath(path)`: Get component info by file path
- `getPythonModules()`: List all Python modules
- `exportToCursorFormat(rule)`: Convert rule to Cursor format

## Integration

To integrate this module into your workflow:

1. **Import the module**:
   ```typescript
   import * as rules from './rules';
   ```

2. **Use in pre-commit hooks**:
   ```bash
   npx swe-rules validate --strict
   ```

3. **Add to CI/CD pipeline**:
   ```yaml
   - name: Validate Code Rules
     run: npx swe-rules validate src/**/*.ts --strict
   ```

4. **Extend with custom rules**:
   ```typescript
   import { CodingRule } from './rules/types';
   
   const customRule: CodingRule = {
     id: 'custom-rule',
     category: 'style',
     rule: 'Custom rule description',
     enforcement: 'required'
   };
   ```

## Development

To extend or modify the rules:

1. Add new rule definitions in `general.ts` or create new rule files
2. Update validators in `validators.ts` to check for new rules
3. Add new commands to `cli.ts` as needed
4. Update types in `types.ts` for new rule structures

## License

Part of the SWE-agent project. See main project LICENSE for details.
