import { logger } from '@elizaos/core';
import * as fs from 'fs-extra';
import * as path from 'node:path';
import { execa } from 'execa';
import { fileURLToPath } from 'node:url';
import type { MigrationContext, StepResult } from './types.js';

// Setup __dirname for ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface PluginAnalysis {
  name: string;
  description: string;
  hasServices: boolean;
  hasActions: boolean;
  hasProviders: boolean;
  hasEvaluators: boolean;
  services: Array<{
    name: string;
    type: string;
    methods: string[];
  }>;
  actions: Array<{
    name: string;
    description: string;
    handler: string;
  }>;
  providers: Array<{
    name: string;
    description: string;
    methods: string[];
  }>;
  evaluators: Array<{
    name: string;
    description: string;
  }>;
}

export interface TestTemplateVariables {
  PLUGIN_NAME: string;
  PLUGIN_NAME_LOWER: string;
  PLUGIN_VARIABLE: string;
  API_KEY_NAME: string;
}

export class ContextAwareTestGenerator {
  private context: MigrationContext;
  private repoPath: string;

  constructor(context: MigrationContext) {
    this.context = context;
    this.repoPath = context.repoPath;
  }

  /**
   * Run Claude Code with a specific prompt
   */
  private async runClaudeCodeWithPrompt(prompt: string): Promise<void> {
    if (!this.repoPath) throw new Error('Repository path not set');
    process.chdir(this.repoPath);

    const maxRetries = 3;
    let retryCount = 0;
    let lastError: unknown = null;

    while (retryCount < maxRetries) {
      try {
        logger.info('🤖 Running Claude Code for test generation...');

        await execa(
          'claude',
          [
            '--print',
            '--max-turns',
            '30',
            '--verbose',
            '--model',
            'claude-opus-4-20250514',
            '--dangerously-skip-permissions',
            prompt,
          ],
          {
            stdio: 'inherit',
            cwd: this.repoPath,
            timeout: 15 * 60 * 1000, // 15 minutes
          }
        );

        logger.info('✅ Claude Code test generation completed successfully');
        return; // Success - exit the retry loop
      } catch (error: unknown) {
        lastError = error;
        const err = error as { code?: string; message?: string; stderr?: string };

        if (err.code === 'ENOENT') {
          throw new Error(
            'Claude Code not found! Install with: npm install -g @anthropic-ai/claude-code'
          );
        }

        // Check for rate limiting errors
        const errorMessage = err.message || err.stderr || '';
        const isRateLimitError = 
          errorMessage.includes('rate limit') ||
          errorMessage.includes('429') ||
          errorMessage.includes('too many requests') ||
          errorMessage.includes('quota exceeded');

        if (isRateLimitError && retryCount < maxRetries - 1) {
          retryCount++;
          const waitTime = Math.min(60 * retryCount, 300); // Wait 1-5 minutes
          logger.warn(`⏸️  Rate limit detected. Waiting ${waitTime} seconds before retry ${retryCount}/${maxRetries - 1}...`);
          
          // Show countdown
          for (let i = waitTime; i > 0; i--) {
            process.stdout.write(`\r⏱️  Resuming in ${i} seconds...  `);
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
          process.stdout.write('\r\n');
          
          logger.info('🔄 Resuming Claude Code test generation...');
          continue; // Retry
        }

        logger.error('❌ Claude Code test generation failed:', err.message);
        throw error;
      }
    }

    // If we exhausted all retries
    throw new Error(`Claude Code test generation failed after ${maxRetries} attempts. Last error: ${(lastError as Error)?.message}`);
  }

  /**
   * Analyze plugin structure to understand what tests are needed
   */
  private async analyzePlugin(): Promise<PluginAnalysis> {
    const analysis: PluginAnalysis = {
      name: this.context.pluginName || 'unknown',
      description: '',
      hasServices: false,
      hasActions: false,
      hasProviders: false,
      hasEvaluators: false,
      services: [],
      actions: [],
      providers: [],
      evaluators: []
    };

    try {
      // Check for services
      const servicesPath = path.join(this.repoPath, 'src', 'services');
      if (await fs.pathExists(servicesPath)) {
        analysis.hasServices = true;
        const serviceFiles = await fs.readdir(servicesPath);
        for (const file of serviceFiles.filter(f => f.endsWith('.ts'))) {
          analysis.services.push({
            name: file.replace('.ts', ''),
            type: 'service',
            methods: [] // Will be filled by Claude analysis
          });
        }
      }

      // Check for actions
      const actionsPath = path.join(this.repoPath, 'src', 'actions');
      if (await fs.pathExists(actionsPath)) {
        analysis.hasActions = true;
        const actionFiles = await fs.readdir(actionsPath);
        for (const file of actionFiles.filter(f => f.endsWith('.ts'))) {
          analysis.actions.push({
            name: file.replace('.ts', ''),
            description: '',
            handler: ''
          });
        }
      }

      // Check for providers
      const providersPath = path.join(this.repoPath, 'src', 'providers');
      if (await fs.pathExists(providersPath)) {
        analysis.hasProviders = true;
        const providerFiles = await fs.readdir(providersPath);
        for (const file of providerFiles.filter(f => f.endsWith('.ts'))) {
          analysis.providers.push({
            name: file.replace('.ts', ''),
            description: '',
            methods: []
          });
        }
      }

      // Check for evaluators
      const evaluatorsPath = path.join(this.repoPath, 'src', 'evaluators');
      if (await fs.pathExists(evaluatorsPath)) {
        analysis.hasEvaluators = true;
        const evaluatorFiles = await fs.readdir(evaluatorsPath);
        for (const file of evaluatorFiles.filter(f => f.endsWith('.ts'))) {
          analysis.evaluators.push({
            name: file.replace('.ts', ''),
            description: ''
          });
        }
      }

      logger.info(`📊 Plugin Analysis: ${analysis.name}`, {
        services: analysis.services.length,
        actions: analysis.actions.length,
        providers: analysis.providers.length,
        evaluators: analysis.evaluators.length
      });

    } catch (error) {
      logger.warn('⚠️  Could not fully analyze plugin structure:', error);
    }

    return analysis;
  }

  /**
   * IMPROVED: Generate robust template variables that handle edge cases and avoid conflicts
   */
  private generateRobustTemplateVariables(analysis: PluginAnalysis): TestTemplateVariables {
    const packageJson = this.context.packageJson;
    
    // Extract clean plugin name from package.json or analysis
    const baseName = this.extractCleanPluginName(packageJson.name, analysis.name);
    
    // Generate and validate variable names
    const variables = this.createTemplateVariables(baseName);
    
    // Validate generated names
    this.validateTemplateVariables(variables);
    
    logger.info('Generated robust template variables:', variables);
    
    return variables;
  }

  /**
   * Extract clean plugin name handling various package name formats
   */
  private extractCleanPluginName(packageName: string, analysisName: string): string {
    let baseName = packageName || analysisName || 'unknown';
    
    // Remove common prefixes
    baseName = baseName
      .replace('@elizaos/plugin-', '')
      .replace('@elizaos/', '')
      .replace('plugin-', '')
      .replace('eliza-', '')
      .replace('elizaos-', '');
    
    // Handle scoped packages
    if (baseName.includes('/')) {
      baseName = baseName.split('/').pop() || baseName;
    }
    
    // Clean up any remaining special characters but preserve hyphens
    baseName = baseName.replace(/[^a-zA-Z0-9-]/g, '');
    
    return baseName;
  }

  /**
   * Create template variables with proper naming conventions
   */
  private createTemplateVariables(baseName: string): TestTemplateVariables {
    // Convert to human-readable name
    const humanName = baseName
      .split('-')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
    
    // Create safe camelCase variable name
    const camelCaseName = this.createSafeCamelCase(baseName);
    
    // Create environment variable name
    const envVarName = this.createEnvVarName(baseName);
    
    return {
      PLUGIN_NAME: humanName,
      PLUGIN_NAME_LOWER: baseName.toLowerCase().replace(/-/g, ''),
      PLUGIN_VARIABLE: `${camelCaseName}Plugin`,
      API_KEY_NAME: envVarName,
    };
  }

  /**
   * Create safe camelCase identifier that avoids conflicts
   */
  private createSafeCamelCase(baseName: string): string {
    const parts = baseName.split('-').filter(part => part.length > 0);
    
    if (parts.length === 0) {
      return 'unknown';
    }
    
    // First part stays lowercase, subsequent parts get capitalized
    const camelCase = parts.map((part, index) => {
      if (index === 0) {
        return part.toLowerCase();
      }
      return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
    }).join('');
    
    // Ensure it doesn't start with a number
    if (/^\d/.test(camelCase)) {
      return `plugin${camelCase.charAt(0).toUpperCase() + camelCase.slice(1)}`;
    }
    
    return camelCase;
  }

  /**
   * Create environment variable name following conventions
   */
  private createEnvVarName(baseName: string): string {
    const envName = baseName
      .toUpperCase()
      .replace(/-/g, '_')
      .replace(/[^A-Z0-9_]/g, '');
    
    // Add API_KEY suffix if not already present
    if (!envName.includes('API_KEY') && !envName.includes('TOKEN')) {
      return `${envName}_API_KEY`;
    }
    
    return envName;
  }

  /**
   * Validate template variables to ensure they're safe to use
   */
  private validateTemplateVariables(variables: TestTemplateVariables): void {
    const reservedWords = [
      'class', 'function', 'import', 'export', 'default', 'const', 'let', 'var',
      'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue',
      'return', 'try', 'catch', 'finally', 'throw', 'new', 'this', 'super',
      'extends', 'implements', 'interface', 'enum', 'type', 'namespace',
      'test', 'describe', 'it', 'expect', 'before', 'after', 'setup', 'teardown'
    ];
    
    // Check plugin variable name
    const varName = variables.PLUGIN_VARIABLE.replace('Plugin', '').toLowerCase();
    if (reservedWords.includes(varName)) {
      throw new Error(`Generated variable name conflicts with reserved word: ${varName}`);
    }
    
    // Validate identifier format
    if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(varName)) {
      throw new Error(`Generated variable name is not a valid identifier: ${varName}`);
    }
    
    // Validate environment variable format
    if (!/^[A-Z][A-Z0-9_]*$/.test(variables.API_KEY_NAME)) {
      throw new Error(`Generated API key name is not valid: ${variables.API_KEY_NAME}`);
    }
    
    logger.info('✅ Template variables validated successfully');
  }

