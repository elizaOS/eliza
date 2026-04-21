import path from "node:path";

/**
 * Returns true when the given path should receive the SPA index.html fallback.
 * Asset extensions (.vrm, .glb, .js, .png, etc.) must 404 rather than silently
 * receiving HTML — which breaks binary loaders like GLTFLoader.
 */
export function shouldServeSpaFallback(decodedPath: string): boolean {
  const ext = path.extname(decodedPath).toLowerCase();
  // Only serve SPA for navigation-like requests (no extension or .html)
  return !ext || ext === ".html";
}
