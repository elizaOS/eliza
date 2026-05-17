import { type RegistryAppInfo } from "../../api";
/**
 * Fetch the merged apps catalog used by AppsView. Internal-tool entries are
 * authoritative — server / overlay duplicates are dropped via first-occurrence
 * dedup on `name`.
 */
export declare function loadAppsCatalog(): Promise<RegistryAppInfo[]>;
/**
 * Fire-and-forget prefetch used at hydration so the Apps tab opens warm.
 * Errors are swallowed — the UI's own loadApps will retry on mount.
 */
export declare function prefetchAppsCatalog(): Promise<void>;
//# sourceMappingURL=load-apps-catalog.d.ts.map
