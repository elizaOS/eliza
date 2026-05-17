/**
 * Content pack loader.
 *
 * Loads a content pack from a directory URL (e.g. /packs/cyberpunk-neon/)
 * or from a bundled pack definition. Validates the manifest and resolves
 * asset paths to absolute URLs.
 */
import {
  type ContentPackManifest,
  type ContentPackSource,
  type ResolvedContentPack,
} from "@elizaos/shared";
export declare class ContentPackLoadError extends Error {
  readonly source: ContentPackSource;
  readonly cause?: unknown | undefined;
  constructor(
    message: string,
    source: ContentPackSource,
    cause?: unknown | undefined,
  );
}
/**
 * Load a content pack from a base URL (directory containing pack.json).
 * The base URL should end with a trailing slash.
 */
export declare function loadContentPackFromUrl(
  baseUrl: string,
): Promise<ResolvedContentPack>;
/**
 * Load a content pack from an array of local browser File objects (e.g. from an <input webkitdirectory />).
 */
export declare function loadContentPackFromFiles(
  files: File[],
): Promise<ResolvedContentPack>;
export declare function releaseLoadedContentPack(
  pack: ResolvedContentPack,
): void;
/**
 * Resolve a pack from an already-parsed manifest and a base URL.
 * Useful for bundled packs that ship with the app.
 */
export declare function resolveContentPackFromManifest(
  manifest: ContentPackManifest,
  baseUrl: string,
  source: ContentPackSource,
): ResolvedContentPack;
/**
 * Create a resolved content pack from a bundled pack definition.
 * Bundled packs live in apps/app/public/packs/<id>/.
 */
export declare function loadBundledContentPack(
  manifest: ContentPackManifest,
  packsBaseUrl?: string,
): ResolvedContentPack;
//# sourceMappingURL=load-pack.d.ts.map
