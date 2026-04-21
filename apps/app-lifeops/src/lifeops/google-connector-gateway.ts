import type {
  LifeOpsConnectorExecutionTarget,
  LifeOpsConnectorGrant,
  LifeOpsConnectorMode,
  LifeOpsConnectorSide,
  LifeOpsConnectorSourceOfTruth,
} from "@elizaos/shared/contracts/lifeops";
import {
  resolveConfiguredGoogleModes,
  resolveGoogleDefaultMode,
} from "./google-oauth.js";

export interface GoogleModeAvailability {
  defaultMode: LifeOpsConnectorMode;
  availableModes: LifeOpsConnectorMode[];
}

function uniqueModes(
  modes: readonly LifeOpsConnectorMode[],
): LifeOpsConnectorMode[] {
  return [...new Set(modes)];
}

export function resolveGoogleExecutionTarget(
  grantOrMode:
    | Pick<LifeOpsConnectorGrant, "executionTarget" | "mode">
    | LifeOpsConnectorMode,
): LifeOpsConnectorExecutionTarget {
  if (typeof grantOrMode === "string") {
    return grantOrMode === "cloud_managed" ? "cloud" : "local";
  }
  if (
    grantOrMode.executionTarget === "cloud" ||
    grantOrMode.mode === "cloud_managed"
  ) {
    return "cloud";
  }
  return "local";
}

export function resolveGoogleSourceOfTruth(
  grantOrMode:
    | Pick<LifeOpsConnectorGrant, "sourceOfTruth" | "mode">
    | LifeOpsConnectorMode,
): LifeOpsConnectorSourceOfTruth {
  if (typeof grantOrMode === "string") {
    return grantOrMode === "cloud_managed"
      ? "cloud_connection"
      : "local_storage";
  }
  if (
    grantOrMode.sourceOfTruth === "cloud_connection" ||
    grantOrMode.mode === "cloud_managed"
  ) {
    return "cloud_connection";
  }
  return "local_storage";
}

export function resolveGoogleAvailableModes(args: {
  requestUrl: URL;
  cloudConfigured: boolean;
  grants?: readonly LifeOpsConnectorGrant[];
}): GoogleModeAvailability {
  const localModes = resolveConfiguredGoogleModes();
  const grantedModes = (args.grants ?? [])
    .filter((grant) => grant.provider === "google")
    .map((grant) => grant.mode);
  const availableModes = uniqueModes([
    ...localModes,
    ...(args.cloudConfigured ? (["cloud_managed"] as const) : []),
    ...grantedModes,
  ]);

  const defaultMode = args.cloudConfigured
    ? "cloud_managed"
    : (availableModes[0] ?? resolveGoogleDefaultMode(args.requestUrl));

  return {
    defaultMode,
    availableModes,
  };
}

export function resolvePreferredGoogleGrant(args: {
  grants: readonly LifeOpsConnectorGrant[];
  requestedMode?: LifeOpsConnectorMode;
  requestedSide?: LifeOpsConnectorSide;
  /** When set, resolve this specific grant by ID (multi-account). */
  grantId?: string;
  defaultMode: LifeOpsConnectorMode;
}): LifeOpsConnectorGrant | null {
  // Direct lookup by grant ID — multi-account path.
  if (args.grantId) {
    return args.grants.find((g) => g.id === args.grantId) ?? null;
  }

  const googleGrants = args.grants.filter(
    (grant) => grant.provider === "google",
  );
  const scopedGrants = args.requestedSide
    ? googleGrants.filter((grant) => grant.side === args.requestedSide)
    : googleGrants;
  if (scopedGrants.length === 0) {
    return null;
  }

  if (args.requestedMode) {
    return (
      scopedGrants.find((grant) => grant.mode === args.requestedMode) ?? null
    );
  }

  const preferredGrant =
    scopedGrants.find((grant) => grant.preferredByAgent) ?? null;
  if (preferredGrant) {
    return preferredGrant;
  }

  const defaultGrant =
    scopedGrants.find((grant) => grant.mode === args.defaultMode) ?? null;
  if (defaultGrant) {
    return defaultGrant;
  }

  return (
    [...scopedGrants].sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt),
    )[0] ?? null
  );
}

/**
 * Resolve all Google grants matching the given filters, for multi-account aggregation.
 * When `grantId` is set, returns at most one grant.
 * When not set, returns all Google grants matching `side` (and optionally `mode`).
 */
export function resolveGoogleGrants(args: {
  grants: readonly LifeOpsConnectorGrant[];
  requestedMode?: LifeOpsConnectorMode;
  requestedSide?: LifeOpsConnectorSide;
  grantId?: string;
}): LifeOpsConnectorGrant[] {
  if (args.grantId) {
    const match = args.grants.find((g) => g.id === args.grantId);
    return match ? [match] : [];
  }

  let filtered = args.grants.filter((g) => g.provider === "google");
  if (args.requestedSide) {
    filtered = filtered.filter((g) => g.side === args.requestedSide);
  }
  if (args.requestedMode) {
    filtered = filtered.filter((g) => g.mode === args.requestedMode);
  }
  return filtered;
}
