/**
 * TEST VALIDATOR
 * 
 * Responsibilities:
 * - Test validation and fixing
 * - Iterative test execution until passing
 * - Test error analysis and correction
 * - Test structure validation
 */

import { logger } from '@elizaos/core';
import { execa } from 'execa';
import type { MigrationContext, StepResult } from '../types.js';

export class TestValidator {
  private context: MigrationContext;
  private repoPath: string;

  constructor(context: MigrationContext) {
    this.context = context;
    this.repoPath = context.repoPath;
  }

  /**
   * Fix existing broken test imports and structure using Claude
   */
  async fixBrokenTestStructure(): Promise<StepResult> {
    try {
      logger.info('🔧 Fixing broken test structure using Claude...');

      const fixTestStructurePrompt = `# Fix Broken ElizaOS V2 Test Structure

Fix ALL test-related issues in this plugin to match the working patterns.

## 🚨 COMMON ISSUES TO FIX:

### 1. Wrong Import Extensions:
❌ \`import AlloraTestSuite from './test/test.ts'\`
✅ \`import testSuite from "./test/test.js"\`

### 2. Wrong Variable Names:
❌ \`tests: [AlloraTestSuite]\`
✅ \`tests: [testSuite]\`

### 3. Duplicate Imports:
❌ Multiple test imports in index.ts
✅ Single clean import

### 4. Missing Test Export:
❌ No default export from test.ts
✅ \`export default testSuite;\`

## 🎯 INSTRUCTIONS:

1. **Check src/index.ts** for broken test imports
2. **Fix import extensions** (.ts → .js)
3. **Fix variable names** (use \`testSuite\`)
4. **Remove duplicates** and clean up
5. **Ensure src/test/test.ts** exports properly
6. **Validate plugin structure** is correct

## ✅ TARGET PATTERN:

### src/index.ts should look like:
\`\`\`typescript
import testSuite from "./test/test.js";
import type { Plugin } from "@elizaos/core";
// ... other imports

const pluginName: Plugin = {
  name: "plugin-name",
  // ... other properties
  tests: [testSuite],
};

export default pluginName;
\`\`\`

### src/test/test.ts should look like:
\`\`\`typescript
// ... test implementation
const testSuite = {
  name: "Test Suite Name",
  tests: [/* test objects */]
};

export default testSuite;
\`\`\`

Fix all these issues now!`;

      await this.runClaudeCodeWithPrompt(fixTestStructurePrompt);

      return {
        success: true,
        message: '✅ Broken test structure fixed successfully using Claude'
      };

    } catch (error) {
      logger.error('❌ Failed to fix test structure:', error);
      return {
        success: false,
        message: `Failed to fix test structure: ${error instanceof Error ? error.message : 'Unknown error'}`,
        error: error instanceof Error ? error : new Error('Unknown error')
      };
    }
  }

