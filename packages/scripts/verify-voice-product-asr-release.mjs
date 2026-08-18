/**
 * Verifies that the active ASR release is an immutable, downloadable Gemma
 * model/projector pair before native voice CI can count as product evidence.
 */

import { pathToFileURL } from "node:url";
import {
  compareVoiceModelSemver,
  VOICE_MODEL_VERSIONS,
} from "../shared/src/local-inference/voice-models.ts";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const IMMUTABLE_REVISION_PATTERN = /^[0-9a-f]{40}$/;

/** Return the newest declared ASR release without falling back to a retired one. */
export function latestDeclaredAsrRelease(versions = VOICE_MODEL_VERSIONS) {
  return versions
    .filter((release) => release.id === "asr")
    .toSorted((left, right) =>
      compareVoiceModelSemver(right.version, left.version),
    )[0];
}

/**
 * Validate the publication facts required for product-runtime ASR proof.
 * Compatibility assets from an older release never satisfy this boundary.
 */
export function validateProductAsrRelease(versions = VOICE_MODEL_VERSIONS) {
  const release = latestDeclaredAsrRelease(versions);
  const errors = [];
  if (!release) {
    return { release: undefined, errors: ["No ASR release is declared."] };
  }

  if (!IMMUTABLE_REVISION_PATTERN.test(release.hfRevision)) {
    errors.push(
      `ASR ${release.version} has no immutable 40-character Hugging Face revision (found ${JSON.stringify(release.hfRevision)}).`,
    );
  }
  if ((release.missingAssets?.length ?? 0) > 0) {
    errors.push(
      `ASR ${release.version} still declares missing assets: ${release.missingAssets
        .map((asset) => asset.filename)
        .join(", ")}.`,
    );
  }
  if (release.ggufAssets.length === 0) {
    errors.push(`ASR ${release.version} has no downloadable GGUF assets.`);
  }

  const hasModel = release.ggufAssets.some(
    (asset) => !asset.filename.toLowerCase().includes("mmproj"),
  );
  const hasProjector = release.ggufAssets.some((asset) =>
    asset.filename.toLowerCase().includes("mmproj"),
  );
  if (!hasModel || !hasProjector) {
    errors.push(
      `ASR ${release.version} must publish both a model and an mmproj projector.`,
    );
  }

  for (const asset of release.ggufAssets) {
    if (!SHA256_PATTERN.test(asset.sha256)) {
      errors.push(`${asset.filename} has no valid sha256 pin.`);
    }
    if (!Number.isSafeInteger(asset.sizeBytes) || asset.sizeBytes <= 0) {
      errors.push(`${asset.filename} has no positive integer size pin.`);
    }
  }

  return { release, errors };
}

export function main({ githubAnnotations = false } = {}) {
  const result = validateProductAsrRelease();
  if (result.errors.length > 0) {
    for (const message of result.errors) {
      if (githubAnnotations) {
        console.error(
          `::error title=Product ASR release unavailable::${message}`,
        );
      } else {
        console.error(`[voice-product-asr] ${message}`);
      }
    }
    console.error(
      "[voice-product-asr] Direct pre-Gemma FFI compatibility smokes are not product-runtime ASR evidence.",
    );
    return 1;
  }

  console.log(
    `[voice-product-asr] verified ASR ${result.release.version} at ${result.release.hfRevision} (${result.release.ggufAssets.length} assets)`,
  );
  return 0;
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  process.exitCode = main({
    githubAnnotations: process.argv.includes("--github-annotations"),
  });
}
