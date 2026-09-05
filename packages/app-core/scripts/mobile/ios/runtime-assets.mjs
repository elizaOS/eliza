/** Owns ios runtime assets using the shared build context and existing platform contracts. */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { appStoreExecutionProfile } from "../../../../native/bun-runtime/scripts/ios-app-store-runtime-policy.mjs";
import { artifactStaleness } from "../../lib/artifact-staleness.mjs";
import { rmRecursive } from "../build-tools.mjs";
import { iosDir, packagesRoot, repoRoot } from "../context.mjs";
import { isTruthyEnv } from "../environment.mjs";

export const IOS_BUN_ENGINE_FRAMEWORK_NAME = "ElizaBunEngine";

export const IOS_BUN_ENGINE_ABI_VERSION = "3";

export const iosBunRuntimePackageRoot = path.join(
  packagesRoot,
  "native",
  "bun-runtime",
);

export const defaultIosBunEngineXcframework = path.join(
  iosBunRuntimePackageRoot,
  "artifacts",
  `${IOS_BUN_ENGINE_FRAMEWORK_NAME}.xcframework`,
);

export const IOS_BUN_ENGINE_REQUIRED_SYMBOLS = [
  "_eliza_bun_engine_abi_version",
  "_eliza_bun_engine_last_error",
  "_eliza_bun_engine_set_host_callback",
  "_eliza_bun_engine_start",
  "_eliza_bun_engine_stop",
  "_eliza_bun_engine_is_running",
  "_eliza_bun_engine_call",
  "_eliza_bun_engine_free",
];

export const IOS_BUN_ENGINE_EXECUTION_PROFILE = appStoreExecutionProfile;

export const IOS_AGENT_RUNTIME_ASSETS = [
  "agent-bundle.js",
  "pglite.wasm",
  "initdb.wasm",
  "pglite.data",
  "vector.tar.gz",
  "fuzzystrmatch.tar.gz",
  "pg_trgm.tar.gz",
  "plugins-manifest.json",
];

export const IOS_AGENT_ROOT_EXTENSION_ASSETS = [
  "vector.tar.gz",
  "fuzzystrmatch.tar.gz",
  "pg_trgm.tar.gz",
];

// Extension targets stripped for personal-team builds: personal-team
// entitlements are emptied (no App Groups), so every extension whose
// entitlements reference the app group — including the ElizaWidgets
// widget/controls extension — must drop out of the build to keep automatic
// signing viable.
export const IOS_PRIVILEGED_EXTENSION_LIST_ENTRY_IDS = [
  "WBCB00010000000000000201",
  "WBCB00010000000000000702",
  "DAMON000100000000000702",
  "DAREP000100000000000702",
  "EWDG00010000000000000702",
  "EKBD00010000000000000702",
  "WBCB00010000000000000401",
  "DAMON000100000000000401",
  "DAREP000100000000000401",
  "EWDG00010000000000000401",
  "EKBD00010000000000000401",
];

