/**
 * CONFIGURATION MIGRATION STEPS
 * 
 * Responsibilities:
 * - Service class creation for V2 architecture
 * - Configuration file creation with Zod validation
 * - Environment variable template creation
 * - Zod schema analysis for required fields
 */

import { logger } from '@elizaos/core';
import * as fs from 'fs-extra';
import * as path from 'node:path';
import type { MigrationContext, StepResult } from '../types.js';

export class ConfigurationSteps {
  private context: MigrationContext;

  constructor(context: MigrationContext) {
    this.context = context;
  }

  /**
   * Create Service class for plugins that had services in V1
   */
  async createServiceClass(ctx: MigrationContext): Promise<StepResult> {
    // Double-check that service should be created
    if (!ctx.hasService) {
      logger.warn('⚠️  Skipping service creation - no service found in main branch');
      return {
        success: true,
        message: 'No service needed - plugin did not have service in V1',
        warnings: ['Service creation skipped - not present in original plugin'],
      };
    }

    const promptContent = `Create a Service class for the ${ctx.pluginName} plugin following V2 architecture:

⚠️ IMPORTANT: This plugin HAD a service in V1, so we are migrating it to V2.

1. Extend base Service class from @elizaos/core
2. Implement static serviceType property
3. Implement static start() method
4. Implement stop() method for cleanup
5. Implement capabilityDescription getter
6. Add proper constructor with runtime parameter

Example structure:
\`\`\`typescript
export class MyService extends Service {
    static serviceType: string = 'my-service';
    
    constructor(runtime: IAgentRuntime) {
        super(runtime);
    }
    
    static async start(runtime: IAgentRuntime) {
        const service = new MyService(runtime);
        return service;
    }
    
    async stop(): Promise<void> {
        // Cleanup resources
    }
    
    get capabilityDescription(): string {
        return 'Service capability description';
    }
}
\`\`\``;

    ctx.claudePrompts.set('create-service', promptContent);

    return {
      success: true,
      message: 'Prepared Service class creation prompt',
      warnings: ['Requires Claude to implement Service class'],
    };
  }

  /**
   * Create config.ts with Zod validation
   */
  async createConfig(ctx: MigrationContext): Promise<StepResult> {
    const promptContent = `Create a config.ts file with Zod validation for the ${ctx.pluginName} plugin:

1. Import zod and IAgentRuntime type
2. Create ConfigSchema with all required configuration fields
3. Export type from schema inference
4. Create validateConfig function that uses runtime.getSetting()
5. Handle both runtime settings and environment variables

Example:
\`\`\`typescript
import { z } from 'zod';
import { type IAgentRuntime } from '@elizaos/core';

export const ConfigSchema = z.object({
    API_KEY: z.string().min(1, "API key is required"),
    API_ENDPOINT: z.string().url().optional(),
    ENABLE_FEATURE: z.boolean().default(false),
});

export type MyConfig = z.infer<typeof ConfigSchema>;

export function validateMyConfig(runtime: IAgentRuntime): MyConfig {
    const config = {
        API_KEY: runtime.getSetting('MY_API_KEY') || process.env.MY_API_KEY,
        API_ENDPOINT: runtime.getSetting('MY_API_ENDPOINT') || process.env.MY_API_ENDPOINT,
        ENABLE_FEATURE: runtime.getSetting('MY_ENABLE_FEATURE') === 'true',
    };
    
    return ConfigSchema.parse(config);
}
\`\`\``;

    ctx.claudePrompts.set('create-config', promptContent);

    return {
      success: true,
      message: 'Prepared config.ts creation prompt',
      warnings: ['Requires Claude to implement configuration'],
    };
  }

