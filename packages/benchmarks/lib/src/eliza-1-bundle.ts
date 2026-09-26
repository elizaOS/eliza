/**
 * Reader for the eliza-1 GGUF bundle directory format.
 *
 * Each bundle lives at `~/.eliza/local-inference/models/eliza-1-<size>.bundle/`
 * with a `manifest.json` describing release state, the embedded GGUF weights,
 * and the optional MTP drafter. The benchmark aggregator uses this to label
 * runs that exercise non-final ("local-standin") bundles via the `preRelease`
 * field already present on `RunMetrics` / `Report` (see `metrics-schema.ts`).
 *
 * Release-state semantics (from `ELIZA_1_PRODUCTION_READINESS_REVIEW.md`):
 *   - "local-standin" — synthesized/quantized standin weights for harness
 *     plumbing only. Never publishable. `publishEligible=false`,
 *     `final.weights=false`.
 *   - "candidate"     — release-candidate weights produced from the real
 *     training run. May still fail acceptance criteria. `publishEligible`
 *     may flip true when QA signs off; `final.weights` stays false until
 *     the candidate is promoted.
 *   - "final"         — promoted release. `publishEligible=true` AND
 *     `final.weights=true`.
 *
 * `bundleIsPreRelease` returns true unless ALL THREE of `releaseState=final`,
 * `publishEligible=true`, and `final.weights=true` hold. A `final.weights=true`
 * bundle whose `publishEligible` flag is still false (waiting on legal sign-off
 * etc) is still flagged pre-release — pre-release status must never be
 * silently coerced to false.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { expandHome } from "./local-llama-cpp.ts";

export const ELIZA_ONE_MODEL_SIZES = ["2b", "9b", "27b"] as const;
export type ElizaOneModelSize = (typeof ELIZA_ONE_MODEL_SIZES)[number];

export const ELIZA_ONE_RELEASE_STATES = [
  "local-standin",
  "candidate",
  "final",
] as const;
export type ElizaOneReleaseState = (typeof ELIZA_ONE_RELEASE_STATES)[number];

/**
 * The text runtime a bundle's primary weights are served by. `llama-cpp`
 * (the `.gguf`) is the default; `litert-lm` is the LiteRT-LM `.litertlm`
 * single-file on-device runtime (Android NPU / GPU delegate).
 */
export const ELIZA_ONE_TEXT_RUNTIME_CLASSES = [
  "llama-cpp",
  "litert-lm",
] as const;
export type ElizaOneTextRuntimeClass =
  (typeof ELIZA_ONE_TEXT_RUNTIME_CLASSES)[number];

/** Bundle-relative subdir + extension the LiteRT artifact lives under. */
export const LITERT_BUNDLE_TEXT_SUBDIR = "text";
export const LITERT_ARTIFACT_EXT = ".litertlm";

export interface ElizaOneBundleManifest {
  bundleId: string;
  modelSize: ElizaOneModelSize;
  releaseState: ElizaOneReleaseState;
  publishEligible: boolean;
  final: { weights: boolean };
  /** Absolute filesystem path to the .gguf inside the bundle. */
  weightsPath: string;
  /**
   * Absolute filesystem path to the LiteRT-LM `.litertlm` text artifact when
   * the bundle stages one under `text/`, parallel to the GGUF `weightsPath`.
   * Absent ⇒ this bundle is GGUF-only (the default). The C-side
   * `llm_backend_select` probes `<bundleRoot>/text/*.litertlm` and routes to
   * the LiteRT-LM backend; this surfaces the staged path to harness consumers.
   */
  litertPath?: string;
  /** Absolute filesystem path to the MTP drafter, if present. */
  draftersPath?: string;
  sha256: string;
}

function isModelSize(value: unknown): value is ElizaOneModelSize {
  return (
    typeof value === "string" &&
    (ELIZA_ONE_MODEL_SIZES as readonly string[]).includes(value)
  );
}

