import { type AppEntry, type ConnectorEntry, type PluginEntry, type RegistryEntry, type RegistryKind, type RegistryRuntimeOverlay, type RegistryView } from "./schema.js";
export declare class RegistryValidationError extends Error {
    readonly file: string;
    readonly cause: unknown;
    constructor(file: string, cause: unknown);
}
export interface LoadedRegistry {
    byId: Map<string, RegistryEntry>;
    byKind: Map<RegistryKind, RegistryEntry[]>;
    byGroup: Map<string, RegistryEntry[]>;
    byNpmName: Map<string, RegistryEntry>;
    all: RegistryEntry[];
}
interface RawEntry {
    file: string;
    data: unknown;
}
export declare function loadRegistryFromRawEntries(raws: RawEntry[]): LoadedRegistry;
export declare function indexEntries(entries: RegistryEntry[]): LoadedRegistry;
export declare function getApps(registry: LoadedRegistry): AppEntry[];
export declare function getPlugins(registry: LoadedRegistry): PluginEntry[];
export declare function getConnectors(registry: LoadedRegistry): ConnectorEntry[];
export declare function getEntry(registry: LoadedRegistry, id: string): RegistryEntry | undefined;
export declare function getEntryByNpmName(registry: LoadedRegistry, npmName: string): RegistryEntry | undefined;
export declare function mergeWithRuntime(entries: RegistryEntry[], overlays: RegistryRuntimeOverlay[]): RegistryView[];
export {};
//# sourceMappingURL=loader.d.ts.map