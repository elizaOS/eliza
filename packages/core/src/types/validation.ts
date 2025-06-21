import type { ComponentDependency } from './plugin';

// Re-export ComponentDependency so it can be imported from validation.js
export type { ComponentDependency } from './plugin';

/**
 * Validation result for component dependencies
 */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Context for component validation
 */
export interface ComponentValidationContext {
  pluginName: string;
  componentName: string;
  componentType: 'action' | 'provider' | 'evaluator' | 'service';
  dependencies: ComponentDependency[];
  enabledComponents: Map<string, Set<string>>;
}

/**
 * Validation result for an entire plugin
 */
export interface PluginValidationResult {
  pluginName: string;
  valid: boolean;
  componentResults: Map<string, ValidationResult>;
  overallErrors: string[];
  overallWarnings: string[];
}

/**
 * Component registration context tracking
 */
export interface ComponentRegistrationContext {
  pluginName: string;
  componentName: string;
  componentType: 'action' | 'provider' | 'evaluator' | 'service';
  config: any;
  enabled: boolean;
  legacy?: boolean;
}