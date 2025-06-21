/**
 * TEST GENERATION TYPE DEFINITIONS
 * 
 * Responsibilities:
 * - Interface definitions for plugin analysis
 * - Template variable types
 * - Test generation result types
 */

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

export interface TestGenerationResult {
  success: boolean;
  message: string;
  testsGenerated: number;
  buildPassed: boolean;
  testsPassed: boolean;
  iterations: number;
  changes?: string[];
  warnings?: string[];
} 