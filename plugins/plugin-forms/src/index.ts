import type { Plugin } from '@elizaos/core';
import { FormsService } from './services/forms-service';
import { formsProvider } from './providers/forms-provider';
import { createFormAction } from './actions/create-form';
import { updateFormAction } from './actions/update-form';
import { cancelFormAction } from './actions/cancel-form';
import { FormsPluginTestSuite } from './tests';
import { formsSchema } from './schema';

// Export types
export * from './types';

// Export service
export { FormsService };

// Export provider
export { formsProvider };

// Export actions
export { createFormAction, updateFormAction, cancelFormAction };

// Export schema
export { formsSchema };

/**
 * Forms Plugin for ElizaOS
 *
 * This plugin provides structured form collection capabilities for agents,
 * allowing them to gather information from users in a conversational manner.
 *
 * Features:
 * - Multi-step forms with field validation
 * - LLM-based value extraction from natural language
 * - Secret field handling for sensitive data
 * - Form templates for common use cases
 * - Step and form completion callbacks
 * - Provider for showing active form state
 * - Database persistence for form state
 *
 * Usage:
 * 1. Add the plugin to your agent's plugins array
 * 2. The agent will automatically recognize form-related requests
 * 3. Forms are filled through natural conversation
 * 4. Other plugins can use the FormsService to create custom forms
 */
export const formsPlugin: Plugin = {
  name: '@elizaos/plugin-forms',
  description: 'Structured form collection capabilities for conversational data gathering',

  services: [FormsService],
  providers: [formsProvider],
  actions: [createFormAction, updateFormAction, cancelFormAction],

  // Database schema for persistence
  schema: formsSchema,

  // No evaluators needed for this plugin
  evaluators: [],

  // Test suite for the plugin
  tests: [FormsPluginTestSuite],

  // Dependencies
  dependencies: ['@elizaos/plugin-sql'],
  testDependencies: ['@elizaos/plugin-sql'],
};

export default formsPlugin;
