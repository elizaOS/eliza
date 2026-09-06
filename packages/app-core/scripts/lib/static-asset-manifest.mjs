/**
 * Static asset manifest for the app and homepage public trees. Repository
 * checkouts inventory tracked and non-ignored files so normal build output
 * cannot change the source contract; standalone archives retain filesystem
 * discovery. The module also owns manifest persistence and the bootstrap
 * assets kept locally when heavy assets move to the CDN.
 */
import { execFileSync } from "node:child_process";
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

function isIncludedStaticAsset(repoRelativePath) {
  return repoRelativePath
    .split("/")
    .every(
      (segment) =>
        !segment.startsWith(".") &&
        !IGNORED_STATIC_ASSET_BASENAMES.has(segment),
    );
}

function listCheckoutPublicFiles(rootDir, repoPrefixes) {
  let output;
  try {
    output = execFileSync(
      "git",
      [
        "-C",
        rootDir,
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "-z",
        "--",
        ...repoPrefixes,
      ],
      {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch (cause) {
    // error-policy:J2 A checkout must not validate from an incomplete Git inventory.
    throw new Error(
      `[static-asset-manifest] Failed to inventory checkout assets under ${rootDir}`,
      { cause },
    );
  }

  return output
    .split("\0")
    .filter(Boolean)
    .filter(isIncludedStaticAsset)
    .filter((repoRelativePath) =>
      fs.existsSync(path.join(rootDir, repoRelativePath)),
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
  const appPrefix = resolvePublicRepoPrefix(
    rootDir,
    APP_PUBLIC_REPO_PREFIX,
    WRAPPER_APP_PUBLIC_REPO_PREFIX,
  );
  const homepagePrefix = resolvePublicRepoPrefix(
    rootDir,
    HOMEPAGE_PUBLIC_REPO_PREFIX,
    WRAPPER_HOMEPAGE_PUBLIC_REPO_PREFIX,
  );

  if (fs.existsSync(path.join(rootDir, ".git"))) {
    const checkoutFiles = listCheckoutPublicFiles(rootDir, [
      appPrefix,
      homepagePrefix,
    ]);
    return {
      app: checkoutFiles.filter((entry) => entry.startsWith(`${appPrefix}/`)),
      homepage: checkoutFiles.filter((entry) =>
        entry.startsWith(`${homepagePrefix}/`),
      ),
    };
  }

  return {
    app: listPublicFiles(rootDir, appPrefix),
    homepage: listPublicFiles(rootDir, homepagePrefix),
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
