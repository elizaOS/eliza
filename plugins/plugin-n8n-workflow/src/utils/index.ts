// API client
export { N8nApiClient } from './api';

// Node catalog search
export { searchNodes } from './catalog';

// Credential resolution
export { resolveCredentials } from './credentialResolver';

// Context utilities
export { getUserTagName } from './context';

// Workflow generation pipeline
export {
  extractKeywords,
  matchWorkflow,
  generateWorkflow,
  correctFieldReferences,
} from './generation';

// Workflow validation & positioning
export { validateWorkflow, positionNodes, validateOutputReferences } from './workflow';

// Output schema utilities
export {
  hasOutputSchema,
  loadOutputSchema,
  parseExpressions,
  fieldExistsInSchema,
  formatSchemaForPrompt,
} from './outputSchema';

// Clarification request normalization
export {
  CATALOG_CLARIFICATION_SUFFIX,
  isCatalogClarification,
  isCatalogClarificationString,
  coerceClarificationRequests,
} from './clarification';
