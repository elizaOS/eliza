/** Re-exports the core connector-source registry helpers (normalize, alias, metadata lookup) so shared consumers avoid a direct `@elizaos/core` import. */
export {
  type ConnectorSourceDefinition,
  type ConnectorSourceKind,
  type ConnectorSourceMetadata,
  expandConnectorSourceFilter,
  getConnectorSourceAliases,
  getConnectorSourceMetadata,
  isPassiveConnectorSource,
  normalizeConnectorSource,
  registerConnectorSourceAliases,
  registerConnectorSourceDefinitions,
  registerConnectorSourceMetadata,
  unregisterConnectorSourceMetadataOwner,
} from "@elizaos/core";
