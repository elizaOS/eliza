import { logger } from '@elizaos/core';
import { execa } from 'execa';
import * as fs from 'fs-extra';
import * as path from 'node:path';
import type { MigrationContext } from '../types.js';
import { ClaudeIntegration } from './claude-integration.js';

/**
 * Error analysis and automated fixing
 */
export class ErrorAnalyzer {
  private claudeIntegration: ClaudeIntegration;

  constructor(private repoPath: string) {
    this.claudeIntegration = new ClaudeIntegration(repoPath);
  }

  /**
   * Analyze build errors and apply fixes
   */
  async analyzeBuildErrorsAndFix(context: MigrationContext): Promise<void> {
    try {
      // Run build and capture errors
      const result = await execa('bun', ['run', 'build'], {
        cwd: this.repoPath,
        reject: false,
        all: true,
      });

      if (result.exitCode !== 0 && result.all) {
        logger.info('📋 Analyzing build errors with enhanced patterns...');

        const buildErrors = result.all;
        const errorAnalysis = this.analyzeBuildErrorsWithPatterns(buildErrors);

        // Create a focused prompt for fixing build errors
        const buildFixPrompt = `# Fix ElizaOS V2 Plugin Build Errors - Enhanced Analysis

The ${context.pluginName} plugin has the following build errors:

\`\`\`
${buildErrors}
\`\`\`

## Detected Error Types:
${errorAnalysis.detectedTypes.map((type) => `- ${type.type}: ${type.description}`).join('\n')}

## Suggested Fixes:
${errorAnalysis.suggestedFixes.join('\n')}

CRITICAL INSTRUCTION: Fix ONLY the specific errors shown above.

### Most Common Fixes:
1. **Import Errors**:
   - Replace \`ModelClass\` with \`ModelType\`
   - Replace \`elizaLogger\` with \`logger\`
   - Use \`import type\` for interfaces

2. **Handler Signature**:
   \`\`\`typescript
   handler: async (
     runtime: IAgentRuntime,
     message: Memory,
     state: State,
     _options: { [key: string]: unknown },
     callback: HandlerCallback
   ) => {
     // implementation
   }
   \`\`\`

3. **Service Pattern** (ONLY if service existed in V1):
   \`\`\`typescript
   export class MyService extends Service {
     static serviceType = 'my-service';
     static async start(runtime: IAgentRuntime) {
       return new MyService(runtime);
     }
     async stop(): Promise<void> {}
   }
   \`\`\`

4. **Memory Creation**:
   \`\`\`typescript
   await runtime.createMemory({
     id: createUniqueUuid(runtime, \`action-\${Date.now()}\`),
     entityId: message.entityId,
     agentId: runtime.agentId,
     roomId: message.roomId,
     content: { text: result, source: 'plugin-name' },
     createdAt: Date.now()
   }, 'messages');
   \`\`\`

Fix these specific build errors while preserving all existing functionality.`;

        // Use Claude to fix the build errors
        await this.claudeIntegration.runClaudeWithPrompt(buildFixPrompt);

        logger.info('✅ Build error analysis and fixes applied');
      }
    } catch (error) {
      logger.error('❌ Build error analysis failed:', error);
    }
  }