  /**
   * Create environment template with required fields analysis
   */
  async createEnvironmentTemplate(ctx: MigrationContext): Promise<StepResult> {
    const envExamplePath = path.join(ctx.repoPath, '.env.example');
    
    // Analyze config.ts to find required fields with improved analysis
    const configPath = path.join(ctx.repoPath, 'src', 'config.ts');
    let requiredEnvVars: string[] = [];
    
    if (await fs.pathExists(configPath)) {
      const configContent = await fs.readFile(configPath, 'utf-8');
      
      // Use improved Zod schema analysis
      requiredEnvVars = await this.analyzeZodSchemaForRequiredFields(configContent);
    }
    
    // Always include OPENAI_API_KEY as it's mandatory for ElizaOS
    const allRequiredVars = ['OPENAI_API_KEY', ...requiredEnvVars.filter(v => v !== 'OPENAI_API_KEY')];
    
    // If no other required vars found, try to guess based on common patterns
    if (allRequiredVars.length === 1) { // Only OPENAI_API_KEY
      const pluginNameUpper = ctx.pluginName
        .replace('@elizaos/plugin-', '')
        .replace('plugin-', '')
        .toUpperCase()
        .replace(/-/g, '_');
      
      // Default to API_KEY as it's almost always required
      allRequiredVars.push(`${pluginNameUpper}_API_KEY`);
    }
    
    // Create .env.example with all required fields
    const envEntries = allRequiredVars.map(varName => {
      if (varName === 'OPENAI_API_KEY') {
        return `# Required - ElizaOS core functionality\n${varName}=your_openai_api_key_here`;
      }
      return `# Required - Plugin will not function without this\n${varName}=your_${varName.toLowerCase()}_here`;
    });
    
    const headerComment = `# ${ctx.pluginName} Configuration
# All required environment variables are listed below
# 
# NOTE: During migration, you will be prompted to enter these values interactively.
# Alternatively, you can manually configure them here after migration.
# 
# To use this plugin:
# 1. Run migration - you'll be prompted for values
# 2. Or manually edit the .env file with actual values
# 3. Replace 'your_*_here' with real values\n\n`;
    
    const finalContent = `${headerComment}${envEntries.join('\n\n')}\n`;
    
    await fs.writeFile(envExamplePath, finalContent);
    ctx.changedFiles.add('.env.example');
    
    logger.info(`✅ Created .env.example with ${allRequiredVars.length} required field(s)`);
    logger.info('   💡 Environment variables will be collected interactively during migration');
    for (const v of allRequiredVars) {
      if (v === 'OPENAI_API_KEY') {
        logger.info(`   - ${v} (required for ElizaOS core)`);
      } else {
        logger.info(`   - ${v} (required, no default)`);
      }
    }

    return {
      success: true,
      message: `Created .env.example with required fields including OPENAI_API_KEY: ${allRequiredVars.join(', ')}`,
      changes: ['.env.example'],
    };
  }

  /**
   * IMPROVED: Enhanced Zod schema analysis for better environment variable detection
   */
  private async analyzeZodSchemaForRequiredFields(configContent: string): Promise<string[]> {
    const requiredFields: string[] = [];
    
    try {
      // Find the main ConfigSchema definition
      const schemaMatch = configContent.match(/(?:export\s+)?const\s+\w*ConfigSchema\s*=\s*z\.object\s*\(\s*{([\s\S]*?)}\s*\)/);
      if (!schemaMatch) {
        logger.warn('Could not find Zod schema in config.ts');
        return [];
      }
      
      const schemaContent = schemaMatch[1];
      
      // Parse field definitions with improved multi-line support
      const fields = this.parseZodSchemaFields(schemaContent);
      
      // Filter for required fields (no default, no optional)
      for (const field of fields) {
        if (field.required && !field.hasDefault && !field.isOptional) {
          // Convert field name to environment variable name
          const envVarName = this.fieldNameToEnvVar(field.name);
          requiredFields.push(envVarName);
        }
      }
      
      logger.info(`✅ Analyzed Zod schema: found ${fields.length} fields, ${requiredFields.length} required`);
      
    } catch (error) {
      logger.warn('Error analyzing Zod schema:', error);
    }
    
    return requiredFields;
  }

