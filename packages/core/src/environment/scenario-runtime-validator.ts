import type { 
  PluginScenario, 
  PluginEnvironmentValidation,
  ScenarioCharacter 
} from '../types/scenario';
import type { IAgentRuntime } from '../types/runtime';
import type { Plugin } from '../types/plugin';
import { PluginEnvironmentValidator } from './plugin-environment-validator';

/**
 * Validates that scenarios can run in the current runtime environment
 */
export class ScenarioRuntimeValidator {
  /**
   * Validates a single scenario for runtime execution
   */
  static async validateScenario(
    scenario: PluginScenario,
    runtime: IAgentRuntime
  ): Promise<{
    canRun: boolean;
    skipReason?: string;
    environmentValidations: PluginEnvironmentValidation[];
    missingPlugins: string[];
    warnings: string[];
  }> {
    const result = {
      canRun: true,
      skipReason: undefined as string | undefined,
      environmentValidations: [] as PluginEnvironmentValidation[],
      missingPlugins: [] as string[],
      warnings: [] as string[]
    };

    try {
      // 1. Validate environment variables for all plugins
      result.environmentValidations = await PluginEnvironmentValidator.validateScenarioEnvironment(
        scenario, 
        runtime
      );

      // 2. Check if all required environment variables are available
      const envSummary = PluginEnvironmentValidator.getEnvironmentSummary(result.environmentValidations);
      
      if (!envSummary.allValid) {
        result.canRun = false;
        result.skipReason = `Missing required environment variables: ${envSummary.missingVars.join(', ')}`;
        return result;
      }

      // 3. Check if all required plugins are available in runtime
      const availablePlugins = new Set(runtime.plugins.map(p => p.name));
      const requiredPlugins = this.getAllRequiredPlugins(scenario);

      for (const pluginName of requiredPlugins) {
        if (!availablePlugins.has(pluginName)) {
          result.missingPlugins.push(pluginName);
        }
      }

      if (result.missingPlugins.length > 0) {
        result.canRun = false;
        result.skipReason = `Missing required plugins: ${result.missingPlugins.join(', ')}`;
        return result;
      }

      // 4. Add warnings for optional environment variables
      if (envSummary.warningCount > 0) {
        result.warnings.push(`${envSummary.warningCount} optional environment variables are not configured`);
      }

      // 5. Validate character configurations
      const characterValidation = this.validateCharacters(scenario.characters);
      if (!characterValidation.isValid) {
        result.canRun = false;
        result.skipReason = characterValidation.reason;
        return result;
      }

      if (characterValidation.warnings.length > 0) {
        result.warnings.push(...characterValidation.warnings);
      }

    } catch (error) {
      result.canRun = false;
      result.skipReason = `Validation error: ${error instanceof Error ? error.message : String(error)}`;
    }

    return result;
  }

  /**
   * Validates multiple scenarios and returns execution plan
   */
  static async validateScenarios(
    scenarios: PluginScenario[],
    runtime: IAgentRuntime
  ): Promise<{
    executable: PluginScenario[];
    skipped: Array<{ scenario: PluginScenario; reason: string }>;
    warnings: string[];
    environmentValidations: Map<string, PluginEnvironmentValidation[]>;
  }> {
    const executable: PluginScenario[] = [];
    const skipped: Array<{ scenario: PluginScenario; reason: string }> = [];
    const warnings: string[] = [];
    const environmentValidations = new Map<string, PluginEnvironmentValidation[]>();

    for (const scenario of scenarios) {
      const validation = await this.validateScenario(scenario, runtime);
      
      environmentValidations.set(scenario.id, validation.environmentValidations);

      if (validation.canRun) {
        executable.push(scenario);
        if (validation.warnings.length > 0) {
          warnings.push(`Scenario ${scenario.name}: ${validation.warnings.join('; ')}`);
        }
      } else {
        skipped.push({ 
          scenario, 
          reason: validation.skipReason || 'Unknown validation error'
        });
      }
    }

    return {
      executable,
      skipped,
      warnings,
      environmentValidations
    };
  }