  /**
   * Analyze build errors with enhanced pattern detection
   */
  analyzeBuildErrorsWithPatterns(buildErrors: string): {
    detectedTypes: Array<{ type: string; description: string }>;
    suggestedFixes: string[];
  } {
    const detectedTypes: Array<{ type: string; description: string }> = [];
    const suggestedFixes: string[] = [];

    // Import-related errors
    if (
      buildErrors.includes('ModelClass') ||
      buildErrors.includes("Cannot find name 'ModelClass'")
    ) {
      detectedTypes.push({
        type: 'Import Error',
        description: 'ModelClass is not available in V2, should be ModelType',
      });
      suggestedFixes.push('- Replace all instances of `ModelClass` with `ModelType`');
    }

    if (
      buildErrors.includes('elizaLogger') ||
      buildErrors.includes("Cannot find name 'elizaLogger'")
    ) {
      detectedTypes.push({
        type: 'Import Error',
        description: 'elizaLogger is not available in V2, should be logger',
      });
      suggestedFixes.push('- Replace all instances of `elizaLogger` with `logger`');
    }

    if (
      buildErrors.includes('composeContext') ||
      buildErrors.includes("Cannot find name 'composeContext'")
    ) {
      detectedTypes.push({
        type: 'Import Error',
        description: 'composeContext is not available in V2, should be composePromptFromState',
      });
      suggestedFixes.push('- Replace `composeContext` with `composePromptFromState`');
    }

    if (
      buildErrors.includes('generateObjectDeprecated') ||
      buildErrors.includes("Cannot find name 'generateObjectDeprecated'")
    ) {
      detectedTypes.push({
        type: 'Import Error',
        description: 'generateObjectDeprecated removed in V2, use runtime.useModel',
      });
      suggestedFixes.push(
        '- Replace `generateObjectDeprecated` with `runtime.useModel(ModelType.TEXT_LARGE, {prompt})`'
      );
    }

    if (
      buildErrors.includes('generateObject') ||
      buildErrors.includes("Cannot find name 'generateObject'")
    ) {
      detectedTypes.push({
        type: 'Import Error',
        description: 'generateObject removed in V2, use runtime.useModel',
      });
      suggestedFixes.push(
        '- Replace `generateObject` with `runtime.useModel(ModelType.OBJECT_GENERATION, {prompt, schema})`'
      );
    }

    // Type-related errors
    if (buildErrors.includes('type-only import') || buildErrors.includes('import type')) {
      detectedTypes.push({
        type: 'Type Import Error',
        description: 'Mixing value and type imports from @elizaos/core',
      });
      suggestedFixes.push(
        '- Separate type imports: `import type { ... }` and value imports: `import { ... }`'
      );
    }

    // Handler signature errors
    if (buildErrors.includes('Promise<boolean>') || buildErrors.includes('handler')) {
      detectedTypes.push({
        type: 'Handler Signature Error',
        description: 'V1 handler signature is incompatible with V2',
      });
      suggestedFixes.push('- Update handler to use V2 signature with callback pattern');
    }

    // Service-related errors
    if (buildErrors.includes('ServiceType') || buildErrors.includes('service')) {
      detectedTypes.push({
        type: 'Service Error',
        description: 'V1 service pattern needs to be updated to V2 class-based pattern',
      });
      suggestedFixes.push('- Convert service to V2 class extending Service');
    }

    // Memory API errors
    if (buildErrors.includes('messageManager') || buildErrors.includes('memory.create')) {
      detectedTypes.push({
        type: 'Memory API Error',
        description: 'V1 memory APIs are not available in V2',
      });
      suggestedFixes.push('- Use runtime.createMemory() instead of old memory APIs');
    }

    // Content structure errors
    if (buildErrors.includes('Content') && buildErrors.includes('action')) {
      detectedTypes.push({
        type: 'Content Structure Error',
        description: 'V2 Content interface has different structure',
      });
      suggestedFixes.push('- Ensure Content only has `text` and `source` fields');
    }

    // State structure errors
    if (
      buildErrors.includes('state.') &&
      (buildErrors.includes('Property') || buildErrors.includes('does not exist'))
    ) {
      detectedTypes.push({
        type: 'State Structure Error',
        description: 'V2 State structure requires access via state.values or state.data',
      });
      suggestedFixes.push(
        '- Access state data via `state.values.propertyName` or `state.data.propertyName`'
      );
    }

    // Specific state property errors
    if (
      buildErrors.includes('state.tokenA') ||
      buildErrors.includes('state.amount') ||
      buildErrors.includes('state.fromChain') ||
      buildErrors.includes('state.proposalId') ||
      buildErrors.includes('state.tokenId') ||
      buildErrors.includes('state.walletAddress')
    ) {
      detectedTypes.push({
        type: 'Direct State Access Error',
        description: 'Direct state property access should use state.values for simple values',
      });
      suggestedFixes.push(
        '- Replace `state.tokenA` with `state.values.tokenA`, `state.amount` with `state.values.amount`, etc.'
      );
    }

    if (
      buildErrors.includes('state.slippage') ||
      buildErrors.includes('state.balances') ||
      buildErrors.includes('state.validator')
    ) {
      detectedTypes.push({
        type: 'Complex State Access Error',
        description: 'Complex state data should use state.data for objects',
      });
      suggestedFixes.push(
        '- Replace `state.slippage` with `state.data.slippage`, `state.balances` with `state.data.balances`, etc.'
      );
    }

    // ActionExample structure errors
    if (buildErrors.includes('user') && buildErrors.includes('ActionExample')) {
      detectedTypes.push({
        type: 'ActionExample Error',
        description: 'V2 ActionExample uses name field instead of user field',
      });
      suggestedFixes.push('- Replace `user` field with `name` field in ActionExample objects');
    }

    // Content interface errors
    if (buildErrors.includes('action') && buildErrors.includes('Content')) {
      detectedTypes.push({
        type: 'Content Interface Error',
        description: 'V2 Content interface uses actions array instead of single action field',
      });
      suggestedFixes.push(
        '- Replace `action: "ACTION_NAME"` with `actions: ["ACTION_NAME"]` in Content objects'
      );
    }

    // Handler signature errors (enhanced)
    if (buildErrors.includes('responses') && buildErrors.includes('handler')) {
      detectedTypes.push({
        type: 'Handler Parameter Error',
        description: 'V2 handlers require responses: Memory[] parameter',
      });
      suggestedFixes.push('- Add `responses: Memory[]` parameter to handler signature');
    }

    if (buildErrors.includes('State | undefined') && buildErrors.includes('handler')) {
      detectedTypes.push({
        type: 'Handler State Error',
        description: 'V2 handlers receive state as required parameter, not optional',
      });
      suggestedFixes.push(
        '- Change `state: State | undefined` to `state: State` in handler signature'
      );
    }

    // Handler return type errors
    if (buildErrors.includes('Promise<boolean>') && buildErrors.includes('handler')) {
      detectedTypes.push({
        type: 'Handler Return Type Error',
        description: 'V2 handlers do not return Promise<boolean>',
      });
      suggestedFixes.push('- Remove Promise<boolean> return type from handler functions');
    }

    // Memory API errors (enhanced)
    if (buildErrors.includes('updateRecentMessageState')) {
      detectedTypes.push({
        type: 'Runtime API Error',
        description: 'updateRecentMessageState removed in V2',
      });
      suggestedFixes.push('- Remove updateRecentMessageState calls - not needed in V2');
    }

    if (buildErrors.includes('messageManager.createMemory')) {
      detectedTypes.push({
        type: 'Memory Manager Error',
        description: 'messageManager.createMemory removed in V2',
      });
      suggestedFixes.push(
        '- Replace `runtime.messageManager.createMemory` with `runtime.createMemory`'
      );
    }

    // Module resolution errors
    if (buildErrors.includes('Cannot find module') || buildErrors.includes('MODULE_NOT_FOUND')) {
      detectedTypes.push({
        type: 'Module Resolution Error',
        description: 'Missing dependencies or incorrect import paths',
      });
      suggestedFixes.push('- Check import paths and install missing dependencies');
    }

    // Generic catch-all
    if (detectedTypes.length === 0) {
      detectedTypes.push({
        type: 'Unknown Build Error',
        description: 'Build error that needs manual investigation',
      });
      suggestedFixes.push('- Review build output and fix TypeScript compilation errors');
    }

    return { detectedTypes, suggestedFixes };
  }

