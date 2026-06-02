/**
 * @elizaos/registry — in-repo source of truth for the community plugin registry.
 *
 * Source entries live as one JSON file per package under `entries/third-party/`.
 * {@link loadThirdPartyEntries} reads and validates them; {@link generateRegistry}
 * produces the `generated-registry.json` wire format the runtime consumes.
 */

export {
  loadThirdPartyEntries,
  thirdPartyEntriesDir,
} from "./loader.ts";
export {
  generateRegistry,
  toGeneratedEntry,
} from "./generate.ts";
export {
  assertRegistryEntry,
  validateRegistryEntry,
} from "./schema.ts";
export type {
  GeneratedRegistry,
  GeneratedRegistryEntry,
  RegistryEntry,
  RegistryEntryKind,
} from "./types.ts";
