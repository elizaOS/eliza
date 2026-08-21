/**
 * Verifies that the active ASR release is an immutable, downloadable Gemma
 * model/projector pair before native voice CI can count as product evidence.
 */

import { pathToFileURL } from "node:url";
import {
  compareVoiceModelSemver,
  VOICE_MODEL_VERSIONS,
  voiceModelAssetUrl,
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

  const gemmaAsrAssets = release.ggufAssets.filter((asset) => {
    const filename = asset.filename.toLowerCase();
    return filename.startsWith("voice/asr/") && filename.includes("gemma");
  });
  const hasModel = gemmaAsrAssets.some(
    (asset) => !asset.filename.toLowerCase().includes("mmproj"),
  );
  const hasProjector = gemmaAsrAssets.some((asset) =>
    asset.filename.toLowerCase().includes("mmproj"),
  );
  if (!hasModel || !hasProjector) {
    errors.push(
      `ASR ${release.version} must publish both a Gemma ASR model and its mmproj projector under voice/asr/.`,
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

function unquoteHeader(value) {
  return value?.trim().replace(/^W\//, "").replace(/^"|"$/g, "") ?? null;
}

/**
 * Resolve every catalog asset through Hugging Face without following the LFS
 * redirect. The resolver response is the publication authority: it binds the
 * requested revision to the repository commit and exposes the linked object's
 * digest and byte size without downloading multi-gigabyte model weights.
 */
export async function verifyProductAsrReleaseAuthority(
  versions = VOICE_MODEL_VERSIONS,
  { fetchFn = fetch, timeoutMs = 30_000 } = {},
) {
  const result = validateProductAsrRelease(versions);
  if (!result.release || result.errors.length > 0) return result;

  const release = result.release;
  const remoteErrors = [];
  for (const asset of release.ggufAssets) {
    const url = voiceModelAssetUrl(release, asset);
    let response;
    try {
      response = await fetchFn(url, {
        method: "HEAD",
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      remoteErrors.push(
        `${asset.filename} could not be resolved at the pinned Hugging Face revision: ${error instanceof Error ? error.message : String(error)}.`,
      );
      continue;
    }

    if (response.status < 200 || response.status >= 400) {
      remoteErrors.push(
        `${asset.filename} is not downloadable at the pinned Hugging Face revision (HTTP ${response.status}).`,
      );
      continue;
    }

    const repositoryCommit = response.headers.get("x-repo-commit");
    if (repositoryCommit !== release.hfRevision) {
      remoteErrors.push(
        `${asset.filename} resolved from revision ${JSON.stringify(repositoryCommit)}, expected ${release.hfRevision}.`,
      );
    }

    const linkedDigest = unquoteHeader(response.headers.get("x-linked-etag"));
    if (linkedDigest !== asset.sha256) {
      remoteErrors.push(
        `${asset.filename} resolver sha256 ${JSON.stringify(linkedDigest)} does not match the catalog pin.`,
      );
    }

    const linkedSize = Number(response.headers.get("x-linked-size"));
    if (!Number.isSafeInteger(linkedSize) || linkedSize !== asset.sizeBytes) {
      remoteErrors.push(
        `${asset.filename} resolver size ${JSON.stringify(response.headers.get("x-linked-size"))} does not match the catalog pin ${asset.sizeBytes}.`,
      );
    }

    if (response.status >= 300 && !response.headers.get("location")) {
      remoteErrors.push(
        `${asset.filename} resolver returned HTTP ${response.status} without a download location.`,
      );
    }
  }

  return { release, errors: [...result.errors, ...remoteErrors] };
}

export async function main({ githubAnnotations = false } = {}) {
  const result = await verifyProductAsrReleaseAuthority();
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
  process.exitCode = await main({
    githubAnnotations: process.argv.includes("--github-annotations"),
  });
}
