#!/usr/bin/env node
/**
 * Ensure avatar assets (VRMs, animations, backgrounds) are present in the app.
 *
 * On a fresh clone, the companion plugin's public/vrms/ and animations/
 * may be empty or contain only Git LFS pointers.  This script clones the
 * elizaos/avatars repository (org-owned) into a temp directory and copies
 * the assets into eliza/plugins/app-companion/public/.
 *
 * Run automatically via the `postinstall` hook, or manually:
 *   node scripts/ensure-avatars.mjs
 *   node scripts/ensure-avatars.mjs --force   # re-download even if present
 */
import { execSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { resolveRepoRootFromImportMeta } from "./lib/repo-root.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolveRepoRootFromImportMeta(import.meta.url);
const PUBLIC = join(ROOT, "eliza", "plugins", "app-companion", "public");
const VRMS_DIR = join(PUBLIC, "vrms");
const ANIMATIONS_DIR = join(PUBLIC, "animations");
const BUNDLED_VRM_SOURCE_IDS = [1, 2, 3, 4, 5, 6, 7, 8];
const BUNDLED_BACKGROUND_SOURCE_IDS = [1, 2, 3, 4, 5, 6, 7, 8];
const UNUSED_ANIMATION_PATHS = [
  join("emotes", "idle.glb"),
  join("emotes", "punch.glb"),
  join("mixamo", "Crying.fbx"),
];

// elizaos/avatars is an org-owned repo in the elizaos GitHub organization.
// Pinned to a specific commit for reproducible installs (supply-chain safety).
const AVATARS_REPO = "https://github.com/elizaos/avatars.git";
const AVATARS_COMMIT = "50f6bf0ad6db583581d4cbaeb377ca005b45195b";
const AVATARS_REF = process.env.ELIZA_AVATARS_REF?.trim() || "";
const TAG = "[ensure-avatars]";
const CHARACTERS_VRM = join(ROOT, "apps", "app", "characters", "vrm");

/** A bundled VRM asset is valid if its compressed or raw file is > 1 KB. */
export function hasValidVrm(dir) {
  if (!existsSync(dir)) return false;
  try {
    const files = readdirSync(dir).filter(
      (f) => f.endsWith(".vrm.gz") || f.endsWith(".vrm"),
    );
    if (files.length === 0) return false;
    return files.some((file) => statSync(join(dir, file)).size > 1024);
  } catch {
    return false;
  }
}

export function hasValidAnimations(dir) {
  if (!existsSync(dir)) return false;
  const emotesDir = join(dir, "emotes");
  if (!existsSync(emotesDir)) return false;
  try {
    const files = readdirSync(emotesDir).filter(
      (f) => f.endsWith(".glb") || f.endsWith(".glb.gz"),
    );
    if (files.length === 0) return false;
    const stat = statSync(join(emotesDir, files[0]));
    return stat.size > 1024;
  } catch {
    return false;
  }
}

function gitAvailable() {
  try {
    execSync("git --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Count files matching an extension in a directory (non-recursive). */
function countFiles(dir, ext) {
  if (!existsSync(dir)) return 0;
  try {
    return readdirSync(dir).filter((f) => f.endsWith(ext)).length;
  } catch {
    return 0;
  }
}

function copyPathIfExists(src, dest) {
  if (!existsSync(src)) return false;
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest, { recursive: true, force: true });
  return true;
}

function listFilesRecursive(dir, baseDir = dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFilesRecursive(fullPath, baseDir));
      continue;
    }
    files.push(fullPath.slice(baseDir.length + 1));
  }
  return files;
}

function writeBundledGzipVrms(vrmsDir) {
  const rawVrmFiles = readdirSync(vrmsDir).filter((file) =>
    file.endsWith(".vrm"),
  );
  let gzipCount = 0;
  for (const rawFile of rawVrmFiles) {
    const rawPath = join(vrmsDir, rawFile);
    const gzipPath = `${rawPath}.gz`;
    writeFileSync(gzipPath, gzipSync(readFileSync(rawPath), { level: 9 }));
    unlinkSync(rawPath);
    gzipCount += 1;
  }
  return gzipCount;
}

