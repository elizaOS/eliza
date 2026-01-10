/**
 * Knowledge Plugin - Main Entry Point
 *
 * This file exports all the necessary functions and types for the Knowledge plugin.
 */
import type { Plugin, IAgentRuntime } from '@elizaos/core';
import { logger } from '@elizaos/core';
import { KnowledgeService } from './service';
import { knowledgeProvider } from './provider';
import { documentsProvider } from './documents-provider';
import knowledgeTestSuite from './tests';
import { knowledgeActions } from './actions';
import { knowledgeRoutes } from './routes';

/**
 * Configuration options for the Knowledge Plugin
 */
export interface KnowledgePluginConfig {
  /**
   * Enable frontend UI and routes
   * Set to false for cloud/server-only deployments
   * @default true
   */
  enableUI?: boolean;

  /**
   * Enable HTTP routes for document management
   * Set to false for browser-only or minimal deployments
   * @default true
   */
  enableRoutes?: boolean;

  /**
   * Enable actions (PROCESS_KNOWLEDGE, SEARCH_KNOWLEDGE)
   * @default true
   */
  enableActions?: boolean;

  /**
   * Enable tests
   * @default true
   */
  enableTests?: boolean;
}

/**
 * Create a Knowledge Plugin with custom configuration
 * @param config Plugin configuration options
 * @returns Configured Plugin instance
 *
 * @example
 * // Cloud runtime mode (service + provider only)
 * const plugin = createKnowledgePlugin({
 *   enableUI: false,
 *   enableRoutes: false,
 * });
 *
 * @example
 * // Browser-only mode (no routes)
 * const plugin = createKnowledgePlugin({
 *   enableRoutes: false,
 * });
 *
 * @example
 * // Full mode (default)
 * const plugin = createKnowledgePlugin();
 */
export function createKnowledgePlugin(config: KnowledgePluginConfig = {}): Plugin {
  const { enableUI = true, enableRoutes = true, enableActions = true, enableTests = true } = config;

  // Build plugin based on configuration
  const plugin: Plugin = {
    name: 'knowledge',
    description:
      'Plugin for Retrieval Augmented Generation, including knowledge management and embedding.',
    services: [KnowledgeService],
    providers: [knowledgeProvider, documentsProvider],
  };

  // Add routes only if UI or routes are enabled
  if (enableUI || enableRoutes) {
    plugin.routes = knowledgeRoutes;
    logger.debug('[Knowledge Plugin] Routes enabled');
  } else {
    logger.info('[Knowledge Plugin] Running in headless mode (no routes or UI)');
  }

  // Add actions if enabled
  if (enableActions) {
    plugin.actions = knowledgeActions;
  }

  // Add tests if enabled
  if (enableTests) {
    plugin.tests = [knowledgeTestSuite];
  }

  return plugin;
}

/**
 * Knowledge Plugin - Core mode (Service + Provider only)
 * Use this for cloud runtimes or minimal deployments
 */
export const knowledgePluginCore: Plugin = createKnowledgePlugin({
  enableUI: false,
  enableRoutes: false,
  enableActions: false,
  enableTests: false,
});

/**
 * Knowledge Plugin - Headless mode (Service + Provider + Actions, no UI)
 * Use this for server deployments without frontend
 */
export const knowledgePluginHeadless: Plugin = createKnowledgePlugin({
  enableUI: false,
  enableRoutes: false,
  enableActions: true,
  enableTests: false,
});

/**
 * Knowledge Plugin - Full mode (default)
 * Includes everything: Service, Provider, Actions, Routes, UI, Tests
 */
export const knowledgePlugin: Plugin = createKnowledgePlugin({
  enableUI: true,
  enableRoutes: true,
  enableActions: true,
  enableTests: true,
});

/**
 * Default export - Full plugin for backward compatibility
 */
export default knowledgePlugin;

/**
 * Export all types and utilities
 */
export * from './types';

/**
 * Export service and provider for direct use
 */
export { KnowledgeService } from './service';
export { knowledgeProvider } from './provider';
export { documentsProvider } from './documents-provider';
