/**
 * Knowledge Plugin - Browser Entry Point
 *
 * This file exports the browser-compatible subset of the Knowledge plugin.
 * Routes and file operations are not available in browser context.
 */

export * from "./types";
export { knowledgeProvider } from "./provider";
export { documentsProvider } from "./documents-provider";

// Export types but not file-dependent implementations
export type {
  KnowledgePluginConfig,
} from "./index";


