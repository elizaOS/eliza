import { logger } from '@elizaos/core';
import type { MigrationContext, SDKMigrationOptions } from '../types.js';
// Import the real Claude SDK adapter implementation
import { EnhancedClaudeSDKAdapter } from '../claude-sdk/index.js';

/**
 * Claude integration for AI-powered migration steps
 */
export class ClaudeIntegration {
  private claudeSDKAdapter: EnhancedClaudeSDKAdapter | null = null;

  constructor(private repoPath: string) {}

  /**
   * Initialize the Claude SDK adapter
   */
  private async initializeSDKAdapter(): Promise<void> {
    if (!this.claudeSDKAdapter) {
      this.claudeSDKAdapter = new EnhancedClaudeSDKAdapter({
        maxRetries: 3,
      });
    }
  }

  /**
   * Apply Claude prompts for structural migrations
   */
  async applyClaudePrompts(context: MigrationContext): Promise<void> {
    if (context.claudePrompts.size === 0) return;

    logger.info(`📋 Applying ${context.claudePrompts.size} Claude-based migrations...`);

    // Create a comprehensive prompt from all collected prompts
    const megaPrompt = `# ElizaOS V1 to V2 Migration for ${context.pluginName}

## 🎯 MIGRATION GOAL: 
Transform this V1 plugin to work with ElizaOS V2 architecture using the patterns shown below.

## ⚠️ CRITICAL RULES:
- Test files are AUTO-GENERATED - DO NOT create src/test/ files manually
- Only create SERVICE if the V1 plugin had one - most plugins do NOT need services
- Follow the exact patterns shown in examples below
- Make MINIMAL changes - don't add new features

## 🔧 CRITICAL V2 PATTERNS TO APPLY:

### Import Changes (MANDATORY):
\`\`\`typescript
// ❌ V1 Wrong:
import { 
    ModelClass, 
    elizaLogger, 
    ActionExample, 
    Content,
    composeContext,
    generateObjectDeprecated 
} from "@elizaos/core";

// ✅ V2 Correct:
import { 
    ModelType, 
    logger, 
    composePromptFromState,
    parseKeyValueXml 
} from "@elizaos/core";
import type { ActionExample, Content, HandlerCallback, IAgentRuntime, Memory, State } from "@elizaos/core";
\`\`\`

### Service Pattern (ONLY if V1 had service):
\`\`\`typescript
// ❌ V1 Wrong:
export const myService: ServiceType = 'my-service';

// ✅ V2 Correct:
export class MyService extends Service {
    static serviceType = 'my-service'; // No type annotation
    
    static async start(runtime: IAgentRuntime) {
        return new MyService(runtime);
    }
    
    async stop(): Promise<void> {}
    
    get capabilityDescription(): string {
        return 'Service description';
    }
}
\`\`\`

### Handler Pattern (MANDATORY):
\`\`\`typescript
// ❌ V1 Wrong:
handler: async (runtime, message, state?, options, callback?) => {
    const context = composeContext({ state, template: templateName });
    const result = await generateObjectDeprecated({
        runtime,
        context,
        modelClass: ModelClass.LARGE,
    });
    return true;
}

// ✅ V2 Correct:
handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State | undefined,
    _options: { [key: string]: unknown },
    callback: HandlerCallback
) => {
    if (!state) {
        state = await runtime.composeState(_message, ['RECENT_MESSAGES']);
    }
    
    // Add plugin-specific context information
    state.supportedOptions = availableOptions.join(' | ');
    
    const actionContext = composePromptFromState({
        state,
        template: templateName,
    });

    const xmlResponse = await runtime.useModel(ModelType.TEXT_LARGE, {
        prompt: actionContext,
    });

    const result = parseKeyValueXml(xmlResponse) as any;
    
    const content: Content = {
        text: result.response || "Action completed",
        source: '${context.pluginName.replace('@elizaos/plugin-', '').replace('plugin-', '')}'
    };
    
    callback(content);
}
\`\`\`

### State Enhancement Pattern (MANDATORY):
\`\`\`typescript
// ❌ V1 Wrong:
if (!state) {
    state = (await runtime.composeState(message)) as State;
} else {
    state = await runtime.updateRecentMessageState(state);
}

// ✅ V2 Correct:
if (!state) {
    state = await runtime.composeState(_message, ['RECENT_MESSAGES']);
}

// Add contextual information to state for better AI context
const serviceData = await someService.getData();
state.supportedOptions = options.join(' | ');
state.contextInfo = formatContextInfo(serviceData);
\`\`\`

### Memory Pattern (MANDATORY):
\`\`\`typescript
// ❌ V1 Wrong:
await runtime.messageManager.createMemory(memory);

// ✅ V2 Correct:
await runtime.createMemory({
    id: createUniqueUuid(runtime, \`action-\${Date.now()}\`),
    entityId: message.entityId,
    agentId: runtime.agentId,
    roomId: message.roomId,
    content: { text: result, source: 'plugin-name' },
    createdAt: Date.now()
}, 'messages');
\`\`\`

## 📋 TASKS TO COMPLETE:
${
  context.claudePrompts.size > 0
    ? Array.from(context.claudePrompts.entries())
        .map(([stepId, prompt]) => `\n### ${stepId}\n${prompt}`)
        .join('\n')
    : '- Apply the patterns above to all plugin files'
}

## ✅ FINAL CHECKLIST:
1. All imports use 'type' prefix for interfaces
2. ModelClass → ModelType, elizaLogger → logger  
3. Handler signature matches V2 pattern exactly
4. Service only created if V1 had one
5. Content has only 'text' and 'source' fields
6. No test files created manually

Apply these patterns to complete the V2 migration.`;

    // Apply with Claude
    await this.runClaudeCodeWithPrompt(megaPrompt, context);
  }

  /**
   * Run Claude with complex structural changes using SDK
   */
  async runClaudeCodeWithPrompt(prompt: string, context: MigrationContext): Promise<void> {
    process.chdir(this.repoPath);

    // Initialize SDK adapter if not already done
    await this.initializeSDKAdapter();

    try {
      logger.info('🚀 Using Claude SDK for migration...');

      if (!this.claudeSDKAdapter) {
        throw new Error('Claude SDK adapter not initialized');
      }

      const result = await this.claudeSDKAdapter.executePrompt(
        prompt,
        {
          maxTurns: 30,
          model: 'claude-opus-4-20250514', // Use Opus for complex migration tasks
          outputFormat: 'json',
          permissionMode: 'bypassPermissions', // Equivalent to --dangerously-skip-permissions
          systemPrompt:
            'You are an expert ElizaOS plugin migration assistant. Follow the migration instructions precisely.',
        },
        context
      );

      if (result.success) {
        logger.info('✅ SDK execution completed successfully');
      } else if (result.message?.includes('error_max_turns') || result.shouldContinue) {
        logger.warn(`⚠️  Migration hit max turns but continuing: ${result.message}`);
        logger.info('ℹ️  Remaining issues will be fixed in the iterative validation phase');
      } else {
        throw new Error(`SDK execution failed: ${result.message}`);
      }

      if (result.cost) {
        logger.info(`💰 Cost: $${result.cost.toFixed(4)}`);
      }
      if (result.duration) {
        logger.info(`⏱️  Duration: ${result.duration}ms`);
      }
      if (result.warnings && result.warnings.length > 0) {
        for (const warning of result.warnings) {
          logger.warn(`⚠️  ${warning}`);
        }
      }
    } catch (error) {
      logger.error('❌ Claude SDK execution failed:', error);
      throw error;
    }
  }

  /**
   * Run Claude with a specific prompt for smaller changes using SDK
   */
  async runClaudeWithPrompt(prompt: string): Promise<void> {
    if (!this.repoPath) throw new Error('Repository path not set');

    // Initialize SDK adapter if not already done
    await this.initializeSDKAdapter();

    try {
      logger.info('🤖 Using Claude SDK for prompt execution...');

      const options: SDKMigrationOptions = {
        maxTurns: 5,
        model: 'claude-sonnet-4-20250514', // Use Sonnet for smaller prompts
        outputFormat: 'json',
        permissionMode: 'bypassPermissions',
      };

      // Create a minimal context for this execution
      const context: MigrationContext = {
        repoPath: this.repoPath,
        pluginName: 'temp',
        hasService: false,
        hasProviders: false,
        hasActions: false,
        hasTests: false,
        packageJson: { name: 'temp-plugin', version: '1.0.0' },
        existingFiles: [],
        changedFiles: new Set(),
        claudePrompts: new Map(),
        abortController: new AbortController(),
        sessionManager: undefined,
        metricsCollector: undefined,
      };

      if (!this.claudeSDKAdapter) {
        throw new Error('Claude SDK adapter not initialized');
      }

      const result = await this.claudeSDKAdapter.executePrompt(prompt, options, context);

      // Handle recoverable conditions (like max turns) vs actual failures
      if (!result.success) {
        if (result.message?.includes('error_max_turns') || result.shouldContinue) {
          logger.warn(`⚠️  Prompt execution hit max turns but continuing: ${result.message}`);
          logger.info('ℹ️  Remaining issues will be fixed in the iterative validation phase');
        } else {
          throw new Error(result.message || 'Claude SDK execution failed');
        }
      } else {
        logger.info('✅ Claude SDK prompt execution completed successfully');
      }

      if (result.cost) {
        logger.info(`💰 Prompt execution cost: $${result.cost.toFixed(4)}`);
      }

      if (result.warnings && result.warnings.length > 0) {
        for (const warning of result.warnings) {
          logger.warn(`⚠️  ${warning}`);
        }
      }
    } catch (error) {
      logger.error('❌ Claude SDK prompt execution failed:', error);
      throw error;
    }
  }

  /**
   * Fix all imports using Claude with real examples
   */
  async fixAllImportsWithClaude(context: MigrationContext): Promise<void> {
    logger.info('🔧 Fixing all imports using Claude with real examples...');

    const importFixPrompt = `# Fix ALL ElizaOS V2 Imports - Use Real Examples as Reference

Fix ALL import statements in this ${context.pluginName} plugin to match V2 patterns exactly.

## 🚨 CRITICAL V1→V2 IMPORT MAPPINGS (MUST FIX):

### 1. Function/API Renames:
\`\`\`typescript
// ❌ V1 Wrong:
import { composeContext } from "@elizaos/core";

// ✅ V2 Correct:
import { composePrompt } from "@elizaos/core";
\`\`\`

### 2. Deprecated Functions (MUST REPLACE):
\`\`\`typescript
// ❌ V1 Wrong:
import { generateObject, generateObjectDeprecated } from "@elizaos/core";

// ✅ V2 Correct: Remove these imports entirely - use runtime.useModel instead
// generateObject → runtime.useModel(ModelType.OBJECT_SMALL, { prompt, schema })
// generateObjectDeprecated → runtime.useModel(ModelType.OBJECT_SMALL, { prompt, schema })
\`\`\`

### 3. Model API Changes:
\`\`\`typescript
// ❌ V1 Wrong:
import { ModelClass } from "@elizaos/core";

// ✅ V2 Correct:
import { ModelType } from "@elizaos/core";
\`\`\`

### 4. Logger Rename:
\`\`\`typescript
// ❌ V1 Wrong:
import { elizaLogger } from "@elizaos/core";

// ✅ V2 Correct:
import { logger } from "@elizaos/core";
\`\`\`

## ✅ CORRECT V2 IMPORT PATTERNS (use these as reference):

### Example from actions.ts:
\`\`\`typescript
import type {
  Action,
  Content,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
  UUID,
} from "@elizaos/core";
import { logger, ModelType, composePrompt } from "@elizaos/core";
\`\`\`

### Example from document-processor.ts:
\`\`\`typescript
import {
  IAgentRuntime,
  Memory,
  MemoryType,
  ModelType,
  UUID,
  logger,
  splitChunks,
} from "@elizaos/core";
\`\`\`

### Example from index.ts:
\`\`\`typescript
import type { Plugin, IAgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";
\`\`\`

### Example from service.ts:
\`\`\`typescript
import {
  Content,
  createUniqueUuid,
  FragmentMetadata,
  IAgentRuntime,
  KnowledgeItem,
  logger,
  Memory,
  MemoryMetadata,
  MemoryType,
  ModelType,
  Semaphore,
  Service,
  splitChunks,
  UUID,
} from "@elizaos/core";
\`\`\`

## 🎯 CRITICAL FIXES TO APPLY:

1. **Remove Non-Existent Imports** - These don't exist in V2:
   - composeContext → composePrompt
   - generateObject → REMOVE (use runtime.useModel instead)
   - generateObjectDeprecated → REMOVE (use runtime.useModel instead)
   - ModelClass → ModelType
   - elizaLogger → logger

2. **Types vs Values - Follow Examples Above**:
   - **Value imports**: logger, ModelType, MemoryType, Service, createUniqueUuid, splitChunks, Semaphore, composePrompt
   - **Type imports**: Action, Content, HandlerCallback, State, UUID, Plugin, IAgentRuntime, Memory, etc.

3. **Code Changes** (not just imports):
   - Replace composeContext with composePrompt in code
   - Replace generateObject(...) calls with runtime.useModel(ModelType.OBJECT_SMALL, ...)
   - Replace ModelClass with ModelType throughout the code
   - Replace elizaLogger with logger throughout the code

4. **Import Structure**:
   - Separate type imports: import type { ... } from "@elizaos/core";
   - Separate value imports: import { ... } from "@elizaos/core";
   - When in doubt, look at the real examples above

## 📋 STEP-BY-STEP INSTRUCTIONS:
1. Go through EVERY TypeScript file in src/
2. Fix ALL @elizaos/core imports to match the patterns above
3. **CRITICAL**: Remove composeContext, generateObject, generateObjectDeprecated imports
4. **CRITICAL**: Replace composeContext with composePrompt in code
5. **CRITICAL**: Replace generateObject(...) calls with runtime.useModel(ModelType.OBJECT_SMALL, ...)
6. Replace ModelClass with ModelType throughout the code
7. Replace elizaLogger with logger throughout the code
8. Ensure types use import type and values use import
9. Follow the EXACT patterns from the real examples

Apply these fixes to prevent ANY import-related TypeScript errors.`;

    await this.runClaudeCodeWithPrompt(importFixPrompt, context);
    logger.info('✅ All imports fixed using Claude with real examples');
  }
}
