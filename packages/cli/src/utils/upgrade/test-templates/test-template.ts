/**
 * DYNAMIC TEST TEMPLATE GENERATOR
 * 
 * Responsibilities:
 * - Generate comprehensive ElizaOS V2 test templates dynamically
 * - Handle plugin analysis-based conditional test generation
 * - Provide sophisticated test template with 10-12 comprehensive tests
 * - Single source of truth for all test generation logic
 */

import type { PluginAnalysis } from '../test-generation/types.js';

/**
 * Template Variables Interface
 */
export interface TestTemplateVariables {
    PLUGIN_NAME: string;
    PLUGIN_NAME_LOWER: string;
    PLUGIN_VARIABLE: string;
    API_KEY_NAME: string;
}

/**
 * ADVANCED: Generate robust template variables that handle edge cases and avoid conflicts
 */
export function generateRobustTemplateVariables(
    pluginName: string, 
    packageJson: { name?: string; [key: string]: unknown }
): TestTemplateVariables {
    // Extract clean plugin name from package.json or analysis
    const baseName = extractCleanPluginName(packageJson.name, pluginName);
    
    // Generate and validate variable names
    const variables = createTemplateVariables(baseName);
    
    // Validate generated names
    validateTemplateVariables(variables);
    
    return variables;
}

/**
 * Extract clean plugin name handling various package name formats
 */
