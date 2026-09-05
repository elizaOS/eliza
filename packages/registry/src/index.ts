/**
 * @elizaos/registry — in-repo source of truth for the community plugin registry.
 *
 * Source entries live as one JSON file per package under `entries/third-party/`.
 * {@link loadThirdPartyEntries} reads and validates them; {@link generateRegistry}
 * produces the `generated-registry.json` wire format the runtime consumes.
 */

export {
  generateRegistry,
  toGeneratedEntry,
} from "./generate.ts";
export {
  loadThirdPartyEntries,
  thirdPartyEntriesDir,
} from "./loader.ts";
export type {
  DecodeRuntimeRegistryOptions,
  NormalizedRegistryEntry,
  RegistrySearchable,
  RegistrySearchPolicy,
  RuntimeRegistryWireEntry,
} from "./runtime-kernel.ts";
export {
  AGENT_REGISTRY_SEARCH_POLICY,
  CORE_REGISTRY_SEARCH_POLICY,
  decodeRuntimeRegistry,
  isRegistryCacheFresh,
  runtimeRegistryEntrySchema,
  searchRegistryEntries,
} from "./runtime-kernel.ts";
export {
  assertRegistryEntry,
  isValidRegistryPackageName,
  validateRegistryEntry,
} from "./schema.ts";
export type {
  GeneratedRegistry,
  GeneratedRegistryAppMetadata,
  GeneratedRegistryEntry,
  RegistryAppMetadata,
  RegistryAppSession,
  RegistryAppUiExtension,
  RegistryAppViewer,
  RegistryEntry,
  RegistryEntryKind,
} from "./types.ts";
