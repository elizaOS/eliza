/**
 * TEMPLATE GENERATOR
 * 
 * Responsibilities:
 * - Delegate to centralized test template generation
 * - Provide backward compatibility interface
 * - Maintain existing API while using centralized logic
 */

import { logger } from '@elizaos/core';
import type { PluginAnalysis, TestTemplateVariables } from './types.js';
// Import centralized template generation functions
import { generateRobustTemplateVariables } from '../test-templates/test-template.js';

export class TemplateGenerator {
  private packageJson: { name?: string; [key: string]: unknown };

  constructor(packageJson: { name?: string; [key: string]: unknown }) {
    this.packageJson = packageJson;
  }

  /**
   * Generate robust template variables using centralized logic from test-template.ts
   * This maintains backward compatibility while delegating to the centralized implementation
   */
  generateRobustTemplateVariables(analysis: PluginAnalysis): TestTemplateVariables {
    logger.info('Generating template variables using centralized test-template logic...');
    
    // Use centralized function from test-template.ts
    const variables = generateRobustTemplateVariables(analysis.name, this.packageJson);
    
    logger.info('Generated robust template variables:', variables);
    
    return variables;
  }
} 