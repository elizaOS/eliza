import { type LoadedRegistry } from "./loader.js";

export * from "./app-registry.js";
export {
  getApps,
  getConnectors,
  getEntry,
  getEntryByNpmName,
  getPlugins,
  indexEntries,
  type LoadedRegistry,
  mergeWithRuntime,
  type RegistryValidationError,
} from "./loader.js";
export * from "./schema.js";
export declare function loadRegistry(): LoadedRegistry;
export declare function clearRegistryCacheForTests(): void;
//# sourceMappingURL=index.d.ts.map
