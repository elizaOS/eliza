import type { 
  PluginEnvironmentValidation, 
  AgentConfigParameter, 
  PluginScenario, 
  ScenarioCharacter 
} from '../types/scenario';
import type { IAgentRuntime } from '../types/runtime';
import { logger } from '../logger';

/**
 * Validates plugin environment requirements for scenarios
 */
export class PluginEnvironmentValidator {
  /**
   * Validates environment variables for a single plugin
   */
  static async validatePluginEnvironment(
    pluginName: string, 
    runtime: IAgentRuntime
  ): Promise<PluginEnvironmentValidation> {
    const result: PluginEnvironmentValidation = {
      isValid: true,
      missingVars: [],
      warnings: [],
      pluginName
    };

    try {
      // Get plugin configuration from package.json
      const agentConfig = await this.getPluginAgentConfig(pluginName, runtime);
      
      if (!agentConfig?.pluginParameters) {
        // No environment requirements found
        return result;
      }

      // Check each required environment variable
      for (const [varName, config] of Object.entries(agentConfig.pluginParameters)) {
        const value = runtime.getSetting(varName);
        
        if (config.required && (!value || value === '')) {
          result.isValid = false;
          result.missingVars.push(varName);
        } else if (!config.required && (!value || value === '')) {
          result.warnings.push(`Optional environment variable ${varName} is not set`);
        }
        
        // Validate type if value exists
        if (value && config.type) {
          const typeValid = this.validateEnvironmentVariableType(value, config.type);
          if (!typeValid) {
            result.warnings.push(`Environment variable ${varName} has invalid type (expected ${config.type})`);
          }
        }
      }
    } catch (error) {
      result.warnings.push(`Failed to validate plugin ${pluginName}: ${error instanceof Error ? error.message : String(error)}`);
    }

    return result;
  }

  /**
   * Validates environment requirements for all plugins used by scenario characters
   */
  static async validateScenarioEnvironment(
    scenario: PluginScenario,
    runtime: IAgentRuntime
  ): Promise<PluginEnvironmentValidation[]> {
    const results: PluginEnvironmentValidation[] = [];
    const allPlugins = new Set<string>();

    // Collect all unique plugins from all characters
    for (const character of scenario.characters) {
      for (const plugin of character.plugins) {
        allPlugins.add(plugin);
      }
    }

    // Validate each plugin
    for (const pluginName of allPlugins) {
      const validation = await this.validatePluginEnvironment(pluginName, runtime);
      results.push(validation);
    }

    // Update scenario with computed requirements
    scenario.requiredEnvVars = this.extractRequiredVariables(results);

    return results;
  }

  /**
   * Determines if a scenario can run based on environment validation
   */
  static canScenarioRun(validations: PluginEnvironmentValidation[]): boolean {
    return validations.every(validation => validation.isValid);
  }

  /**
   * Gets environment requirements summary for a scenario
   */
  static getEnvironmentSummary(validations: PluginEnvironmentValidation[]): {
    allValid: boolean;
    missingCount: number;
    warningCount: number;
    missingVars: string[];
    affectedPlugins: string[];
  } {
    const missingVars = validations.flatMap(v => v.missingVars);
    const warningCount = validations.reduce((count, v) => count + v.warnings.length, 0);
    const affectedPlugins = validations.filter(v => !v.isValid).map(v => v.pluginName);

    return {
      allValid: validations.every(v => v.isValid),
      missingCount: missingVars.length,
      warningCount,
      missingVars,
      affectedPlugins
    };
  }

  /**
   * Attempts to get plugin agentConfig from package.json
   */
  private static async getPluginAgentConfig(
    pluginName: string, 
    runtime: IAgentRuntime
  ): Promise<{ pluginParameters?: Record<string, AgentConfigParameter> } | null> {
    try {
      // Try to find the plugin's package.json
      // This would typically be resolved from node_modules or plugin registry
      // For now, we'll attempt to use a generic approach
      
      if (typeof require !== 'undefined') {
        const packageJsonPath = require.resolve(`${pluginName}/package.json`);
        const packageJson = require(packageJsonPath);
        return packageJson.agentConfig || null;
      }

      // Fallback: try to import package.json directly if it exists
      try {
        const packageJson = await import(`${pluginName}/package.json`);
        return packageJson.agentConfig || null;
      } catch (importError) {
        // Plugin might not have package.json accessible
        logger.debug(`Could not load agentConfig for plugin ${pluginName}: ${importError}`);
        return null;
      }
    } catch (error) {
      logger.debug(`Failed to load agentConfig for plugin ${pluginName}: ${error}`);
      return null;
    }
  }

  /**
   * Validates that an environment variable matches the expected type
   */
  private static validateEnvironmentVariableType(value: any, expectedType: string): boolean {
    switch (expectedType.toLowerCase()) {
      case 'string':
        return typeof value === 'string';
      case 'number':
        return !isNaN(Number(value));
      case 'boolean':
        return value === 'true' || value === 'false' || typeof value === 'boolean';
      default:
        return true; // Unknown type, assume valid
    }
  }

  /**
   * Extracts all required environment variables from validation results
   */
  private static extractRequiredVariables(validations: PluginEnvironmentValidation[]): string[] {
    const required = new Set<string>();
    
    for (const validation of validations) {
      for (const varName of validation.missingVars) {
        required.add(varName);
      }
    }

    return Array.from(required);
  }
}