/**
 * Builds the canonical bundle directory view used by Android's bionic
 * inference host when model installers store the text GGUF flat. Hardlinks
 * avoid copying model weights; auxiliary model directories remain symlinked so
 * text, voice, ASR, and vision resolve from one consistent bundle root.
 */

import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";

const FLAT_ELIZA_1_GGUF_RE = /^eliza-1-[a-z0-9_.-]+\.gguf$/i;
const BIONIC_FLAT_BUNDLE_DIR = ".bionic-bundles";
const BIONIC_AUXILIARY_DIRS: ReadonlyArray<{
  source: ReadonlyArray<string>;
  target: ReadonlyArray<string>;
}> = [
  { source: ["asr"], target: ["asr"] },
  { source: ["kokoro"], target: ["tts", "kokoro"] },
  { source: ["vision"], target: ["vision"] },
  { source: ["vad"], target: ["vad"] },
  { source: ["wake"], target: ["wake"] },
  { source: ["speaker"], target: ["speaker"] },
  { source: ["diariz"], target: ["diariz"] },
];

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error))
    return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function pathExistsIncludingBrokenLink(target: string): boolean {
  try {
    lstatSync(target);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

function pathsReferToSameEntry(source: string, target: string): boolean {
  try {
    const sourceStat = statSync(source);
    const targetStat = statSync(target);
    if (
      sourceStat.dev === targetStat.dev &&
      sourceStat.ino === targetStat.ino
    ) {
      return true;
    }
    return realpathSync(source) === realpathSync(target);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

function removePathEntry(target: string): void {
  if (lstatSync(target).isSymbolicLink()) {
    unlinkSync(target);
    return;
  }
  rmSync(target, { recursive: true, force: true });
}

function stageDirectoryAlias(source: string, target: string): void {
  if (!existsSync(source)) return;
  if (pathExistsIncludingBrokenLink(target)) {
    if (pathsReferToSameEntry(source, target)) return;
    removePathEntry(target);
  }
  mkdirSync(path.dirname(target), { recursive: true });
  symlinkSync(
    source,
    target,
    process.platform === "win32" ? "junction" : "dir",
  );
}

function stageModelAlias(source: string, target: string): void {
  if (pathExistsIncludingBrokenLink(target)) {
    if (pathsReferToSameEntry(source, target)) return;
    removePathEntry(target);
  }
  try {
    linkSync(source, target);
  } catch (error) {
    const code = errorCode(error);
    if (code !== "EXDEV" && code !== "EMLINK" && code !== "EPERM") {
      throw error;
    }
    try {
      symlinkSync(source, target);
    } catch (fallbackError) {
      // error-policy:J2 context-adding rethrow: callers need both the alias
      // target and the platform failure that prevented cache-view creation.
      throw new AggregateError(
        [error, fallbackError],
        `Could not stage bionic model alias at ${target}`,
      );
    }
  }
}

function stageAuxiliaryBundleViews(
  modelsDir: string,
  bundleRoot: string,
): void {
  for (const entry of BIONIC_AUXILIARY_DIRS) {
    stageDirectoryAlias(
      path.join(modelsDir, ...entry.source),
      path.join(bundleRoot, ...entry.target),
    );
  }
}

/**
 * Resolve an installed model path to the bundle root expected by the fused
 * host. Canonical `bundle/text/model.gguf` inputs are returned unchanged; a
 * flat curated Eliza-1 GGUF gets an idempotent derived bundle view.
 */
export function deriveBionicBundleDir(modelPath: string): string {
  if (!modelPath) return "";
  const dir = path.dirname(modelPath);
  if (path.basename(dir) === "text") return path.dirname(dir);
  if (!FLAT_ELIZA_1_GGUF_RE.test(path.basename(modelPath))) return "";
  if (!existsSync(modelPath)) return "";

  const modelName = path.basename(modelPath);
  const bundleRoot = path.join(
    dir,
    BIONIC_FLAT_BUNDLE_DIR,
    path.basename(modelName, path.extname(modelName)),
  );
  const textDir = path.join(bundleRoot, "text");
  const stagedPath = path.join(textDir, modelName);
  mkdirSync(textDir, { recursive: true });
  stageModelAlias(modelPath, stagedPath);
  stageAuxiliaryBundleViews(dir, bundleRoot);
  return bundleRoot;
}
