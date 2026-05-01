import fs from "node:fs";
import path from "node:path";

export const APP_PUBLIC_REPO_PREFIX = "packages/app/public";
export const HOMEPAGE_PUBLIC_REPO_PREFIX = "packages/homepage/public";
export const WRAPPER_APP_PUBLIC_REPO_PREFIX = "apps/app/public";
export const WRAPPER_HOMEPAGE_PUBLIC_REPO_PREFIX = "apps/homepage/public";
export const STATIC_ASSET_MANIFEST_REPO_PATH =
  "scripts/generated/static-asset-manifest.json";
export const IGNORED_STATIC_ASSET_BASENAMES = new Set([
  ".DS_Store",
  "Thumbs.db",
]);

export const APP_DIST_BOOTSTRAP_ASSETS = [
  "animations/idle.glb.gz",
  "logos/anthropic-icon-white.png",
  "logos/anthropic-icon.png",
  "logos/claude-icon.png",
  "logos/deepseek-icon.png",
  "logos/elizaos-icon.png",
  "logos/gemini-icon.png",
  "logos/grok-icon-white.png",
  "logos/grok-icon.png",
  "logos/groq-icon-white.png",
  "logos/groq-icon.png",
  "logos/mistral-icon.png",
  "logos/ollama-icon-white.png",
  "logos/ollama-icon.png",
  "logos/openai-icon-white.png",
  "logos/openai-icon.png",
  "logos/openrouter-icon-white.png",
  "logos/openrouter-icon.png",
  "logos/together-ai-icon.png",
  "logos/zai-icon-white.png",
  "logos/zai-icon.png",
  "vrm-decoders/draco/draco_decoder.js",
  "vrm-decoders/draco/draco_decoder.wasm",
  "vrm-decoders/draco/draco_wasm_wrapper.js",
  "vrms/backgrounds/eliza-1.png",
  "vrms/eliza-1.vrm.gz",
  "vrms/previews/eliza-1.png",
];

function listFilesRecursive(dir) {
  if (!fs.existsSync(dir)) {
    return [];
  }

  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (
      entry.name.startsWith(".") ||
      IGNORED_STATIC_ASSET_BASENAMES.has(entry.name)
    ) {
      continue;
    }
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFilesRecursive(fullPath));
      continue;
    }
    files.push(fullPath);
  }
  return files;
}

function listPublicFiles(rootDir, repoPrefix) {
  const absoluteRoot = path.join(rootDir, repoPrefix);
  return listFilesRecursive(absoluteRoot)
    .map((filePath) =>
      path.relative(rootDir, filePath).replaceAll(path.sep, "/"),
    )
    .sort();
}

function resolvePublicRepoPrefix(rootDir, innerPrefix, wrapperPrefix) {
  if (fs.existsSync(path.join(rootDir, wrapperPrefix))) {
    return wrapperPrefix;
  }
  return innerPrefix;
}

export function buildStaticAssetManifest(rootDir) {
  return {
    app: listPublicFiles(
      rootDir,
      resolvePublicRepoPrefix(
        rootDir,
        APP_PUBLIC_REPO_PREFIX,
        WRAPPER_APP_PUBLIC_REPO_PREFIX,
      ),
    ),
    homepage: listPublicFiles(
      rootDir,
      resolvePublicRepoPrefix(
        rootDir,
        HOMEPAGE_PUBLIC_REPO_PREFIX,
        WRAPPER_HOMEPAGE_PUBLIC_REPO_PREFIX,
      ),
    ),
  };
}

export function resolveStaticAssetManifestPath(rootDir) {
  return path.join(rootDir, STATIC_ASSET_MANIFEST_REPO_PATH);
}

export function serializeStaticAssetManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function readStaticAssetManifest(rootDir) {
  const manifestPath = resolveStaticAssetManifestPath(rootDir);
  if (!fs.existsSync(manifestPath)) {
    return null;
  }

  return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
}

export function writeStaticAssetManifest(rootDir) {
  const manifestPath = resolveStaticAssetManifestPath(rootDir);
  const manifest = buildStaticAssetManifest(rootDir);
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, serializeStaticAssetManifest(manifest));
  return manifestPath;
}

export function validateStaticAssetManifest(rootDir) {
  const expected = serializeStaticAssetManifest(
    buildStaticAssetManifest(rootDir),
  );
  const manifestPath = resolveStaticAssetManifestPath(rootDir);
  if (!fs.existsSync(manifestPath)) {
    return {
      ok: false,
      manifestPath,
      reason: "missing",
    };
  }

  const actual = fs.readFileSync(manifestPath, "utf8");
  return {
    ok: actual === expected,
    manifestPath,
    reason: actual === expected ? "" : "stale",
    expected,
    actual,
  };
}
