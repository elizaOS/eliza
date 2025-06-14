# ElizaOS Plugin Migration System

This module provides a structured migration system for upgrading ElizaOS plugins from version 1 to version 2, following the comprehensive V1_TO_V2_MIGRATION_MEGA_PROMPT_5.md guide.

## Architecture

The migration system follows a step-by-step approach based on the mega prompt structure:

### Core Components

- **`migrator.ts`** - Main `PluginMigrator` class that serves as the entry point
- **`structured-migrator.ts`** - Structured migration orchestrator following the mega prompt phases
- **`migration-step-executor.ts`** - Executes individual migration steps in each phase
- **`mega-prompt-parser.ts`** - Parses and organizes the mega prompt into executable chunks
- **`test-templates.ts`** - Contains exact test file templates for V2 test structure
- **`test-generator.ts`** - **Enhanced test generator with iterative validation and fixing**
- **`types.ts`** - TypeScript interfaces and type definitions
- **`config.ts`** - Configuration constants

### Utilities

- **`repository-analyzer.ts`** - Repository structure analysis
- **`utils.ts`** - Common utility functions (disk space, dependencies, etc.)

### Entry Point

- **`index.ts`** - Main export file for the module

## 🧪 Enhanced Test Generation System

### Overview

The migration tool now features a **comprehensive test generation system** that not only creates tests but **iteratively validates and fixes them until they pass**. This addresses the critical issues with test generation producing syntactically incorrect or non-functional tests.

### Key Features

1. **Proper Variable Substitution** - Fixes malformed template variables like `@elizaosPlugins/alloraPlugin`
2. **Iterative Testing** - Runs build and test cycles, fixing issues automatically
3. **Smart Error Detection** - Recognizes common patterns and applies targeted fixes
4. **Automatic Index.ts Registration** - Ensures test suites are properly registered
5. **Environment Setup** - Creates required .env variables automatically
6. **Build Integration** - Validates builds pass before testing

### Test Generation Process

#### Phase 1: Initial Test Generation
```typescript
const testGenerator = new TestGenerator(context);
const result = await testGenerator.generateComprehensiveTests();
```

**Steps:**
1. **Generate Test Variables** - Extract proper plugin name, variable names, API keys
2. **Create utils.ts** - Copy exact template from proven working examples
3. **Generate test.ts** - Apply dynamic templates with proper variable substitution
4. **Validate Substitution** - Check for remaining template variables and syntax errors

#### Phase 2: Index.ts Integration
```typescript
// Automatically adds to src/index.ts:
import testSuite from "./test/test";

export const myPlugin: Plugin = {
  // ... other config
  tests: [testSuite], // ✅ Automatically registered
};
```

#### Phase 3: Iterative Validation
```typescript
// Up to 5 iterations of:
1. Run `bun run build`
2. If build fails → Fix build errors → Retry
3. If build passes → Run `bun run test`
4. If tests fail → Fix test errors → Retry
5. Continue until both pass or max iterations reached
```

### Common Issues Fixed Automatically

#### 1. Template Variable Syntax Errors
```typescript
// ❌ Broken (what was being generated):
import @elizaosPlugins/alloraPlugin from "../index";
export class @elizaos Plugins/alloraTestSuite implements TestSuite {

// ✅ Fixed (what's now generated):
import alloraPlugin from "../index";
export class AlloraTestSuite implements TestSuite {
```

#### 2. Build Errors
- **Missing test files** → Regenerates test.ts
- **Syntax errors** → Applies regex fixes for common patterns
- **Type errors** → Fixes import statements and type annotations

#### 3. Test Runtime Errors
- **Mock runtime issues** → Regenerates utils.ts with proven template
- **Environment variables** → Creates .env with required keys
- **Zod validation errors** → Fixes coercion issues in config files

#### 4. Import/Export Issues
- **Mixed imports** → Separates type and value imports properly
- **Plugin registration** → Ensures tests are registered in plugin object

### Advanced Error Patterns

The system recognizes and fixes these patterns:

```typescript
// Pattern: Cannot find module from test/test
→ Regenerates missing test files

// Pattern: Declaration or statement expected
→ Fixes syntax errors in generated test content

// Pattern: Cannot read properties of undefined
→ Regenerates mock runtime utilities

// Pattern: Environment variable not found
→ Creates .env with required variables

// Pattern: Expected number, received nan
→ Fixes Zod z.number() → z.coerce.number()
```

## Test Template System

### 1. **Exact utils.ts Template**
The `src/test/utils.ts` file is copied exactly from a proven template that includes:
- Complete mock runtime implementation
- Mock logger with call tracking
- All required IAgentRuntime methods
- Memory management mocks
- Service registration mocks

This file is copied AS-IS to ensure consistency across all migrated plugins.

### 2. **Dynamic test.ts Template**
The `src/test/test.ts` file is generated dynamically based on:
- Plugin name extracted from package.json
- Automatic API key name detection
- Plugin variable naming conventions
- Comprehensive test suite structure

Template variables replaced:
- `{{PLUGIN_NAME}}` - Human-readable plugin name ("Allora", "News", etc.)
- `{{PLUGIN_NAME_LOWER}}` - Lowercase plugin identifier ("allora", "news")
- `{{PLUGIN_VARIABLE}}` - Import variable name ("alloraPlugin", "newsPlugin")
- `{{API_KEY_NAME}}` - Environment variable for API key ("ALLORA_API_KEY")

### 3. **Smart Variable Generation**

The system now uses intelligent variable generation:

```typescript
// For package.json: { "name": "@elizaos/plugin-allora" }
const variables = {
  PLUGIN_NAME: "Allora",           // Human readable
  PLUGIN_NAME_LOWER: "allora",     // Lowercase
  PLUGIN_VARIABLE: "alloraPlugin", // camelCase import
  API_KEY_NAME: "ALLORA_API_KEY"   // ENV variable
};

// Handles edge cases like:
// "plugin-news-cursor" → "newsCursorPlugin"
// "plugin-coinmarketcap" → "coinmarketcapPlugin"
```

## Important: Test Structure

### ElizaOS Test Convention

ElizaOS V2 plugins use a specific test structure that differs from standard test runners:

1. **Test Location**: `src/test/test.ts` (NOT `.test.ts` or `.spec.ts` files)
2. **Test Runner**: ElizaOS custom test framework (`elizaos test`)
3. **Command**: Always use `bun run test` (NOT `bun test`)

### Common Pitfall

❌ **Wrong**: `bun test` - This uses Bun's built-in test runner which expects `.test.ts` files
✅ **Correct**: `bun run test` - This runs the `test` script from package.json which executes `elizaos test`

### Test Structure
```
src/
  test/
    utils.ts    # Mock utilities and test helpers
    test.ts     # Main test suite using ElizaOS test framework
```

The migration tool automatically creates this structure and configures package.json with:
```json
{
  "scripts": {
    "test": "elizaos test"
  }
}
```

## Migration Phases

The system executes migration in these phases, directly from the mega prompt:

1. **File Structure Migration** - Update package.json, remove V1 configs, update build system
2. **Core Structure Migration** - Create Service layer ONLY if it existed in V1
3. **Configuration Migration** - Create Zod-based configuration
4. **Actions Migration** - Centralize actions, fix handlers and memory patterns
5. **Provider Migration** - Update providers to V2 interface
6. **Testing Infrastructure** - Migrate from __tests__/ to src/test/ with enhanced generation
7. **Documentation & Assets** - Create README and required assets
8. **Build & Quality Validation** - Fix imports and run formatters
9. **Final Integration Validation** - Update plugin export structure

## Important Service Rule

**Services are ONLY created if they existed in the original V1 plugin:**
- The migrator checks the main branch for existing service files
- If no service existed in V1, the plugin will have an empty services array
- Services are NOT added just because other plugins have them
- Many plugins work perfectly without services (e.g., API wrapper plugins)

## Key Features

1. **Structured Approach**: Follows the mega prompt step-by-step
2. **Phase-Based Execution**: Clear phases with specific goals
3. **Claude Integration**: Uses Claude for complex code transformations
4. **Validation**: Each step includes validation and error handling
5. **Comprehensive**: Covers all aspects of V1→V2 migration
6. **Automatic Testing**: Runs tests after each fix and iterates until they pass
7. **Post-Migration Verification**: Automatically runs build and tests after migration, fixing issues until they pass

## Usage

```typescript
import { PluginMigrator } from './upgrade/index.js';

const migrator = new PluginMigrator({
  skipTests: false,
  skipValidation: false
});

const result = await migrator.migrate('path/to/plugin');
// or
const result = await migrator.migrate('https://github.com/org/plugin');
```

## Migration Steps

Each phase contains multiple steps that:
- Check if the step is applicable (some are conditional)
- Execute the transformation
- Validate the result
- Report success/failure with clear messages

## Automatic Test Fixing

The migration system now includes comprehensive test automation:

1. **During Migration**: After fixing build errors, tests are immediately run to catch runtime issues
2. **Post-Migration Verification**: After all migration steps complete, the tool runs a verification loop:
   - Runs `bun run build` and fixes any build errors
   - Runs `bun run test` (NOT `bun test`) and analyzes/fixes test failures
   - Detects common issues like Zod validation errors, missing environment variables, etc.
   - Iterates up to 5 times to resolve all issues automatically
3. **Final Status**: Migration only reports success if both build and tests pass

## Critical Patterns Fixed

The system automatically fixes these V1→V2 patterns:
- Import updates (`ModelClass` → `ModelType`, `elizaLogger` → `logger`)
- Type migrations (`Account` → `Entity`, `userId` → `entityId`)
- Handler signatures to V2 format
- Memory creation patterns (`runtime.createMemory()`)
- Provider interfaces to standard format
- Test infrastructure (`__tests__/` → `src/test/`)
- Zod validation errors (uses `z.coerce.number()` for numeric env vars)

## Success Metrics

The migration is considered successful when:
- Clean build with no TypeScript errors
- All imports and exports type correctly
- Service registers and starts correctly
- Actions validate and execute properly
- Tests pass with `elizaos test`
- Memory operations use V2 patterns
- No custom Content fields
- Both `bun run build` and `bun run test` pass without errors

## Benefits

- **Deterministic**: Same input produces same migration result
- **Transparent**: Clear logging of each step and phase
- **Maintainable**: Easy to add new migration steps
- **Debuggable**: Each step can be tested independently
- **Complete**: Follows the entire mega prompt guide
- **Automated**: Minimal manual intervention required - tests are fixed automatically
- **Reliable**: Tests are guaranteed to work after migration completes

## Error Recovery

The enhanced system includes sophisticated error recovery:

1. **Pattern-Based Fixes** - Recognizes common error patterns and applies targeted solutions
2. **Iterative Improvement** - Each iteration learns from previous failures
3. **Fallback Strategies** - Multiple approaches for each type of error
4. **Graceful Degradation** - If automated fixes fail, provides clear manual instructions

## Test Generation Result

The enhanced test generator returns comprehensive results:

```typescript
interface TestGenerationResult {
  success: boolean;
  message: string;
  testsGenerated: number;
  buildPassed: boolean;    // ✅ New: Build validation
  testsPassed: boolean;    // ✅ New: Test validation  
  iterations: number;      // ✅ New: Number of fix iterations
}
```

This ensures full transparency about the test generation and validation process.