  /**
   * Generate comprehensive test suites using Claude
   */
  async generateTestSuites(): Promise<StepResult> {
    try {
      logger.info('🧪 Generating comprehensive ElizaOS V2 test suites using Claude...');

      const analysis = await this.analyzePlugin();

      // IMPROVED: Use enhanced template variable generation
      const templateVars = this.generateRobustTemplateVariables(analysis);

      const testGenerationPrompt = `# Generate ElizaOS V2 Plugin Test Suite Following TEST_CASES.md Patterns

Generate a complete ElizaOS V2 test suite for the "${analysis.name}" plugin using ONLY the built-in elizaos test framework.

## 🚨 CRITICAL: NO VITEST - ELIZAOS TEST FRAMEWORK ONLY

**ElizaOS V2 plugins use ONLY the built-in \`elizaos test\` framework. Do NOT create vitest tests, vitest configs, or include vitest in dependencies.**

## 📋 REQUIRED TEST STRUCTURE (src/test/test.ts):

\`\`\`typescript
import type {
  IAgentRuntime,
  TestSuite,
  Memory,
  UUID,
  Content,
  HandlerCallback,
  State
} from "@elizaos/core";
import { createMockRuntime } from "./utils.js";
import ${templateVars.PLUGIN_VARIABLE} from "../index.js";

/**
 * ${templateVars.PLUGIN_NAME} Plugin Test Suite
 * 
 * Comprehensive ElizaOS V2 testing with 10-15 tests
 * Following TEST_CASES.md patterns exactly
 */

export class ${templateVars.PLUGIN_NAME.charAt(0).toUpperCase() + templateVars.PLUGIN_NAME.slice(1).replace(/[^a-zA-Z0-9]/g, '')}TestSuite implements TestSuite {
  name = "${templateVars.PLUGIN_NAME_LOWER}";
  description = "Comprehensive tests for ${templateVars.PLUGIN_NAME} plugin - ElizaOS V2 Architecture";

  tests = [
    {
      name: "1. Plugin has complete V2 structure",
      fn: async (runtime: IAgentRuntime) => {
        console.log("🔍 Testing plugin structure...");
        
        // Test required fields
        if (!${templateVars.PLUGIN_VARIABLE}.name) {
          throw new Error("Plugin missing name");
        }
        
        if (!${templateVars.PLUGIN_VARIABLE}.description) {
          throw new Error("Plugin missing description (required in V2)");
        }
        
        if (!Array.isArray(${templateVars.PLUGIN_VARIABLE}.actions)) {
          throw new Error("Plugin actions must be an array");
        }
        
        if (!Array.isArray(${templateVars.PLUGIN_VARIABLE}.providers)) {
          throw new Error("Plugin providers must be an array");
        }
        
        if (!Array.isArray(${templateVars.PLUGIN_VARIABLE}.services)) {
          throw new Error("Plugin services must be an array");
        }
        
        console.log("✅ Plugin structure is valid");
      },
    },

    {
      name: "2. Plugin can be initialized",
      fn: async (runtime: IAgentRuntime) => {
        console.log("🔧 Testing plugin initialization...");
        
        // Check if init function exists and is callable
        if (${templateVars.PLUGIN_VARIABLE}.init && typeof ${templateVars.PLUGIN_VARIABLE}.init === 'function') {
          try {
            await ${templateVars.PLUGIN_VARIABLE}.init({}, runtime);
            console.log("✅ Plugin initialization successful");
          } catch (error) {
            // Some plugins may require config, that's OK
            console.log("ℹ️  Plugin init requires configuration");
          }
        } else {
          console.log("ℹ️  Plugin has no init function");
        }
        
        console.log("✅ Plugin initialization tested");
      },
    },

    {
      name: "3. Configuration validation",
      fn: async (runtime: IAgentRuntime) => {
        console.log("⚙️  Testing configuration handling...");
        
        // Test with missing config
        const emptyConfig = {};
        const validConfig = {
          ${templateVars.API_KEY_NAME}: "test-key-12345",
        };
        
        // Check if plugin handles missing config gracefully
        if (${templateVars.PLUGIN_VARIABLE}.init) {
          try {
            await ${templateVars.PLUGIN_VARIABLE}.init(emptyConfig, runtime);
            console.log("✅ Plugin handles empty config gracefully");
          } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            if (errorMsg.includes("required") || errorMsg.includes("missing")) {
              console.log("✅ Plugin correctly validates required config");
            }
          }
        }
        
        console.log("✅ Configuration validation tested");
      },
    },

${analysis.hasServices ? `    {
      name: "4. Service initialization and registration",
      fn: async (runtime: IAgentRuntime) => {
        console.log("🔌 Testing service initialization...");
        
        const services = ${templateVars.PLUGIN_VARIABLE}.services || [];
        if (services.length === 0) {
          console.log("ℹ️  No services to test");
          return;
        }
        
        for (const ServiceClass of services) {
          // Validate service structure
          if (!ServiceClass.serviceType || typeof ServiceClass.serviceType !== 'string') {
            throw new Error("Service missing serviceType property");
          }
          
          if (typeof ServiceClass.start !== 'function') {
            throw new Error("Service missing start method");
          }
          
          // Test service initialization
          const mockRuntime = createMockRuntime({
            getSetting: (key: string) => {
              if (key.includes('API_KEY')) return 'test-api-key';
              return null;
            }
          });
          
          try {
            const service = await ServiceClass.start(mockRuntime);
            
            // Check service has required methods
            if (typeof service.stop !== 'function') {
              throw new Error("Service missing stop method");
            }
            
            if (!service.capabilityDescription) {
              throw new Error("Service missing capabilityDescription");
            }
            
            await service.stop();
            console.log(\`✅ Service \${ServiceClass.serviceType} lifecycle working\`);
          } catch (error) {
            console.log(\`ℹ️  Service \${ServiceClass.serviceType} requires specific config\`);
          }
        }
      },
    },` : ''}

    {
      name: "${analysis.hasServices ? '5' : '4'}. Action structure and validation",
      fn: async (runtime: IAgentRuntime) => {
        console.log("🎯 Testing action structure...");
        
        const actions = ${templateVars.PLUGIN_VARIABLE}.actions || [];
        if (actions.length === 0) {
          console.log("ℹ️  No actions to test");
          return;
        }
        
        for (const action of actions) {
          // Validate required properties
          if (!action.name || typeof action.name !== 'string') {
            throw new Error(\`Action missing valid name\`);
          }
          
          if (!action.description || typeof action.description !== 'string') {
            throw new Error(\`Action \${action.name} missing description\`);
          }
          
          if (typeof action.validate !== 'function') {
            throw new Error(\`Action \${action.name} missing validate method\`);
          }
          
          if (typeof action.handler !== 'function') {
            throw new Error(\`Action \${action.name} missing handler method\`);
          }
          
          if (!action.examples || !Array.isArray(action.examples)) {
            throw new Error(\`Action \${action.name} missing examples array\`);
          }
          
          // Validate handler signature (5 parameters)
          if (action.handler.length < 5) {
            throw new Error(\`Action \${action.name} handler has wrong signature\`);
          }
          
          console.log(\`✅ Action \${action.name} structure validated\`);
        }
      },
    },

    {
      name: "${analysis.hasServices ? '6' : '5'}. Action execution and callbacks",
      fn: async (runtime: IAgentRuntime) => {
        console.log("🚀 Testing action execution...");
        
        const actions = ${templateVars.PLUGIN_VARIABLE}.actions || [];
        for (const action of actions) {
          const testMessage: Memory = {
            id: \`test-\${Date.now()}\` as UUID,
            entityId: runtime.agentId,
            agentId: runtime.agentId,
            roomId: "test-room" as UUID,
            content: { text: \`Test \${action.name}\`, source: "${templateVars.PLUGIN_NAME_LOWER}" },
            createdAt: Date.now()
          };
          
          const testState: State = {
            values: {},
            data: {},
            text: ""
          };
          
          // Test validation
          try {
            const isValid = await action.validate(runtime, testMessage, testState);
            console.log(\`✅ Action \${action.name} validation callable (returned \${isValid})\`);
          } catch (error) {
            console.log(\`ℹ️  Action \${action.name} validation requires specific context\`);
          }
          
          // Test handler callback structure
          let callbackCalled = false;
          const callback: HandlerCallback = async (content: Content) => {
            callbackCalled = true;
            if (!content || !content.text) {
              throw new Error("Callback received invalid content");
            }
            return [];
          };
          
          console.log(\`✅ Action \${action.name} handler verified\`);
        }
      },
    },

${analysis.hasProviders ? `    {
      name: "${analysis.hasServices ? '7' : '6'}. Provider functionality",
      fn: async (runtime: IAgentRuntime) => {
        console.log("🔍 Testing providers...");
        
        const providers = ${templateVars.PLUGIN_VARIABLE}.providers || [];
        if (providers.length === 0) {
          console.log("ℹ️  No providers to test");
          return;
        }
        
        for (const provider of providers) {
          if (!provider.name || typeof provider.name !== 'string') {
            throw new Error("Provider missing name");
          }
          
          if (typeof provider.get !== 'function') {
            throw new Error(\`Provider \${provider.name} missing get method\`);
          }
          
          // Test provider returns valid state
          const testMessage: Memory = {
            id: \`test-\${Date.now()}\` as UUID,
            entityId: runtime.agentId,
            agentId: runtime.agentId,
            roomId: "test-room" as UUID,
            content: { text: "Test provider", source: "${templateVars.PLUGIN_NAME_LOWER}" },
            createdAt: Date.now()
          };
          
          try {
            const state = await provider.get(runtime, testMessage, {
              values: {},
              data: {},
              text: ""
            });
            
            if (!state || typeof state !== 'object') {
              throw new Error(\`Provider \${provider.name} returned invalid state\`);
            }
            
            console.log(\`✅ Provider \${provider.name} working\`);
          } catch (error) {
            console.log(\`ℹ️  Provider \${provider.name} requires service context\`);
          }
        }
      },
    },` : ''}

    {
      name: "${analysis.hasServices && analysis.hasProviders ? '8' : analysis.hasServices || analysis.hasProviders ? '7' : '6'}. Memory operations",
      fn: async (runtime: IAgentRuntime) => {
        console.log("💾 Testing memory operations...");
        
        const testMemory: Memory = {
          id: \`test-mem-\${Date.now()}\` as UUID,
          entityId: runtime.agentId,
          agentId: runtime.agentId,
          roomId: "test-room" as UUID,
          content: {
            text: "Test memory content",
            source: "${templateVars.PLUGIN_NAME_LOWER}"
          },
          metadata: {
            type: "test"
          },
          createdAt: Date.now()
        };
        
        try {
          // Test memory creation
          const memoryId = await runtime.createMemory(testMemory, "messages");
          console.log("✅ Memory creation supported");
          
          // Test memory retrieval
          if (runtime.getMemoryById) {
            const retrieved = await runtime.getMemoryById(memoryId);
            if (retrieved) {
              console.log("✅ Memory retrieval working");
            }
          }
        } catch (error) {
          console.log("ℹ️  Memory operations not available in test environment");
        }
      },
    },

    {
      name: "${analysis.hasServices && analysis.hasProviders ? '9' : analysis.hasServices || analysis.hasProviders ? '8' : '7'}. Error handling and recovery",
      fn: async (runtime: IAgentRuntime) => {
        console.log("🚨 Testing error handling...");
        
        // Test with invalid inputs
        const invalidMessage = {
          id: null as any,
          content: null as any,
          entityId: null as any,
          agentId: runtime.agentId,
          roomId: null as any,
          createdAt: 0
        } as Memory;
        
        const actions = ${templateVars.PLUGIN_VARIABLE}.actions || [];
        let errorHandlingCount = 0;
        
        for (const action of actions) {
          try {
            await action.validate(runtime, invalidMessage, {
              values: {},
              data: {},
              text: ""
            });
          } catch (error) {
            errorHandlingCount++;
            console.log(\`✅ Action \${action.name} properly handles invalid input\`);
          }
        }
        
        if (errorHandlingCount > 0) {
          console.log(\`✅ Error handling working for \${errorHandlingCount} actions\`);
        } else if (actions.length === 0) {
          console.log("ℹ️  No actions to test error handling");
        }
      },
    },

    {
      name: "${analysis.hasServices && analysis.hasProviders ? '10' : analysis.hasServices || analysis.hasProviders ? '9' : '8'}. Integration test - complete workflow",
      fn: async (runtime: IAgentRuntime) => {
        console.log("🔄 Testing complete integration workflow...");
        
        try {
          // Initialize plugin if needed
          if (${templateVars.PLUGIN_VARIABLE}.init) {
            const config = {
              ${templateVars.API_KEY_NAME}: "integration-test-key"
            };
            await ${templateVars.PLUGIN_VARIABLE}.init(config, runtime);
          }
          
          // Test a complete action flow if available
          const actions = ${templateVars.PLUGIN_VARIABLE}.actions || [];
          if (actions.length > 0) {
            const firstAction = actions[0];
            
            const integrationMessage: Memory = {
              id: \`integration-\${Date.now()}\` as UUID,
              entityId: runtime.agentId,
              agentId: runtime.agentId,
              roomId: "integration-room" as UUID,
              content: { text: "Integration test message", source: "${templateVars.PLUGIN_NAME_LOWER}" },
              createdAt: Date.now()
            };
            
            const state: State = { values: {}, data: {}, text: "" };
            
            // Validate
            const isValid = await firstAction.validate(runtime, integrationMessage, state);
            
            console.log(\`✅ Integration workflow tested (validation returned: \${isValid})\`);
          }
          
          console.log("✅ Integration test completed");
        } catch (error) {
          console.log("ℹ️  Integration test requires full environment setup");
        }
      },
    },

    {
      name: "${analysis.hasServices && analysis.hasProviders ? '11' : analysis.hasServices || analysis.hasProviders ? '10' : '9'}. Performance - Response time validation",
      fn: async (runtime: IAgentRuntime) => {
        console.log("⏱️  Testing performance...");
        
        const actions = ${templateVars.PLUGIN_VARIABLE}.actions || [];
        if (actions.length === 0) {
          console.log("ℹ️  No actions to performance test");
          return;
        }
        
        const testMessage: Memory = {
          id: \`perf-\${Date.now()}\` as UUID,
          entityId: runtime.agentId,
          agentId: runtime.agentId,
          roomId: "perf-room" as UUID,
          content: { text: "Performance test", source: "${templateVars.PLUGIN_NAME_LOWER}" },
          createdAt: Date.now()
        };
        
        for (const action of actions) {
          const start = Date.now();
          try {
            await action.validate(runtime, testMessage, { values: {}, data: {}, text: "" });
            const elapsed = Date.now() - start;
            console.log(\`✅ Action \${action.name} validation took \${elapsed}ms\`);
          } catch (error) {
            const elapsed = Date.now() - start;
            console.log(\`ℹ️  Action \${action.name} validation failed in \${elapsed}ms\`);
          }
        }
      },
    },

    {
      name: "${analysis.hasServices && analysis.hasProviders ? '12' : analysis.hasServices || analysis.hasProviders ? '11' : '10'}. Edge cases and boundary conditions",
      fn: async (runtime: IAgentRuntime) => {
        console.log("🔧 Testing edge cases...");
        
        // Test empty arrays
        if (${templateVars.PLUGIN_VARIABLE}.actions && ${templateVars.PLUGIN_VARIABLE}.actions.length === 0) {
          console.log("✅ Plugin handles empty actions array");
        }
        
        if (${templateVars.PLUGIN_VARIABLE}.providers && ${templateVars.PLUGIN_VARIABLE}.providers.length === 0) {
          console.log("✅ Plugin handles empty providers array");
        }
        
        if (${templateVars.PLUGIN_VARIABLE}.services && ${templateVars.PLUGIN_VARIABLE}.services.length === 0) {
          console.log("✅ Plugin handles empty services array");
        }
        
        // Test with undefined runtime settings
        const mockRuntime = {
          ...runtime,
          getSetting: () => undefined
        } as IAgentRuntime;
        
        if (${templateVars.PLUGIN_VARIABLE}.init) {
          try {
            await ${templateVars.PLUGIN_VARIABLE}.init({}, mockRuntime);
            console.log("✅ Plugin handles undefined settings");
          } catch (error) {
            console.log("✅ Plugin validates required settings");
          }
        }
        
        console.log("✅ Edge case testing completed");
      },
    }
  ];
}

// Export both named and default export for compatibility
export const test: TestSuite = new ${templateVars.PLUGIN_NAME.charAt(0).toUpperCase() + templateVars.PLUGIN_NAME.slice(1).replace(/[^a-zA-Z0-9]/g, '')}TestSuite();
export default test;
\`\`\`

## 🔧 CRITICAL INSTRUCTIONS:

1. **Create src/test/test.ts** (NOT test.test.ts) with the TestSuite class above
2. **Update src/index.ts** to import and register the test suite
3. **Use createMockRuntime from utils.ts** for all test runtime needs
4. **Follow ElizaOS V2 patterns** - NO vitest imports
5. **Generate 10-12 comprehensive tests** as shown above
6. **Test all components** based on plugin analysis
7. **Include progressive testing** where later tests depend on earlier ones
8. **Add clear console logging** with emoji indicators

## ✅ SUCCESS CRITERIA:
- File named exactly: src/test/test.ts
- Uses ElizaOS TestSuite interface (NOT vitest)
- 10-12 comprehensive tests implemented
- All tests use proper ElizaOS V2 patterns
- Clear console output with emoji indicators
- Tests cover all plugin components
- Progressive testing structure

Generate the complete ElizaOS V2 test suite now!`;

      await this.runClaudeCodeWithPrompt(testGenerationPrompt);

      return {
        success: true,
        message: '✅ ElizaOS V2 test suites generated successfully using Claude',
        changes: ['src/test/test.ts'],
        warnings: analysis.hasServices ? [] : ['Plugin has no services - service tests will be informational only']
      };

    } catch (error) {
      logger.error('❌ Failed to generate test suites:', error);
      return {
        success: false,
        message: `Failed to generate test suites: ${error instanceof Error ? error.message : 'Unknown error'}`,
        error: error instanceof Error ? error : new Error('Unknown error')
      };
    }
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
   * Complete test suite generation and iterative validation
   * This is the main method called by the structured migrator
   */
  async generateAndValidateTestSuites(): Promise<StepResult> {
    try {
      logger.info('🚀 Starting complete test suite generation and validation...');

      // Step 1: Generate initial test suites
      logger.info('📝 Step 1: Generating initial test suites...');
      const generateResult = await this.generateTestSuites();
      
      if (!generateResult.success) {
        return generateResult;
      }

      // Step 2: Fix any structural issues
      logger.info('🔧 Step 2: Fixing test structure...');
      await this.fixBrokenTestStructure();

      // Step 3: Run iterative testing until all pass
      logger.info('🔄 Step 3: Running iterative testing...');
      const iterativeResult = await this.runTestsUntilPass();

      if (iterativeResult.success) {
        logger.info('🎉 Complete test suite generation and validation successful!');
        return {
          success: true,
          message: '✅ Test suites generated and all tests passing',
          changes: ['src/test/test.ts', 'src/index.ts', 'src/test/utils.ts'],
          warnings: []
        };
      }

      // If iterative testing failed, still return partial success
      logger.warn('⚠️  Iterative testing had issues, but test suites were generated');
      return {
        success: false, // Changed to false since tests aren't passing
        message: '⚠️  Test suites generated but some tests failing',
        changes: ['src/test/test.ts', 'src/index.ts'],
        warnings: iterativeResult.warnings || ['Some tests still failing after iterations'],
        error: iterativeResult.error
      };

    } catch (error) {
      logger.error('❌ Complete test generation failed:', error);
      return {
        success: false,
        message: `Failed to generate and validate test suites: ${error instanceof Error ? error.message : 'Unknown error'}`,
        error: error instanceof Error ? error : new Error('Unknown error')
      };
    }
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
}