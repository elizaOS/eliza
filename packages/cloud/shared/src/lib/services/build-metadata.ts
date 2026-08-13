/**
 * buildx --metadata-file parsing (Apps / Product 2).
 *
 * When `docker buildx build --metadata-file <path>` completes, buildx writes a
 * JSON object to `<path>`. Its `containerimage.digest` key carries the digest
 * of the image pushed by THIS build invocation — an atomic result captured in
 * the same process as the push, so it cannot be confused by a concurrent build
 * or a registry retag the way a post-hoc `docker buildx imagetools inspect`
 * lookup by tag can (#13097).
 *
 * This module is pure: given the raw file contents it extracts + validates the
 * digest. The impure read (file IO) lives in the build executor
 * ({@link AppImageBuilder}), which composes this.
 */

import { ElizaError } from "@elizaos/core";

const SHA256_DIGEST_RE = /^sha256:[a-f0-9]{64}$/i;

/**
 * The shape buildx writes to `--metadata-file`. Only the fields we consume are
 * typed; buildx emits additional `containerimage.*` annotations that we ignore.
 */
export interface BuildxMetadata {
  "containerimage.digest"?: unknown;
}

/**
 * Extract a valid `sha256:<64hex>` digest from raw buildx metadata-file JSON.
 *
 * Returns the bare digest (`sha256:<hex>`) on success — never the full ref,
 * since the repository is already known to the caller (it built the ref). Throws
 * a typed {@link BuildMetadataError} on any failure so the build boundary can
 * fail fast instead of silently falling back to a mutable tag (#13097).
 */
export function parseBuildxDigest(rawMetadata: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawMetadata);
  } catch (cause) {
    throw new BuildMetadataError(
      "buildx metadata-file is not valid JSON — the build may have crashed before writing metadata",
      { cause },
    );
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new BuildMetadataError(
      "buildx metadata-file did not contain a JSON object — missing containerimage.digest",
    );
  }

  const digest = (parsed as BuildxMetadata)["containerimage.digest"];
  if (typeof digest !== "string" || !SHA256_DIGEST_RE.test(digest)) {
    throw new BuildMetadataError(
      `buildx metadata-file containerimage.digest is missing or invalid (got: ${digest === undefined ? "undefined" : JSON.stringify(digest)}) — ` +
        `cannot construct an immutable image ref without a valid sha256 digest`,
    );
  }

  return digest;
}

/**
 * Construct a digest-pinned image ref (`<repository>@sha256:<64hex>`) from the
 * mutable tag ref the build pushed under and the atomic digest captured from
 * the same build invocation.
 *
 * Strips any existing `:tag` from the repository portion before appending the
 * digest — `repo@sha256:...` is the canonical content-addressed form and never
 * carries a tag.
 */
export function buildDigestPinnedRef(taggedRef: string, digest: string): string {
  if (!SHA256_DIGEST_RE.test(digest)) {
    throw new Error(`buildDigestPinnedRef: invalid digest "${digest}"`);
  }
  const ref = taggedRef.trim();
  // Strip an existing @digest (shouldn't happen, but be defensive).
  const withoutDigest = ref.includes("@") ? ref.slice(0, ref.indexOf("@")) : ref;
  // Strip the :tag so the result is repo@sha256:... (no mutable tag).
  const slashIndex = withoutDigest.lastIndexOf("/");
  const colonIndex = withoutDigest.lastIndexOf(":");
  const hasTag = colonIndex > slashIndex;
  const repository = hasTag ? withoutDigest.slice(0, colonIndex) : withoutDigest;
  return `${repository}@${digest}`;
}

/**
 * Typed build-boundary error for missing/invalid digest resolution. Thrown
 * instead of silently returning a mutable tag ref so the deploy fails fast at
 * the build boundary — not later at a confusing deploy-time digest gate
 * rejection (#13097). Extends {@link ElizaError} so the stable `code` /
 * structured `context` and `cause` chain follow the repository error policy
 * (J2: context-adding rethrow at a designed boundary).
 */
export class BuildMetadataError extends ElizaError {
  constructor(
    message: string,
    options?: { cause?: unknown; metadataPath?: string; tagRef?: string },
  ) {
    super(message, {
      code: "BUILD_METADATA_DIGEST_NOT_CAPTURED",
      cause: options?.cause,
      context: {
        metadataPath: options?.metadataPath,
        tagRef: options?.tagRef,
      },
      severity: "fatal",
    });
  }
}
