/** Re-exports the core connector-source registry helpers (normalize, alias, metadata lookup) so shared consumers avoid a direct `@elizaos/core` import. */
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
} from "@elizaos/core";
