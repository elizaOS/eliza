import path from "node:path";

type ExistsSyncLike = (filePath: string) => boolean;
type StatSyncLike = (filePath: string) => { isDirectory(): boolean };

export type ResolvedRendererAsset = {
  filePath: string;
  isGzipped: boolean;
  mimeExt: string;
};

export const RENDERER_ASSET_MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".wasm": "application/wasm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".vrm": "model/gltf-binary",
  ".gz": "application/octet-stream",
};

export function getRendererAssetContentType(mimeExt: string): string {
  return (
    RENDERER_ASSET_MIME_TYPES[mimeExt.toLowerCase()] ??
    "application/octet-stream"
  );
}

type ResolveRendererAssetOptions = {
  rendererDir: string;
  urlPath: string;
  existsSync: ExistsSyncLike;
  statSync: StatSyncLike;
};

function stripGzipSuffix(filePath: string): string {
  return filePath.toLowerCase().endsWith(".gz")
    ? filePath.slice(0, -3)
    : filePath;
}

function resolveMimeExtension(filePath: string): string {
  const uncompressedPath = stripGzipSuffix(filePath);
  return (
    path.extname(uncompressedPath).toLowerCase() ||
    path.extname(filePath).toLowerCase()
  );
}

export function resolveRendererAsset({
  rendererDir,
  urlPath,
  existsSync,
  statSync,
}: ResolveRendererAssetOptions): ResolvedRendererAsset {
  const relativePath = urlPath.replace(/^\/+/, "") || "index.html";
  let filePath = path.join(rendererDir, relativePath);
  const bundledIndexPath = path.join(rendererDir, "index.html");

  if (
    !filePath.startsWith(rendererDir + path.sep) &&
    filePath !== rendererDir
  ) {
    filePath = bundledIndexPath;
  }

  let isGzipped = false;

  if (!existsSync(filePath) && filePath.toLowerCase().endsWith(".gz")) {
    const plainPath = filePath.slice(0, -3);
    if (existsSync(plainPath)) {
      filePath = plainPath;
    }
  }

  if (!existsSync(filePath) && existsSync(`${filePath}.gz`)) {
    filePath = `${filePath}.gz`;
    isGzipped = true;
  }

  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    return {
      filePath: bundledIndexPath,
      isGzipped: false,
      mimeExt: ".html",
    };
  }

  return {
    filePath,
    isGzipped,
    mimeExt: resolveMimeExtension(filePath),
  };
}