export const IOS_PERSONAL_TEAM_ENTITLEMENTS = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
</dict>
</plist>
`;

export function resolveIosAgentRuntimeAssetPlan({
  appStoreBuild = false,
  includeFullBunEngine = false,
} = {}) {
  const includeAgentPayload = !appStoreBuild || includeFullBunEngine;
  return {
    agentAssets: includeAgentPayload ? IOS_AGENT_RUNTIME_ASSETS : null,
    rootAssets: includeAgentPayload ? IOS_AGENT_ROOT_EXTENSION_ASSETS : [],
  };
}

export function countGgufFiles(dir) {
  if (!fs.existsSync(dir)) return 0;
  let count = 0;
  for (const entry of fs.readdirSync(dir)) {
    const fullPath = path.join(dir, entry);
    const stats = fs.statSync(fullPath);
    if (stats.isDirectory()) count += countGgufFiles(fullPath);
    else if (stats.isFile() && entry.toLowerCase().endsWith(".gguf"))
      count += 1;
  }
  return count;
}

export function stageIosBundledLocalModels(targetDir) {
  const sourceDir = process.env.ELIZA_IOS_BUNDLED_MODELS_DIR?.trim();
  const requireModels = isTruthyEnv(process.env.ELIZA_IOS_REQUIRE_LOCAL_MODELS);
  if (!sourceDir) {
    if (requireModels) {
      throw new Error(
        "ELIZA_IOS_REQUIRE_LOCAL_MODELS is set but ELIZA_IOS_BUNDLED_MODELS_DIR is empty.",
      );
    }
    return 0;
  }
  if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
    throw new Error(
      `ELIZA_IOS_BUNDLED_MODELS_DIR does not exist or is not a directory: ${sourceDir}`,
    );
  }
  const sourceCount = countGgufFiles(sourceDir);
  if (sourceCount === 0) {
    throw new Error(
      `ELIZA_IOS_BUNDLED_MODELS_DIR contains no GGUF model files: ${sourceDir}`,
    );
  }
  const sourceName = path.basename(sourceDir.replace(/[\\/]+$/, ""));
  const targetModelsDir = sourceName.endsWith(".bundle")
    ? path.join(targetDir, "models", sourceName)
    : path.join(targetDir, "models");
  fs.mkdirSync(targetModelsDir, { recursive: true });
  fs.cpSync(sourceDir, targetModelsDir, { recursive: true });
  const stagedCount = countGgufFiles(targetModelsDir);
  if (stagedCount === 0) {
    throw new Error(
      `No GGUF model files were staged into ${path.relative(repoRoot, targetModelsDir)}`,
    );
  }
  return stagedCount;
}

export function stageIosAgentRuntime({
  appStoreBuild = false,
  includeFullBunEngine = false,
} = {}) {
  const sourceDir = path.join(packagesRoot, "agent", "dist-mobile-ios");
  const assetPlan = resolveIosAgentRuntimeAssetPlan({
    appStoreBuild,
    includeFullBunEngine,
  });
  const required = IOS_AGENT_RUNTIME_ASSETS;
  for (const file of required) {
    const p = path.join(sourceDir, file);
    if (!fs.existsSync(p)) {
      throw new Error(
        `[mobile-build] iOS local agent payload missing ${p}; run packages/agent build:ios-bun first.`,
      );
    }
  }

  // The agent bundle must be the freshly built one — never a stale leftover that
  // forces a manual hot-swap to get latest (issue #9309). buildIos rebuilds it
  // before staging, so this is a hard guarantee; fail loudly if it regressed.
  if (process.env.ELIZA_MOBILE_ALLOW_STALE_AGENT_BUNDLE !== "1") {
    const bundleStale = artifactStaleness(
      path.join(sourceDir, "agent-bundle.js"),
      { sourceDirs: [path.join(packagesRoot, "agent", "src")] },
    );
    if (bundleStale.stale) {
      throw new Error(
        `[mobile-build] iOS agent bundle is stale (${bundleStale.reason}). ` +
          `Run \`bun run --cwd packages/agent build:ios-bun\` to rebuild, or set ` +
          `ELIZA_MOBILE_ALLOW_STALE_AGENT_BUNDLE=1 to stage it anyway (NOT recommended).`,
      );
    }
  }

  const targetDir = path.join(iosDir, "App", "public", "agent");
  rmRecursive(targetDir);
  fs.mkdirSync(targetDir, { recursive: true });
  const filesToStage = assetPlan.agentAssets ?? fs.readdirSync(sourceDir);
  for (const file of filesToStage) {
    const src = path.join(sourceDir, file);
    const dst = path.join(targetDir, file);
    if (fs.statSync(src).isFile()) {
      fs.copyFileSync(src, dst);
    }
  }
  // PGlite resolves extension bundles via new URL("../vector.tar.gz",
  // import.meta.url) from public/agent/agent-bundle.js, so iOS must stage
  // the extension assets at public/ as well as keeping the manifest copy under
  // public/agent for build diagnostics.
  const publicDir = path.dirname(targetDir);
  for (const file of assetPlan.rootAssets) {
    fs.copyFileSync(path.join(sourceDir, file), path.join(publicDir, file));
  }
  // Verify the staged bundle is a faithful copy (catch a torn/partial copy that
  // would ship a corrupt agent runtime).
  if (assetPlan.agentAssets?.includes("agent-bundle.js")) {
    const sha = (p) =>
      crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
    const srcSha = sha(path.join(sourceDir, "agent-bundle.js"));
    const dstSha = sha(path.join(targetDir, "agent-bundle.js"));
    if (srcSha !== dstSha) {
      throw new Error(
        `[mobile-build] staged iOS agent-bundle.js hash ${dstSha} != source ${srcSha} — partial/corrupt copy.`,
      );
    }
  }
  const stagedModelCount = stageIosBundledLocalModels(targetDir);
  console.log(
    `[mobile-build] Staged iOS Bun agent payload${appStoreBuild ? " (App Store allowlist)" : ""}: ${path.relative(repoRoot, targetDir)}${stagedModelCount > 0 ? ` with ${stagedModelCount} local model file(s)` : ""}`,
  );
}

export function removeIosLocalExecutionAssets() {
  const publicDir = path.join(iosDir, "App", "public");
  const targets = [
    path.join(publicDir, "agent"),
    path.join(publicDir, "vector.tar.gz"),
    path.join(publicDir, "fuzzystrmatch.tar.gz"),
    path.join(publicDir, "pg_trgm.tar.gz"),
  ];
  let removed = 0;
  for (const target of targets) {
    if (!fs.existsSync(target)) continue;
    rmRecursive(target);
    removed += 1;
  }
  if (removed > 0) {
    console.log(
      `[mobile-build] Removed ${removed} stale iOS local execution asset path(s) for App Store build.`,
    );
  }
}