  /**
   * Gets all unique plugins required by a scenario
   */
  private static getAllRequiredPlugins(scenario: PluginScenario): Set<string> {
    const plugins = new Set<string>();
    
    for (const character of scenario.characters) {
      for (const plugin of character.plugins) {
        plugins.add(plugin);
      }
    }

    return plugins;
  }

  /**
   * Validates character configurations for the scenario
   */
  private static validateCharacters(characters: ScenarioCharacter[]): {
    isValid: boolean;
    reason?: string;
    warnings: string[];
  } {
    const warnings: string[] = [];

    // Check for duplicate character IDs
    const characterIds = characters.map(c => c.id);
    const uniqueIds = new Set(characterIds);
    
    if (characterIds.length !== uniqueIds.size) {
      return {
        isValid: false,
        reason: 'Duplicate character IDs found in scenario',
        warnings
      };
    }

    // Check for at least one character
    if (characters.length === 0) {
      return {
        isValid: false,
        reason: 'Scenario must have at least one character',
        warnings
      };
    }

    // Validate character roles
    const validRoles = ['subject', 'observer', 'assistant', 'adversary'];
    for (const character of characters) {
      if (!validRoles.includes(character.role)) {
        warnings.push(`Character ${character.name} has invalid role: ${character.role}`);
      }

      // Check for required plugins
      if (!character.plugins || character.plugins.length === 0) {
        warnings.push(`Character ${character.name} has no plugins configured`);
      }

      // Validate basic required fields
      if (!character.name || character.name.trim() === '') {
        return {
          isValid: false,
          reason: `Character ${character.id} is missing required name`,
          warnings
        };
      }
    }

    return {
      isValid: true,
      warnings
    };
  }

  /**
   * Creates a summary report of scenario validation results
   */
  static createValidationReport(
    scenarios: PluginScenario[],
    validationResults: {
      executable: PluginScenario[];
      skipped: Array<{ scenario: PluginScenario; reason: string }>;
      warnings: string[];
      environmentValidations: Map<string, PluginEnvironmentValidation[]>;
    }
  ): string {
    const lines: string[] = [];
    
    lines.push('# Scenario Validation Report');
    lines.push('');
    lines.push(`Total scenarios: ${scenarios.length}`);
    lines.push(`Executable: ${validationResults.executable.length}`);
    lines.push(`Skipped: ${validationResults.skipped.length}`);
    lines.push('');

    if (validationResults.executable.length > 0) {
      lines.push('## Executable Scenarios');
      for (const scenario of validationResults.executable) {
        lines.push(`- ✅ ${scenario.name} (${scenario.id})`);
      }
      lines.push('');
    }

    if (validationResults.skipped.length > 0) {
      lines.push('## Skipped Scenarios');
      for (const { scenario, reason } of validationResults.skipped) {
        lines.push(`- ❌ ${scenario.name} (${scenario.id})`);
        lines.push(`  Reason: ${reason}`);
      }
      lines.push('');
    }

    if (validationResults.warnings.length > 0) {
      lines.push('## Warnings');
      for (const warning of validationResults.warnings) {
        lines.push(`- ⚠️ ${warning}`);
      }
      lines.push('');
    }

    // Environment variable summary
    const allEnvValidations = Array.from(validationResults.environmentValidations.values()).flat();
    const allMissingVars = new Set(allEnvValidations.flatMap(v => v.missingVars));
    const allWarningVars = new Set(
      allEnvValidations.flatMap(v => 
        v.warnings.filter(w => w.includes('not set')).map(w => w.match(/(\w+) is not set/)?.[1]).filter(Boolean)
      )
    );

    if (allMissingVars.size > 0) {
      lines.push('## Missing Environment Variables');
      for (const varName of allMissingVars) {
        lines.push(`- ${varName} (required)`);
      }
      lines.push('');
    }

    if (allWarningVars.size > 0) {
      lines.push('## Optional Environment Variables');
      for (const varName of allWarningVars) {
        lines.push(`- ${varName} (optional)`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }
}