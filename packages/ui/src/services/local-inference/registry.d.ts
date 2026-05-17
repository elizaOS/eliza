/**
 * On-disk registry of installed models.
 *
 * Two sources feed the registry:
 *   1. Eliza-owned downloads (source: "eliza-download") — written on
 *      successful completion by the downloader.
 *   2. External scans (source: "external-scan") — merged in at read time
 *      from `scanExternalModels()`. These are never persisted to the
 *      registry file; a rescan runs whenever we read.
 *
 * The JSON file only holds Eliza-owned entries. That way, if a user
 * cleans up LM Studio models we don't show stale ghosts.
 */
import type { InstalledModel } from "./types";
/**
 * Return all models currently usable: persisted Eliza downloads plus a
 * fresh external-tool scan. External duplicates of Eliza-owned files are
 * filtered out by path.
 */
export declare function listInstalledModels(): Promise<InstalledModel[]>;
/** Add or update a Eliza-owned entry. External entries are rejected. */
export declare function upsertElizaModel(model: InstalledModel): Promise<void>;
/** Mark an existing Eliza-owned model as most-recently-used. */
export declare function touchElizaModel(id: string): Promise<void>;
/**
 * Delete a Eliza-owned model from the registry and from disk.
 *
 * Refuses if the model was discovered from another tool — Eliza must not
 * touch files it doesn't own. Callers surface that refusal as a 4xx.
 */
export declare function removeElizaModel(id: string): Promise<{
  removed: boolean;
  reason?: "external" | "not-found";
}>;
//# sourceMappingURL=registry.d.ts.map