  /**
   * Analyze test errors and apply fixes
   */
  async analyzeTestErrorsAndFix(context: MigrationContext): Promise<void> {
    try {
      // Run tests and capture errors
      const result = await execa('bun', ['run', 'test'], {
        cwd: this.repoPath,
        reject: false,
        all: true,
      });

      if (result.exitCode !== 0 && result.all) {
        logger.info('📋 Analyzing test errors...');

        const testErrors = result.all;
        const errorTypes = this.analyzeTestErrorTypes(testErrors);

        // Generate specific fixes based on error types
        const fixPrompt = this.generateTestFixPrompt(context, testErrors, errorTypes);

        // Use Claude to fix the test errors
        await this.claudeIntegration.runClaudeWithPrompt(fixPrompt);

        logger.info('✅ Test error analysis and fixes applied');
      }
    } catch (error) {
      logger.error('❌ Test error analysis failed:', error);
    }
  }

  /**
   * Analyze test error types
   */
  private analyzeTestErrorTypes(testErrors: string): Set<string> {
    const errorTypes = new Set<string>();

    if (testErrors.includes('Cannot find module') || testErrors.includes('MODULE_NOT_FOUND')) {
      errorTypes.add('MISSING_DEPENDENCIES');
    }

    if (
      testErrors.includes('env') ||
      testErrors.includes('environment') ||
      testErrors.includes('undefined')
    ) {
      errorTypes.add('MISSING_ENV_VARS');
    }

    if (
      testErrors.includes('SyntaxError') ||
      testErrors.includes('import') ||
      testErrors.includes('export')
    ) {
      errorTypes.add('SYNTAX_ERRORS');
    }

    if (testErrors.includes('TypeScript') || testErrors.includes('TS')) {
      errorTypes.add('TYPE_ERRORS');
    }

    if (testErrors.includes('timeout') || testErrors.includes('TIMEOUT')) {
      errorTypes.add('TIMEOUT_ERRORS');
    }

    if (testErrors.includes('No test files found') || testErrors.includes('no tests')) {
      errorTypes.add('NO_TESTS_FOUND');
    }

    return errorTypes;
  }

