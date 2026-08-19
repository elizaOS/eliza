// Coordinates cloud service image rollout status behavior behind route handlers.
export type ImagePinning = "digest" | "tag" | "implicit-latest";

const SHA256_DIGEST_RE = /^sha256:[a-f0-9]{64}$/i;

export interface ImageReferenceStatus {
  reference: string;
  repository: string;
  tag: string | null;
  digest: string | null;
  pinning: ImagePinning;
  productionSafe: boolean;
  warning: string | null;
}

export interface RolloutPoolRow {
  id: string;
  docker_image: string | null;
  image_digest: string | null;
  claimable: boolean;
  node_id: string | null;
  pool_ready_at: Date | null;
  health_url: string | null;
}

export type ImageRolloutStatus =
  | "disabled"
  | "blocked_unpinned_desired_image"
  | "no_ready_pool"
  | "current"
  | "needs_rollout";

export type ImageRolloutSafeNextAction =
  | "noop_pool_disabled"
  | "configure_pinned_desired_image"
  | "replenish_pool"
  | "replace_stale_pool_entries"
  | "none";

export interface ImageRolloutSummary {
  desired: ImageReferenceStatus;
  enabled: boolean;
  status: ImageRolloutStatus;
  safeNextAction: ImageRolloutSafeNextAction;
  counts: {
    totalGenerations: number;
    totalReady: number;
    inFlightOrUnclaimable: number;
    matchingDesired: number;
    matchingReady: number;
    stale: number;
    unknownImage: number;
  };
  currentImages: Array<{
    image: string;
    tag: string | null;
    digest: string | null;
    count: number;
  }>;
  staleRows: Array<{
    id: string;
    currentImage: string | null;
    currentTag: string | null;
    currentDigest: string | null;
    nodeId: string | null;
    poolReadyAt: Date | null;
    healthUrl: string | null;
  }>;
  /**
   * Operator-gated actions that ARE supported but never run automatically. A
   * rollback swaps each agent back onto its persisted `previous_image_digest`
   * via `elizaSandboxService.executeDowngrade`; it requires an explicit
   * operator action (`requiresOperatorApproval`) and is only available once a
   * prior good image has been persisted (i.e. after at least one upgrade).
   */
  supportedActions: Array<{
    action: "rollback";
    requiresOperatorApproval: true;
    note: string;
  }>;
  unsupportedActions: Array<{
    action: "canary";
    reason: string;
  }>;
}

export function describeImageReference(reference: string): ImageReferenceStatus {
  const trimmed = reference.trim();
  const digestIndex = trimmed.indexOf("@sha256:");
  const digest = digestIndex >= 0 ? trimmed.slice(digestIndex + 1) : null;
  const withoutDigest = digestIndex >= 0 ? trimmed.slice(0, digestIndex) : trimmed;
  const slashIndex = withoutDigest.lastIndexOf("/");
  const colonIndex = withoutDigest.lastIndexOf(":");
  const hasExplicitTag = colonIndex > slashIndex;
  const tag = hasExplicitTag ? withoutDigest.slice(colonIndex + 1) : null;
  const repository = hasExplicitTag ? withoutDigest.slice(0, colonIndex) : withoutDigest;
  const pinning: ImagePinning = digest ? "digest" : tag ? "tag" : "implicit-latest";
  const validDigest = digest ? SHA256_DIGEST_RE.test(digest) : false;
  const productionSafe = pinning === "digest" && validDigest;

  return {
    reference: trimmed,
    repository,
    tag: tag ?? (pinning === "implicit-latest" ? "latest" : null),
    digest,
    pinning,
    productionSafe,
    warning: productionSafe
      ? null
      : pinning === "digest"
        ? "Image digest must be a full sha256:<64 hex> reference."
        : pinning === "implicit-latest"
          ? "Image has no explicit tag or digest; Docker will resolve mutable latest."
          : `Image tag '${tag}' is mutable without a digest pin.`,
  };
}