  /**
   * Parse Zod schema field definitions with support for multi-line and complex patterns
   */
  private parseZodSchemaFields(schemaContent: string): Array<{
    name: string;
    required: boolean;
    hasDefault: boolean;
    isOptional: boolean;
    type: string;
  }> {
    const fields: Array<{
      name: string;
      required: boolean;
      hasDefault: boolean;
      isOptional: boolean;
      type: string;
    }> = [];
    
    // Handle multi-line field definitions
    // This regex handles fields that may span multiple lines
    const fieldPattern = /(\w+):\s*z\.([^,}]+(?:\n\s*[^,}]+)*)/g;
    
    let match: RegExpExecArray | null;
    fieldPattern.lastIndex = 0; // Reset regex state
    match = fieldPattern.exec(schemaContent);
    while (match !== null) {
      const [, fieldName, fieldDefinition] = match;
      
      // Clean up the field definition by removing extra whitespace
      const cleanDef = fieldDefinition.replace(/\s+/g, ' ').trim();
      
      // Analyze the field definition
      const analysis = this.analyzeZodFieldDefinition(cleanDef);
      
      fields.push({
        name: fieldName,
        required: analysis.required,
        hasDefault: analysis.hasDefault,
        isOptional: analysis.isOptional,
        type: analysis.type
      });
      
      match = fieldPattern.exec(schemaContent);
    }
    
    return fields;
  }

  /**
   * Analyze a single Zod field definition to determine its requirements
   */
  private analyzeZodFieldDefinition(fieldDef: string): {
    required: boolean;
    hasDefault: boolean;
    isOptional: boolean;
    type: string;
  } {
    // Check for default values
    const hasDefault = /\.default\s*\(/.test(fieldDef);
    
    // Check for optional modifier
    const isOptional = /\.optional\s*\(\s*\)/.test(fieldDef);
    
    // Check for validation that implies required (like .min())
    const hasValidation = /\.min\s*\(/.test(fieldDef) || 
                         /\.max\s*\(/.test(fieldDef) ||
                         /\.length\s*\(/.test(fieldDef) ||
                         /\.regex\s*\(/.test(fieldDef) ||
                         /\.email\s*\(/.test(fieldDef) ||
                         /\.url\s*\(/.test(fieldDef);
    
    // Determine base type
    let type = 'unknown';
    if (fieldDef.includes('z.string')) type = 'string';
    else if (fieldDef.includes('z.number') || fieldDef.includes('z.coerce.number')) type = 'number';
    else if (fieldDef.includes('z.boolean')) type = 'boolean';
    else if (fieldDef.includes('z.array')) type = 'array';
    else if (fieldDef.includes('z.object')) type = 'object';
    
    // A field is required if:
    // 1. It has validation (like .min()) AND
    // 2. It doesn't have a default value AND
    // 3. It's not marked as optional
    const required = hasValidation && !hasDefault && !isOptional;
    
    return {
      required,
      hasDefault,
      isOptional,
      type
    };
  }

  /**
   * Convert a field name to environment variable format
   */
  private fieldNameToEnvVar(fieldName: string): string {
    // Convert camelCase to UPPER_SNAKE_CASE
    const envVarName = fieldName
      .replace(/([a-z])([A-Z])/g, '$1_$2') // Insert underscore before capital letters
      .toUpperCase();
    
    // If it doesn't already end with common suffixes, it might need a prefix
    // This is a heuristic based on common patterns
    if (!envVarName.includes('API_KEY') && 
        !envVarName.includes('TOKEN') && 
        !envVarName.includes('SECRET') &&
        !envVarName.includes('ENDPOINT') &&
        !envVarName.includes('URL')) {
      // This might be a field that maps to a prefixed env var
      // We'll return it as-is and let the calling code handle prefixing
    }
    
    return envVarName;
  }
} 