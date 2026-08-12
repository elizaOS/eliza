/**
 * Re-exports connector-source registry helpers.
 *
 * #18056: use `@elizaos/core/client-public` (tree-shakeable pure modules), not
 * bare `@elizaos/core` (prebuilt ~2.4 MB browser blob under the app Vite alias).
 */
export {
  type ConnectorIdentityMetadataMapping,
  type ConnectorSourceDefinition,
  type ConnectorSourceKind,
  type ConnectorSourceMetadata,
  expandConnectorSourceFilter,
  getConnectorIdentityMetadataMapping,
  getConnectorSourceAliases,
  getConnectorSourceMetadata,
  getConnectorWorldIdMetadataKeys,
  isPassiveConnectorSource,
  normalizeConnectorSource,
  registerConnectorSourceAliases,
  registerConnectorSourceDefinitions,
  registerConnectorSourceMetadata,
  unregisterConnectorSourceMetadataOwner,
} from "@elizaos/core/client-public";