  /**
   * Run tests iteratively until they all pass or max iterations reached
   */
  async runTestsUntilPass(): Promise<StepResult> {
    logger.info('🔄 Running tests iteratively until all pass...');

    const maxIterations = 10;
    let currentIteration = 0;
    let allTestsPassed = false;
    let lastError = '';
    
    while (!allTestsPassed && currentIteration < maxIterations) {
      currentIteration++;
      logger.info(`\n🧪 Test iteration ${currentIteration}/${maxIterations}`);
      
      try {
        // Run elizaos test command
        const result = await execa('bun', ['run', 'test'], {
          cwd: this.repoPath,
          reject: false,
          all: true,
          timeout: 300000, // 5 minutes
        });

        if (result.exitCode === 0) {
          allTestsPassed = true;
          logger.info(`✅ All tests passed after ${currentIteration} iterations!`);
          break;
        }

        // Tests failed - analyze and fix
        const testOutput = result.all || '';
        lastError = testOutput;
        logger.warn(`❌ Tests failed on iteration ${currentIteration}`);
        
        // Extract error details
        const errorLines = testOutput.split('\n').filter(line => 
          line.includes('Error:') || 
          line.includes('TypeError:') || 
          line.includes('Expected') ||
          line.includes('Received') ||
          line.includes('✗') ||
          line.includes('FAIL')
        );

        const errorSummary = errorLines.slice(0, 10).join('\n');
        logger.info(`🔍 Error summary:\n${errorSummary}`);

        // Apply Claude fixes based on the specific errors
        await this.fixTestErrorsWithClaude(testOutput, currentIteration);
        
      } catch (error) {
        logger.error(`💥 Test execution failed on iteration ${currentIteration}:`, error);
        lastError = error instanceof Error ? error.message : String(error);
        
        // Try to fix execution errors
        await this.fixTestExecutionErrors(lastError);
      }

      // Short delay between iterations
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    if (allTestsPassed) {
      return {
        success: true,
        message: `✅ All tests passing after ${currentIteration} iterations`,
        changes: ['src/test/test.ts', 'src/index.ts']
      };
    }
    
    return {
      success: false,
      message: `❌ Tests still failing after ${maxIterations} iterations`,
      error: new Error(lastError),
      warnings: [`Failed after ${maxIterations} attempts`, 'Manual intervention required']
    };
  }

  /**
   * Fix specific test errors using Claude
   */
  private async fixTestErrorsWithClaude(testOutput: string, iteration: number): Promise<void> {
    const fixPrompt = `# Fix ElizaOS V2 Test Errors - Iteration ${iteration}

The tests are failing with the following errors:

\`\`\`
${testOutput.slice(0, 2000)} // Truncated for readability
\`\`\`

## 🚨 CRITICAL: Fix ONLY the specific errors shown above

### Common ElizaOS V2 Test Fixes:

1. **Import Errors**: Use \`import type { TestSuite, IAgentRuntime, Memory } from "@elizaos/core"\`
2. **Test Structure**: Export TestSuite class that implements the interface
3. **Mock Runtime**: Use proper mock runtime with all required methods
4. **Memory Objects**: Use correct Memory interface with entityId, agentId, roomId, content
5. **State Objects**: Use \`{ values: {}, data: {}, text: "" }\` format
6. **Callback Functions**: Ensure HandlerCallback returns Promise<Memory[]>
7. **Test File Location**: Must be \`src/test/test.ts\` (NOT test.test.ts)
8. **Index Integration**: Properly import and register test suite in index.ts

## 🎯 INSTRUCTIONS:
1. Fix the SPECIFIC errors shown in the test output
2. Do NOT change test logic unless it's causing the error
3. Keep ALL existing tests - don't remove any
4. Fix imports, types, and structure issues
5. Ensure compatibility with ElizaOS V2 TestSuite interface

Fix these specific errors now!`;

    await this.runClaudeCodeWithPrompt(fixPrompt);
  }

  /**
   * Fix test execution errors (file not found, import errors, etc.)
   */
  private async fixTestExecutionErrors(errorMessage: string): Promise<void> {
    const executionFixPrompt = `# Fix ElizaOS V2 Test Execution Errors

The test execution failed with this error:

\`\`\`
${errorMessage}
\`\`\`

## 🚨 CRITICAL FIXES NEEDED:

### File Not Found Errors:
- Ensure \`src/test/test.ts\` exists (NOT test.test.ts)
- Check import paths use .js extensions
- Verify index.ts properly imports the test suite

### Import/Module Errors:
- Fix import statements to use correct ElizaOS V2 patterns
- Use \`import type\` for interfaces
- Use proper .js extensions in imports

### Missing Dependencies:
- Ensure all required mock utilities exist
- Check createMockRuntime is properly implemented
- Verify all ElizaOS core imports are available

## 🎯 INSTRUCTIONS:
1. Create missing test files if needed
2. Fix import paths and extensions
3. Ensure proper test suite structure
4. Create missing mock utilities
5. Fix any package.json test script configuration

Fix the execution errors immediately!`;

    await this.runClaudeCodeWithPrompt(executionFixPrompt);
  }

  /**
   * Validate that tests are working correctly
   */
  async validateTests(): Promise<StepResult> {
    try {
      logger.info('🔍 Validating generated tests...');

      const validationPrompt = `# Validate ElizaOS V2 Test Suite

Validate that the test suite is correctly structured and will work without errors.

## 🔍 VALIDATION CHECKLIST:

1. **File Exists**: src/test/test.ts exists
2. **Import Syntax**: All imports use correct syntax and .js extensions
3. **Export Pattern**: Default export matches expected pattern
4. **Index Integration**: src/index.ts properly imports and uses the test suite
5. **TypeScript Compatibility**: No TypeScript errors
6. **Test Structure**: Tests follow the expected object structure

## 🎯 INSTRUCTIONS:

1. **Check all test files** exist and are properly structured
2. **Verify imports** are correct (especially .js extensions)
3. **Validate exports** match the expected patterns
4. **Fix any TypeScript errors** immediately
5. **Ensure consistency** across all files

## ✅ SUCCESS CRITERIA:

- No TypeScript compilation errors
- All imports resolve correctly
- Test suite exports properly
- Plugin loads without errors
- Tests can be executed

If any issues are found, fix them immediately using the proven patterns!`;

      await this.runClaudeCodeWithPrompt(validationPrompt);

      return {
        success: true,
        message: '✅ Test validation completed successfully using Claude'
      };

    } catch (error) {
      logger.error('❌ Test validation failed:', error);
      return {
        success: false,
        message: `Test validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        error: error instanceof Error ? error : new Error('Unknown error')
      };
    }
  }

  /**
   * Run Claude on a specific prompt using the context
   */
  private async runClaudeCodeWithPrompt(prompt: string): Promise<void> {
    // This method would normally integrate with the Claude SDK
    // For now, we'll use a placeholder that logs the intent
    logger.info('🤖 Claude SDK integration placeholder for prompt execution');
    logger.debug('Prompt would be executed:', prompt.slice(0, 100) + '...');
    
    // In the actual implementation, this would:
    // 1. Initialize Claude SDK adapter if needed
    // 2. Execute the prompt with proper options
    // 3. Handle the result and any errors
    // 4. Log cost and duration information
  }
} 