function isReleaseState(value: unknown): value is ElizaOneReleaseState {
  return (
    typeof value === "string" &&
    (ELIZA_ONE_RELEASE_STATES as readonly string[]).includes(value)
  );
}

/**
 * Read and validate `manifest.json` inside an eliza-1 bundle directory.
 *
 * The `weightsPath` and `draftersPath` fields are resolved to absolute paths
 * (relative entries in the manifest are joined against the bundle directory).
 *
 * Throws on:
 *   - missing/unreadable bundle directory or manifest
 *   - missing required fields
 *   - unknown `modelSize` or `releaseState`
 *   - weights file referenced by `weightsPath` does not exist on disk
 */
export async function readElizaOneBundle(
  bundlePath: string,
): Promise<ElizaOneBundleManifest> {
  const resolvedBundlePath = path.resolve(expandHome(bundlePath));
  if (!existsSync(resolvedBundlePath)) {
    throw new Error(
      `eliza-1 bundle directory does not exist: ${resolvedBundlePath}`,
    );
  }
  const stat = statSync(resolvedBundlePath);
  if (!stat.isDirectory()) {
    throw new Error(
      `eliza-1 bundle path is not a directory: ${resolvedBundlePath}`,
    );
  }
  const manifestPath = path.join(resolvedBundlePath, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`eliza-1 bundle is missing manifest.json: ${manifestPath}`);
  }
  const raw = await readFile(manifestPath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `eliza-1 manifest.json is not valid JSON (${manifestPath}): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`eliza-1 manifest.json must be an object: ${manifestPath}`);
  }
  const obj = parsed as Record<string, unknown>;

  const bundleId = obj.bundleId;
  if (typeof bundleId !== "string" || bundleId.length === 0) {
    throw new Error(
      `eliza-1 manifest.json missing required string field 'bundleId': ${manifestPath}`,
    );
  }

  const modelSize = obj.modelSize;
  if (!isModelSize(modelSize)) {
    throw new Error(
      `eliza-1 manifest.json has invalid 'modelSize' (${String(
        modelSize,
      )}); expected one of ${ELIZA_ONE_MODEL_SIZES.join(", ")}`,
    );
  }

  const releaseState = obj.releaseState;
  if (!isReleaseState(releaseState)) {
    throw new Error(
      `eliza-1 manifest.json has invalid 'releaseState' (${String(
        releaseState,
      )}); expected one of ${ELIZA_ONE_RELEASE_STATES.join(", ")}`,
    );
  }

  if (typeof obj.publishEligible !== "boolean") {
    throw new Error(
      `eliza-1 manifest.json missing required boolean field 'publishEligible': ${manifestPath}`,
    );
  }
  const publishEligible = obj.publishEligible;

  const finalRaw = obj.final;
  if (!finalRaw || typeof finalRaw !== "object") {
    throw new Error(
      `eliza-1 manifest.json missing required object field 'final': ${manifestPath}`,
    );
  }
  const finalObj = finalRaw as Record<string, unknown>;
  if (typeof finalObj.weights !== "boolean") {
    throw new Error(
      `eliza-1 manifest.json missing required boolean field 'final.weights': ${manifestPath}`,
    );
  }

  const weightsRaw = obj.weightsPath;
  if (typeof weightsRaw !== "string" || weightsRaw.length === 0) {
    throw new Error(
      `eliza-1 manifest.json missing required string field 'weightsPath': ${manifestPath}`,
    );
  }
  const weightsPath = path.isAbsolute(weightsRaw)
    ? weightsRaw
    : path.join(resolvedBundlePath, weightsRaw);
  if (!existsSync(weightsPath)) {
    throw new Error(
      `eliza-1 bundle weights file does not exist: ${weightsPath} (referenced by ${manifestPath})`,
    );
  }

  let draftersPath: string | undefined;
  const draftersRaw = obj.draftersPath;
  if (typeof draftersRaw === "string" && draftersRaw.length > 0) {
    const resolved = path.isAbsolute(draftersRaw)
      ? draftersRaw
      : path.join(resolvedBundlePath, draftersRaw);
    if (!existsSync(resolved)) {
      throw new Error(
        `eliza-1 bundle drafters file does not exist: ${resolved} (referenced by ${manifestPath})`,
      );
    }
    draftersPath = resolved;
  }

  // Optional LiteRT-LM `.litertlm` text artifact, staged under `text/` parallel
  // to the GGUF weights. Resolution mirrors the C-side `find_litertlm_artifact`
  // (litert-backend.cpp): an explicit `litertPath` manifest field wins; absent
  // that, probe `<bundleRoot>/text/*.litertlm`. GGUF-only bundles leave this
  // unset. An explicit field that points at a missing file is a hard error
  // (no silent fallback to GGUF) — the bundle declared a LiteRT artifact that
  // is not on disk.
  let litertPath: string | undefined;
  const litertRaw = obj.litertPath;
  if (typeof litertRaw === "string" && litertRaw.length > 0) {
    const resolved = path.isAbsolute(litertRaw)
      ? litertRaw
      : path.join(resolvedBundlePath, litertRaw);
    if (!existsSync(resolved)) {
      throw new Error(
        `eliza-1 bundle LiteRT artifact does not exist: ${resolved} (referenced by ${manifestPath})`,
      );
    }
    litertPath = resolved;
  } else {
    litertPath = probeLitertArtifact(resolvedBundlePath);
  }

  const sha256 = obj.sha256;
  if (typeof sha256 !== "string" || sha256.length === 0) {
    throw new Error(
      `eliza-1 manifest.json missing required string field 'sha256': ${manifestPath}`,
    );
  }

  return {
    bundleId,
    modelSize,
    releaseState,
    publishEligible,
    final: { weights: finalObj.weights },
    weightsPath,
    litertPath,
    draftersPath,
    sha256,
  };
}

/**
 * Probe `<bundleRoot>/text/` for a single `.litertlm` artifact. Returns its
 * absolute path or `undefined` when none is staged. Mirrors the C-side
 * `find_litertlm_artifact` directory walk in
 * `tools/omnivoice/src/backends/litert-backend.cpp` so the harness and the
 * native backend agree on which file the runtime will pick.
 */
function probeLitertArtifact(bundleRoot: string): string | undefined {
  const textDir = path.join(bundleRoot, LITERT_BUNDLE_TEXT_SUBDIR);
  if (!existsSync(textDir) || !statSync(textDir).isDirectory()) {
    return undefined;
  }
  for (const name of readdirSync(textDir)) {
    if (name.endsWith(LITERT_ARTIFACT_EXT)) {
      const candidate = path.join(textDir, name);
      if (statSync(candidate).isFile()) return candidate;
    }
  }
  return undefined;
}

/**
 * The text runtime the runtime selector will route this bundle to. A staged
 * `.litertlm` (`litertPath`) selects the LiteRT-LM backend; otherwise the
 * default GGUF llama.cpp path. The `.gguf` weights stay present and loadable
 * either way — `litert-lm` only changes which backend serves text generation.
 */
export function bundleTextRuntimeClass(
  manifest: ElizaOneBundleManifest,
): ElizaOneTextRuntimeClass {
  return manifest.litertPath ? "litert-lm" : "llama-cpp";
}

/**
 * Return `true` when the bundle MUST be labeled `pre-release` in any
 * downstream report. A bundle is publication-ready only when every gate is
 * green: `releaseState=final`, `publishEligible=true`, and `final.weights=true`.
 */
export function bundleIsPreRelease(manifest: ElizaOneBundleManifest): boolean {
  if (manifest.releaseState !== "final") return true;
  if (!manifest.publishEligible) return true;
  if (!manifest.final.weights) return true;
  return false;
}