export function imageMatchesDesired(currentImage: string | null, desiredImage: string): boolean {
  if (!currentImage) return false;
  const current = describeImageReference(currentImage);
  const desired = describeImageReference(desiredImage);
  if (desired.digest) return current.digest === desired.digest;
  return current.reference === desired.reference;
}

export function summarizeImageRollout(params: {
  desiredImage: string;
  desiredDigest?: string;
  enabled: boolean;
  rows: RolloutPoolRow[];
}): ImageRolloutSummary {
  const configured = describeImageReference(params.desiredImage);
  const desired = params.desiredDigest
    ? {
        ...configured,
        reference: `${configured.repository}@${params.desiredDigest}`,
        digest: params.desiredDigest,
        pinning: "digest" as const,
        productionSafe: SHA256_DIGEST_RE.test(params.desiredDigest),
        warning: SHA256_DIGEST_RE.test(params.desiredDigest)
          ? null
          : "Resolved image digest must be a full sha256:<64 hex> reference.",
      }
    : configured;
  const currentCounts = new Map<
    string,
    { image: string; tag: string | null; digest: string | null; count: number }
  >();
  const staleRows: ImageRolloutSummary["staleRows"] = [];
  let matchingDesired = 0;
  let matchingReady = 0;
  let unknownImage = 0;

  for (const row of params.rows) {
    if (!row.image_digest) {
      unknownImage++;
    }

    if (row.docker_image) {
      const current = describeImageReference(row.docker_image);
      const currentKey = `${row.docker_image}\u0000${row.image_digest ?? "unknown"}`;
      const existing = currentCounts.get(currentKey);
      if (existing) {
        existing.count++;
      } else {
        currentCounts.set(currentKey, {
          image: row.docker_image,
          tag: current.tag,
          digest: row.image_digest,
          count: 1,
        });
      }
    }

    const matchesDesired = params.desiredDigest
      ? row.image_digest === params.desiredDigest
      : imageMatchesDesired(row.docker_image, params.desiredImage);
    if (matchesDesired) {
      matchingDesired++;
      if (row.claimable) matchingReady++;
    } else {
      const current = row.docker_image ? describeImageReference(row.docker_image) : null;
      staleRows.push({
        id: row.id,
        currentImage: row.docker_image,
        currentTag: current?.tag ?? null,
        currentDigest: row.image_digest,
        nodeId: row.node_id,
        poolReadyAt: row.pool_ready_at,
        healthUrl: row.health_url,
      });
    }
  }

  const totalReady = params.rows.filter((row) => row.claimable).length;
  let status: ImageRolloutStatus;
  let safeNextAction: ImageRolloutSafeNextAction;
  if (!params.enabled) {
    status = "disabled";
    safeNextAction = "noop_pool_disabled";
  } else if (!desired.productionSafe) {
    status = "blocked_unpinned_desired_image";
    safeNextAction = "configure_pinned_desired_image";
  } else if (staleRows.length > 0) {
    status = "needs_rollout";
    safeNextAction = "replace_stale_pool_entries";
  } else if (totalReady === 0) {
    status = "no_ready_pool";
    safeNextAction = "replenish_pool";
  } else {
    status = "current";
    safeNextAction = "none";
  }

  return {
    desired,
    enabled: params.enabled,
    status,
    safeNextAction,
    counts: {
      totalGenerations: params.rows.length,
      totalReady,
      inFlightOrUnclaimable: params.rows.length - totalReady,
      matchingDesired,
      matchingReady,
      stale: staleRows.length,
      unknownImage,
    },
    currentImages: Array.from(currentCounts.values()).sort(
      (a, b) => a.image.localeCompare(b.image) || (a.digest ?? "").localeCompare(b.digest ?? ""),
    ),
    staleRows,
    supportedActions: [
      {
        action: "rollback",
        requiresOperatorApproval: true,
        note: "Operator-gated: swaps each agent back onto its persisted previous_image_digest via executeDowngrade. Never runs automatically.",
      },
    ],
    unsupportedActions: [
      {
        action: "canary",
        reason:
          "Unsupported until per-cohort claim routing and health gates protect ready-pool replacement.",
      },
    ],
  };
}