function writeBundledGzipAnimations(animationsDir) {
  const rawAnimationFiles = listFilesRecursive(animationsDir).filter(
    (file) => file.endsWith(".glb") || file.endsWith(".fbx"),
  );
  let gzipCount = 0;
  for (const rawFile of rawAnimationFiles) {
    const rawPath = join(animationsDir, rawFile);
    const gzipPath = `${rawPath}.gz`;
    writeFileSync(gzipPath, gzipSync(readFileSync(rawPath), { level: 9 }));
    unlinkSync(rawPath);
    gzipCount += 1;
  }
  return gzipCount;
}

export function runEnsureAvatars({
  force = false,
  log = console.log,
  logError = console.error,
  _hasValidVrm = hasValidVrm,
  _hasValidAnimations = hasValidAnimations,
  _gitAvailable = gitAvailable,
  _exec = execSync,
  _charactersVrmPath = CHARACTERS_VRM,
} = {}) {
  if (!force && _hasValidVrm(VRMS_DIR) && _hasValidAnimations(ANIMATIONS_DIR)) {
    log(`${TAG} Avatar assets already present — skipping`);
    return { cloned: false, reason: "already-present" };
  }

  // SKIP_AVATAR_CLONE is a hard circuit-breaker for CI and restricted
  // environments (e.g. sandboxed postinstall, air-gapped machines).
  // It intentionally overrides --force so that automated pipelines can
  // always prevent network I/O during install, regardless of invocation flags.
  const skipEnv = process.env.SKIP_AVATAR_CLONE;
  if (skipEnv === "1" || skipEnv === "true") {
    log(`${TAG} SKIP_AVATAR_CLONE set — skipping clone`);
    return { cloned: false, reason: "skipped-by-env" };
  }

  if (!_gitAvailable()) {
    logError(`${TAG} git not found — cannot clone avatar assets`);
    return { cloned: false, reason: "no-git" };
  }

  // Prefer local characters/vrm when available (process-vrms compresses with meshopt + gzip)
  const localVrms =
    _charactersVrmPath && existsSync(_charactersVrmPath)
      ? readdirSync(_charactersVrmPath).filter((f) => f.endsWith(".vrm"))
      : [];
  const useLocalVrms =
    localVrms.length > 0 && (!_hasValidVrm(VRMS_DIR) || force);

  if (useLocalVrms) {
    log(`${TAG} Using local characters/vrm — running process-vrms...`);
    try {
      _exec("node scripts/process-vrms.mjs", { cwd: ROOT, stdio: "inherit" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logError(`${TAG} process-vrms failed: ${msg}`);
      return { cloned: false, reason: "process-vrms-failed", error: msg };
    }
    if (_hasValidAnimations(ANIMATIONS_DIR)) {
      log(`${TAG} Avatar assets installed (local VRMs + existing animations)`);
      return { cloned: false, vrmsOk: _hasValidVrm(VRMS_DIR), animsOk: true };
    }
    log(`${TAG} VRMs done; still need animations — cloning...`);
  }

  log(
    `${TAG} Avatar assets missing or incomplete — cloning from ${AVATARS_REPO} @ ${AVATARS_COMMIT.slice(0, 8)}...`,
  );

  const tmpDir = join(ROOT, ".avatar-clone-tmp");

  try {
    // Clean up any previous failed attempt
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }

    // Clone and checkout pinned commit for reproducibility.
    // Uses --depth 1 + fetch for speed (avoids full history). When an explicit
    // ref/tag is supplied via ELIZA_AVATARS_REF we clone that shallow ref first.
    const cloneArgs = AVATARS_REF
      ? `git clone --depth 1 --branch "${AVATARS_REF}" ${AVATARS_REPO} "${tmpDir}"`
      : `git clone --depth 1 ${AVATARS_REPO} "${tmpDir}"`;
    _exec(cloneArgs, {
      cwd: ROOT,
      stdio: "inherit",
    });
    _exec(`git -C "${tmpDir}" fetch --depth 1 origin ${AVATARS_COMMIT}`, {
      cwd: ROOT,
      stdio: "inherit",
    });
    _exec(`git -C "${tmpDir}" checkout ${AVATARS_COMMIT}`, {
      cwd: ROOT,
      stdio: "inherit",
    });

    const avatarVrms = join(tmpDir, "vrms");
    if (existsSync(avatarVrms) && !useLocalVrms) {
      rmSync(VRMS_DIR, { recursive: true, force: true });
      mkdirSync(VRMS_DIR, { recursive: true });
      mkdirSync(join(VRMS_DIR, "previews"), { recursive: true });
      mkdirSync(join(VRMS_DIR, "backgrounds"), { recursive: true });

      for (const sourceId of BUNDLED_VRM_SOURCE_IDS) {
        copyPathIfExists(
          join(avatarVrms, `eliza-${sourceId}.vrm`),
          join(VRMS_DIR, `eliza-${sourceId}.vrm`),
        );
        copyPathIfExists(
          join(avatarVrms, "previews", `eliza-${sourceId}.png`),
          join(VRMS_DIR, "previews", `eliza-${sourceId}.png`),
        );
      }

      for (const sourceId of BUNDLED_BACKGROUND_SOURCE_IDS) {
        copyPathIfExists(
          join(avatarVrms, "backgrounds", `eliza-${sourceId}.png`),
          join(VRMS_DIR, "backgrounds", `eliza-${sourceId}.png`),
        );
      }

      const gzipCount = writeBundledGzipVrms(VRMS_DIR);
      const previewCount = countFiles(join(VRMS_DIR, "previews"), ".png");
      const backgroundCount = countFiles(join(VRMS_DIR, "backgrounds"), ".png");
      log(
        `${TAG} Copied ${gzipCount} bundled VRMs (.vrm.gz) + ${previewCount} previews + ${backgroundCount} backgrounds`,
      );
    }

    const avatarAnims = join(tmpDir, "animations");
    if (existsSync(avatarAnims)) {
      rmSync(ANIMATIONS_DIR, { recursive: true, force: true });
      mkdirSync(ANIMATIONS_DIR, { recursive: true });
      copyPathIfExists(
        join(avatarAnims, "idle.glb"),
        join(ANIMATIONS_DIR, "idle.glb"),
      );
      copyPathIfExists(
        join(avatarAnims, "emotes"),
        join(ANIMATIONS_DIR, "emotes"),
      );
      copyPathIfExists(
        join(avatarAnims, "mixamo"),
        join(ANIMATIONS_DIR, "mixamo"),
      );
      for (const relPath of UNUSED_ANIMATION_PATHS) {
        rmSync(join(ANIMATIONS_DIR, relPath), { force: true });
      }
      const gzipCount = writeBundledGzipAnimations(ANIMATIONS_DIR);
      const glbCount = countFiles(join(ANIMATIONS_DIR, "emotes"), ".glb.gz");
      const fbxCount = countFiles(join(ANIMATIONS_DIR, "mixamo"), ".fbx.gz");
      log(
        `${TAG} Copied ${gzipCount} bundled animations as ${glbCount} emotes + ${fbxCount} mixamo files (.gz)`,
      );
    }

    // Verify the copy produced valid assets (use injected validators for testability)
    const vrmsOk = _hasValidVrm(VRMS_DIR);
    const animsOk = _hasValidAnimations(ANIMATIONS_DIR);

    if (!vrmsOk || !animsOk) {
      logError(
        `${TAG} ERROR: copy completed but verification failed (vrms=${vrmsOk}, animations=${animsOk})`,
      );
      return { cloned: true, vrmsOk, animsOk, reason: "verify-failed" };
    }

    log(`${TAG} Avatar assets installed successfully`);
    return { cloned: true, vrmsOk, animsOk };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError(`${TAG} Failed to clone avatar assets: ${message}`);
    logError(
      `${TAG} You can manually clone: git clone ${AVATARS_REPO} /tmp/avatars && cp -r /tmp/avatars/vrms/ packages/app/public/vrms/ && cp -r /tmp/avatars/animations/ packages/app/public/animations/`,
    );
    return { cloned: false, reason: "clone-failed", error: message };
  } finally {
    try {
      if (existsSync(tmpDir)) {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup errors
    }
  }
}

// Run directly if invoked from CLI
const isDirectRun =
  process.argv[1] && resolve(process.argv[1]) === resolve(__filename);

if (isDirectRun) {
  const force = process.argv.includes("--force");
  runEnsureAvatars({ force });
}
