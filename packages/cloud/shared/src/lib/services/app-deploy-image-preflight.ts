/**
 * Apps-deploy immutable-image preflight (#13097).
 *
 * Before arming the digest requirement (or at startup), scan the configured +
 * persisted image refs for mutable tags so a misconfiguration surfaces
 * ACTIONABLY instead of causing a confusing deploy-time rejection. This is the
 * inventory/migration step the issue calls for: existing
 * `APP_PREBUILT_IMAGES` entries and the `APP_DEFAULT_TEMPLATE_IMAGE` default
 * may carry mutable tags, and they need to be distinguished from a malicious
 * caller override.
 *
 * Pure: takes a list of `(source, ref)` tuples and the env-determined digest
 * requirement, returns the findings. The impure caller (startup/preflight hook)
 * supplies the refs to scan.
 */

import { describeImageReference } from "./containers/image-rollout-status";

export interface ImagePreflightEntry {
  /** Human-readable source of the ref (e.g. "APP_DEFAULT_TEMPLATE_IMAGE", "APP_PREBUILT_IMAGES[eDad Showcase]"). */
  source: string;
  /** The image reference as configured. */
  ref: string;
}

export interface ImagePreflightFinding {
  source: string;
  ref: string;
  /** The type of mutable pinning: `tag` or `implicit-latest`. */
  pinning: "tag" | "implicit-latest";
  /** Human-readable warning for the operator. */
  warning: string;
}

export interface ImagePreflightResult {
  /** Mutable refs found (empty when all scanned refs are digest-pinned). */
  mutableRefs: ImagePreflightFinding[];
  /** True when every scanned ref is content-addressed (production-safe). */
  allPinned: boolean;
}

/**
 * Scan configured/persisted image refs for mutable tags. Returns a structured
 * result listing every mutable ref with its source and pinning type.
 *
 * When `requireDigest` is true, the findings are actionable: each mutable ref
 * must be pinned to `repo@sha256:<64hex>` before the gate is armed, otherwise
 * deploys using it will be rejected. When false, the findings are advisory.
 */
export function scanImageRefsForMutableTags(
  entries: ImagePreflightEntry[],
  requireDigest: boolean,
): ImagePreflightResult {
  const mutableRefs: ImagePreflightFinding[] = [];

  for (const entry of entries) {
    const desc = describeImageReference(entry.ref);
    if (desc.productionSafe) continue;

    mutableRefs.push({
      source: entry.source,
      ref: entry.ref,
      pinning: desc.pinning === "implicit-latest" ? "implicit-latest" : "tag",
      warning: requireDigest
        ? `${entry.source}: image '${entry.ref}' is ${desc.pinning === "implicit-latest" ? "implicitly latest (no tag or digest)" : `mutable (tag '${desc.tag}')`} — pin to repo@sha256:<64hex> before arming the digest gate, or deploys using it will be rejected.`
        : `${entry.source}: image '${entry.ref}' is not digest-pinned (advisory: digest gate is off).`,
    });
  }

  return {
    mutableRefs,
    allPinned: mutableRefs.length === 0,
  };
}
