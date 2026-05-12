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
    totalReady: number;
    matchingDesired: number;
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
  unsupportedActions: Array<{
    action: "canary" | "rollback";
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
  enabled: boolean;
  rows: RolloutPoolRow[];
}): ImageRolloutSummary {
  const desired = describeImageReference(params.desiredImage);
  const currentCounts = new Map<
    string,
    { image: string; tag: string | null; digest: string | null; count: number }
  >();
  const staleRows: ImageRolloutSummary["staleRows"] = [];
  let matchingDesired = 0;
  let unknownImage = 0;

  for (const row of params.rows) {
    if (!row.docker_image) {
      unknownImage++;
      staleRows.push({
        id: row.id,
        currentImage: null,
        currentTag: null,
        currentDigest: null,
        nodeId: row.node_id,
        poolReadyAt: row.pool_ready_at,
        healthUrl: row.health_url,
      });
      continue;
    }

    const current = describeImageReference(row.docker_image);
    const existing = currentCounts.get(row.docker_image);
    if (existing) {
      existing.count++;
    } else {
      currentCounts.set(row.docker_image, {
        image: row.docker_image,
        tag: current.tag,
        digest: current.digest,
        count: 1,
      });
    }

    if (imageMatchesDesired(row.docker_image, params.desiredImage)) {
      matchingDesired++;
    } else {
      staleRows.push({
        id: row.id,
        currentImage: row.docker_image,
        currentTag: current.tag,
        currentDigest: current.digest,
        nodeId: row.node_id,
        poolReadyAt: row.pool_ready_at,
        healthUrl: row.health_url,
      });
    }
  }

  const totalReady = params.rows.length;
  let status: ImageRolloutStatus;
  let safeNextAction: ImageRolloutSafeNextAction;
  if (!params.enabled) {
    status = "disabled";
    safeNextAction = "noop_pool_disabled";
  } else if (!desired.productionSafe) {
    status = "blocked_unpinned_desired_image";
    safeNextAction = "configure_pinned_desired_image";
  } else if (totalReady === 0) {
    status = "no_ready_pool";
    safeNextAction = "replenish_pool";
  } else if (staleRows.length > 0) {
    status = "needs_rollout";
    safeNextAction = "replace_stale_pool_entries";
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
      totalReady,
      matchingDesired,
      stale: staleRows.length,
      unknownImage,
    },
    currentImages: Array.from(currentCounts.values()).sort((a, b) =>
      a.image.localeCompare(b.image),
    ),
    staleRows,
    unsupportedActions: [
      {
        action: "canary",
        reason:
          "TODO: requires per-cohort claim routing and health gates before replacing ready pool entries.",
      },
      {
        action: "rollback",
        reason:
          "TODO: requires persisted previous desired image and operator approval before automated rollback.",
      },
    ],
  };
}