  /**
   * Generate test fix prompt based on error types
   */
  private generateTestFixPrompt(
    context: MigrationContext,
    testErrors: string,
    errorTypes: Set<string>
  ): string {
    const fixes = this.getErrorSpecificFixes(errorTypes, context);

    return `# Fix ElizaOS V2 Plugin Test Errors

The ${context.pluginName} plugin has test failures:

\`\`\`
${testErrors.substring(0, 1000)}${testErrors.length > 1000 ? '...' : ''}
\`\`\`

## Error Analysis:
- Detected error types: ${Array.from(errorTypes).join(', ')}

## Specific Fixes to Apply:
${fixes}

## Test File Requirements:
- ElizaOS V2 tests should be in \`src/test/test.ts\` (NOT \`.test.ts\` or \`.spec.ts\`)
- Use Node.js built-in test runner or simple test functions
- Tests should validate plugin functionality end-to-end

Fix these test issues while maintaining the plugin's core functionality.`;
  }

  /**
   * Get error-specific fixes
   */
  private getErrorSpecificFixes(errorTypes: Set<string>, context: MigrationContext): string {
    const fixes: string[] = [];

    if (errorTypes.has('MISSING_DEPENDENCIES')) {
      fixes.push(
        '1. **Missing Dependencies**: Install required packages using bun add or npm install'
      );
    }

    if (errorTypes.has('MISSING_ENV_VARS')) {
      fixes.push(
        '2. **Environment Variables**: Set up test environment variables or use dummy values'
      );
    }

    if (errorTypes.has('SYNTAX_ERRORS')) {
      fixes.push('3. **Syntax Errors**: Fix import/export statements and TypeScript syntax');
    }

    if (errorTypes.has('TYPE_ERRORS')) {
      fixes.push('4. **Type Errors**: Ensure all types are properly imported and used');
    }

    if (errorTypes.has('TIMEOUT_ERRORS')) {
      fixes.push('5. **Timeout Issues**: Increase test timeouts or optimize test performance');
    }

    if (errorTypes.has('NO_TESTS_FOUND')) {
      fixes.push(
        '6. **No Tests**: This may be expected for some plugins - ensure test files follow V2 patterns'
      );
    }

    // Plugin-specific fixes
    if (context.hasService) {
      fixes.push('7. **Service Testing**: Ensure service can be started and stopped properly');
    }

    if (context.hasActions) {
      fixes.push('8. **Action Testing**: Test action handlers with proper V2 signature');
    }

    if (context.hasProviders) {
      fixes.push('9. **Provider Testing**: Test providers return proper context data');
    }

    if (fixes.length === 0) {
      fixes.push('- Review test output and fix issues based on error messages');
    }

    return fixes.join('\n');
  }

  /**
   * Quick error check without running full analysis
   */
  async quickErrorCheck(): Promise<{
    hasBuildErrors: boolean;
    hasTestErrors: boolean;
    errorSummary: string[];
  }> {
    const errorSummary: string[] = [];
    let hasBuildErrors = false;
    let hasTestErrors = false;

    // Quick build check
    try {
      await execa('bun', ['run', 'build'], {
        cwd: this.repoPath,
        stdio: 'pipe',
        timeout: 30000,
      });
    } catch (error) {
      hasBuildErrors = true;
      errorSummary.push('Build errors detected');
    }

    // Quick test check
    try {
      await execa('bun', ['run', 'test'], {
        cwd: this.repoPath,
        stdio: 'pipe',
        timeout: 30000,
      });
    } catch (error) {
      hasTestErrors = true;
      errorSummary.push('Test errors detected');
    }

    return { hasBuildErrors, hasTestErrors, errorSummary };
  }
}
