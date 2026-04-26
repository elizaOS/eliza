/**
 * Content pack loader.
 *
 * Loads a content pack from a directory URL (e.g. /packs/cyberpunk-neon/)
 * or from a bundled pack definition. Validates the manifest and resolves
 * asset paths to absolute URLs.
 */

import {
  CONTENT_PACK_MANIFEST_FILENAME,
  type ContentPackManifest,
  type ContentPackSource,
  type ResolvedContentPack,
  validateContentPackManifest,
} from "@elizaos/shared";

export class ContentPackLoadError extends Error {
  constructor(
    message: string,
    public readonly source: ContentPackSource,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ContentPackLoadError";
  }
}

const filePackObjectUrls = new WeakMap<ResolvedContentPack, string[]>();

/**
 * Load a content pack from a base URL (directory containing pack.json).
 * The base URL should end with a trailing slash.
 */
export async function loadContentPackFromUrl(
  baseUrl: string,
): Promise<ResolvedContentPack> {
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const source: ContentPackSource = { kind: "url", url: normalizedBase };
  const manifestUrl = `${normalizedBase}${CONTENT_PACK_MANIFEST_FILENAME}`;

  let raw: unknown;
  try {
    const res = await fetch(manifestUrl);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    raw = await res.json();
  } catch (err) {
    throw new ContentPackLoadError(
      `Failed to fetch pack manifest from ${manifestUrl}`,
      source,
      err,
    );
  }

  const errors = validateContentPackManifest(raw);
  if (errors.length > 0) {
    throw new ContentPackLoadError(
      `Invalid pack manifest: ${errors.map((e) => `${e.field}: ${e.message}`).join("; ")}`,
      source,
    );
  }

  const manifest = raw as ContentPackManifest;
  return resolvePackAssets(manifest, normalizedBase, source);
}

/**
 * Load a content pack from an array of local browser File objects (e.g. from an <input webkitdirectory />).
 */
export async function loadContentPackFromFiles(
  files: File[],
): Promise<ResolvedContentPack> {
  const packFile = files.find(
    (file) =>
      file.webkitRelativePath.endsWith(CONTENT_PACK_MANIFEST_FILENAME) ||
      file.name === CONTENT_PACK_MANIFEST_FILENAME,
  );

  if (!packFile) {
    throw new ContentPackLoadError(
      "Could not find pack.json in the selected folder.",
      { kind: "file", path: "local-folder" },
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(await packFile.text());
  } catch (err) {
    throw new ContentPackLoadError(
      "Failed to parse pack.json",
      { kind: "file", path: "local-folder" },
      err,
    );
  }

  const errors = validateContentPackManifest(raw);
  if (errors.length > 0) {
    throw new ContentPackLoadError(
      `Invalid pack manifest: ${errors.map((e) => `${e.field}: ${e.message}`).join("; ")}`,
      { kind: "file", path: "local-folder" },
    );
  }

  const manifest = raw as ContentPackManifest;
  const { assets } = manifest;
  const objectUrls: string[] = [];
  const packRootPath = packFile.webkitRelativePath.replace(
    /\/?pack\.json$/,
    "",
  );
  const packRootSegments = packRootPath ? packRootPath.split("/") : [];

  const resolveBlobUrl = (path: string | undefined): string | undefined => {
    if (!path) return undefined;
    const normalizedPath = path.replace(/^\.\/|^\//, "");
    const targetSegments = [...packRootSegments, ...normalizedPath.split("/")];
    const fileMatch = files.find((file) => {
      const relativeSegments = file.webkitRelativePath
        ? file.webkitRelativePath.split("/")
        : [file.name];
      if (relativeSegments.length !== targetSegments.length) return false;
      return targetSegments.every(
        (segment, index) => segment === relativeSegments[index],
      );
    });
    if (!fileMatch) return undefined;
    const objectUrl = URL.createObjectURL(fileMatch);
    objectUrls.push(objectUrl);
    return objectUrl;
  };

  const folderPath =
    packFile.webkitRelativePath
      .replace(CONTENT_PACK_MANIFEST_FILENAME, "")
      .replace(/\/$/, "") || "local-folder";

  const pack: ResolvedContentPack = {
    manifest,
    vrmUrl: resolveBlobUrl(assets.vrm?.file),
    vrmPreviewUrl: resolveBlobUrl(assets.vrm?.preview),
    backgroundUrl: resolveBlobUrl(assets.background),
    worldUrl: resolveBlobUrl(assets.world),
    colorScheme: assets.colorScheme,
    // streamOverlayPath isn't translatable directly to a Blob URL without a full virtual fs
    personality: assets.personality,
    source: { kind: "file", path: folderPath },
  };

  if (objectUrls.length > 0) {
    filePackObjectUrls.set(pack, objectUrls);
  }

  return pack;
}

export function releaseLoadedContentPack(pack: ResolvedContentPack): void {
  const objectUrls = filePackObjectUrls.get(pack);
  if (!objectUrls) return;
  for (const objectUrl of objectUrls) {
    URL.revokeObjectURL(objectUrl);
  }
  filePackObjectUrls.delete(pack);
}

/**
 * Resolve a pack from an already-parsed manifest and a base URL.
 * Useful for bundled packs that ship with the app.
 */
export function resolveContentPackFromManifest(
  manifest: ContentPackManifest,
  baseUrl: string,
  source: ContentPackSource,
): ResolvedContentPack {
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return resolvePackAssets(manifest, normalizedBase, source);
}

function resolvePackAssets(
  manifest: ContentPackManifest,
  baseUrl: string,
  source: ContentPackSource,
): ResolvedContentPack {
  const { assets } = manifest;
  const resolve = (path: string | undefined) =>
    path ? `${baseUrl}${path}` : undefined;

  return {
    manifest,
    vrmUrl: resolve(assets.vrm?.file),
    vrmPreviewUrl: resolve(assets.vrm?.preview),
    backgroundUrl: resolve(assets.background),
    worldUrl: resolve(assets.world),
    colorScheme: assets.colorScheme,
    streamOverlayPath: resolve(assets.streamOverlay),
    personality: assets.personality,
    source,
  };
}

/**
 * Create a resolved content pack from a bundled pack definition.
 * Bundled packs live in apps/app/public/packs/<id>/.
 */
export function loadBundledContentPack(
  manifest: ContentPackManifest,
  packsBaseUrl = "/packs",
): ResolvedContentPack {
  const baseUrl = `${packsBaseUrl}/${manifest.id}/`;
  return resolveContentPackFromManifest(manifest, baseUrl, {
    kind: "bundled",
    id: manifest.id,
  });
}