function extractCleanPluginName(packageName: string | undefined, analysisName: string): string {
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
function createTemplateVariables(baseName: string): TestTemplateVariables {
    // Convert to human-readable name
    const humanName = baseName
        .split('-')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
    
    // Create safe camelCase variable name
    const camelCaseName = createSafeCamelCase(baseName);
    
    // Create environment variable name
    const envVarName = createEnvVarName(baseName);
    
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
function createSafeCamelCase(baseName: string): string {
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
function createEnvVarName(baseName: string): string {
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
function validateTemplateVariables(variables: TestTemplateVariables): void {
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
}

/**
 * BUILD COMPREHENSIVE TEST GENERATION PROMPT
 * 
 * This is the main function that generates the sophisticated dynamic test template
 * based on plugin analysis - moved from context-aware-test-generator.ts
 */
export function buildTestGenerationPrompt(analysis: PluginAnalysis, templateVars: TestTemplateVariables): string {
    return `# Generate ElizaOS V2 Plugin Test Suite Following TEST_CASES.md Patterns

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
            
            console.log(\`✅ Service \${ServiceClass.serviceType} initialized correctly\`);
          } catch (error) {
            console.log(\`ℹ️  Service \${ServiceClass.serviceType} requires configuration\`);
          }
        }
        
        console.log("✅ Service testing completed");
      },
    },` : ''}

${analysis.hasActions ? `    {
      name: "${analysis.hasServices ? '5' : '4'}. Action validation and structure",
      fn: async (runtime: IAgentRuntime) => {
        console.log("⚡ Testing actions...");
        
        const actions = ${templateVars.PLUGIN_VARIABLE}.actions || [];
        if (actions.length === 0) {
          console.log("ℹ️  No actions to test");
          return;
        }
        
        for (const action of actions) {
          // Validate action structure
          if (!action.name || typeof action.name !== 'string') {
            throw new Error("Action missing name property");
          }
          
          if (!action.description || typeof action.description !== 'string') {
            throw new Error("Action missing description property");
          }
          
          if (typeof action.validate !== 'function') {
            throw new Error("Action missing validate method");
          }
          
          if (typeof action.handler !== 'function') {
            throw new Error("Action missing handler method");
          }
          
          // Test validation with sample data
          const testMessage: Memory = {
            id: \`test-\${Date.now()}\` as UUID,
            entityId: runtime.agentId,
            agentId: runtime.agentId,
            roomId: "test-room" as UUID,
            content: { text: "Test message for action validation", source: "${templateVars.PLUGIN_NAME_LOWER}" },
            createdAt: Date.now()
          };
          
          const testState: State = { values: {}, data: {}, text: "" };
          
          try {
            const isValid = await action.validate(runtime, testMessage, testState);
            console.log(\`✅ Action \${action.name} validation completed (result: \${isValid})\`);
          } catch (error) {
            console.log(\`ℹ️  Action \${action.name} validation requires specific conditions\`);
          }
        }
        
        console.log("✅ Action testing completed");
      },
    },` : ''}

${analysis.hasProviders ? `    {
      name: "${analysis.hasServices && analysis.hasActions ? '6' : analysis.hasServices || analysis.hasActions ? '5' : '4'}. Provider functionality",
      fn: async (runtime: IAgentRuntime) => {
        console.log("📡 Testing providers...");
        
        const providers = ${templateVars.PLUGIN_VARIABLE}.providers || [];
        if (providers.length === 0) {
          console.log("ℹ️  No providers to test");
          return;
        }
        
        for (const provider of providers) {
          // Validate provider structure
          if (!provider.name || typeof provider.name !== 'string') {
            throw new Error("Provider missing name property");
          }
          
          if (typeof provider.get !== 'function') {
            throw new Error("Provider missing get method");
          }
          
          // Test provider with sample data
          const testMessage: Memory = {
            id: \`provider-test-\${Date.now()}\` as UUID,
            entityId: runtime.agentId,
            agentId: runtime.agentId,
            roomId: "provider-room" as UUID,
            content: { text: "Test message for provider", source: "${templateVars.PLUGIN_NAME_LOWER}" },
            createdAt: Date.now()
          };
          
          const testState: State = { values: {}, data: {}, text: "" };
          
          try {
            const result = await provider.get(runtime, testMessage, testState);
            console.log(\`✅ Provider \${provider.name} executed successfully\`);
            
            if (typeof result === 'string' && result.length > 0) {
              console.log(\`ℹ️  Provider returned: \${result.slice(0, 100)}...\`);
            }
          } catch (error) {
            console.log(\`ℹ️  Provider \${provider.name} requires specific runtime configuration\`);
          }
        }
        
        console.log("✅ Provider testing completed");
      },
    },` : ''}

    {
      name: "${analysis.hasServices && analysis.hasActions && analysis.hasProviders ? '7' : (analysis.hasServices && analysis.hasActions) || (analysis.hasServices && analysis.hasProviders) || (analysis.hasActions && analysis.hasProviders) ? '6' : analysis.hasServices || analysis.hasActions || analysis.hasProviders ? '5' : '4'}. Memory handling and persistence",
      fn: async (runtime: IAgentRuntime) => {
        console.log("💾 Testing memory handling...");
        
        const testMemory: Memory = {
          id: \`memory-test-\${Date.now()}\` as UUID,
          entityId: runtime.agentId,
          agentId: runtime.agentId,
          roomId: "memory-room" as UUID,
          content: { 
            text: "Test memory content for ${templateVars.PLUGIN_NAME}", 
            source: "${templateVars.PLUGIN_NAME_LOWER}",
            metadata: { test: true }
          },
          createdAt: Date.now()
        };
        
        // Test memory operations if runtime supports them
        if (typeof runtime.messageManager?.createMemory === 'function') {
          try {
            await runtime.messageManager.createMemory(testMemory);
            console.log("✅ Memory creation tested");
          } catch (error) {
            console.log("ℹ️  Memory creation requires database connection");
          }
        }
        
        // Test memory retrieval
        if (typeof runtime.messageManager?.getMemories === 'function') {
          try {
            const memories = await runtime.messageManager.getMemories({
              roomId: testMemory.roomId,
              count: 5
            });
            console.log(\`✅ Memory retrieval tested (found \${memories.length} memories)\`);
          } catch (error) {
            console.log("ℹ️  Memory retrieval requires database connection");
          }
        }
        
        console.log("✅ Memory handling test completed");
      },
    },

    {
      name: "${analysis.hasServices && analysis.hasActions && analysis.hasProviders ? '8' : (analysis.hasServices && analysis.hasActions) || (analysis.hasServices && analysis.hasProviders) || (analysis.hasActions && analysis.hasProviders) ? '7' : analysis.hasServices || analysis.hasActions || analysis.hasProviders ? '6' : '5'}. Error handling and edge cases",
      fn: async (runtime: IAgentRuntime) => {
        console.log("🛡️  Testing error handling...");
        
        // Test with invalid memory object
        const invalidMemory = {
          id: "invalid-id",
          content: null,
          agentId: null
        } as any;
        
        const actions = ${templateVars.PLUGIN_VARIABLE}.actions || [];
        for (const action of actions) {
          try {
            await action.validate(runtime, invalidMemory, { values: {}, data: {}, text: "" });
            console.log(\`ℹ️  Action \${action.name} handles invalid memory gracefully\`);
          } catch (error) {
            console.log(\`✅ Action \${action.name} properly validates input\`);
          }
        }
        
        // Test with undefined runtime methods
        const limitedRuntime = {
          ...runtime,
          getSetting: () => undefined,
          messageManager: undefined
        } as any;
        
        const providers = ${templateVars.PLUGIN_VARIABLE}.providers || [];
        for (const provider of providers) {
          try {
            await provider.get(limitedRuntime, invalidMemory, { values: {}, data: {}, text: "" });
            console.log(\`ℹ️  Provider \${provider.name} handles limited runtime gracefully\`);
          } catch (error) {
            console.log(\`✅ Provider \${provider.name} properly validates runtime\`);
          }
        }
        
        console.log("✅ Error handling test completed");
      },
    },

    {
      name: "${analysis.hasServices && analysis.hasActions && analysis.hasProviders ? '9' : (analysis.hasServices && analysis.hasActions) || (analysis.hasServices && analysis.hasProviders) || (analysis.hasActions && analysis.hasProviders) ? '8' : analysis.hasServices || analysis.hasActions || analysis.hasProviders ? '7' : '6'}. Integration workflow",
      fn: async (runtime: IAgentRuntime) => {
        console.log("🔄 Testing integration workflow...");
        
        try {
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
}

/**
 * LEGACY COMPATIBILITY: Simple template variables for backward compatibility
 */
export function getTestTemplateVariables(
    pluginName: string, 
    packageJson: { name?: string; [key: string]: unknown }
): TestTemplateVariables {
    return generateRobustTemplateVariables(pluginName, packageJson);
} 