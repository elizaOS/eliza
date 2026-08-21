/**
 * Resolves one versioned rate-and-resource entitlement for server enforcement.
 * Paid projections are catalog-fenced, degraded subscriptions fall to Free,
 * and audited manual fields overlay the selected base as highest authority.
 */
import type { SubscriptionPlanKey } from "../types/cloud-api";
import { getSubscriptionCatalogPlan } from "./subscription-catalog";

export type SubscriptionEntitlementLifecycleState =
  | "free"
  | "active"
  | "grace"
  | "past_due"
  | "unpaid"
  | "canceled";

export interface SubscriptionEntitlementLimits {
  completionsRpm: number;
  embeddingsRpm: number;
  standardRpm: number;
  strictRpm: number;
  cloudCharacters: number;
  agentSandboxes: number;
  containers: number;
  storageGiB: number;
  apps: number;
}

export interface SubscriptionEntitlementProjection {
  planKey: "free" | SubscriptionPlanKey;
  state: SubscriptionEntitlementLifecycleState;
  catalogVersion: string;
  projectionRevision: number;
  effectiveFrom: Date;
  effectiveUntil: Date | null;
  limits: SubscriptionEntitlementLimits;
}

export interface LegacyEntitlementSelection {
  selectorKey: string;
  selectorVersion: string;
  limits: SubscriptionEntitlementLimits;
}

export type ManualEntitlementFields = Partial<SubscriptionEntitlementLimits>;

export interface ManualEntitlementOverride {
  auditId: string;
  version: string;
  fields: ManualEntitlementFields;
}

export type SubscriptionEntitlementSource<T> =
  | { kind: "available"; value: T | null }
  | {
      kind: "unavailable";
      reason: string;
      retryable: boolean;
    };

export interface SubscriptionEntitlementVersions {
  catalog: string;
  entitlement: string;
  manualOverride: string | null;
}

export interface ReadySubscriptionEntitlement {
  kind: "ready";
  organizationId: string;
  source: "free" | "legacy" | "subscription" | "manual_override";
  baseSource: "free" | "legacy" | "subscription";
  planKey: "free" | SubscriptionPlanKey;
  lifecycleState: SubscriptionEntitlementLifecycleState;
  legacySelectorKey: string | null;
  limits: SubscriptionEntitlementLimits;
  catalogVersion: string;
  entitlementVersion: string;
  versions: SubscriptionEntitlementVersions;
}

export interface UnavailableSubscriptionEntitlement {
  kind: "unavailable";
  organizationId: string;
  reason:
    | "projection_source_unavailable"
    | "manual_override_source_unavailable"
    | "legacy_source_unavailable"
    | "invalid_projection"
    | "catalog_projection_mismatch"
    | "projection_not_effective"
    | "invalid_legacy_selection"
    | "invalid_manual_override";
  retryable: boolean;
  detail: string;
}

export type SubscriptionEntitlementResolution =
  | ReadySubscriptionEntitlement
  | UnavailableSubscriptionEntitlement;

export interface SubscriptionEntitlementSources {
  readProjection(
    organizationId: string,
  ): Promise<SubscriptionEntitlementSource<SubscriptionEntitlementProjection>>;
  readManualOverride(
    organizationId: string,
  ): Promise<SubscriptionEntitlementSource<ManualEntitlementOverride>>;
  readLegacySelection(
    organizationId: string,
  ): Promise<SubscriptionEntitlementSource<LegacyEntitlementSelection>>;
}

const FREE_CATALOG_VERSION = "v1";
const FREE_LIMITS: Readonly<SubscriptionEntitlementLimits> = Object.freeze({
  completionsRpm: 60,
  embeddingsRpm: 100,
  standardRpm: 30,
  strictRpm: 5,
  cloudCharacters: 5,
  agentSandboxes: 5,
  containers: 1,
  storageGiB: 5,
  apps: 25,
});
const LIMIT_KEYS = Object.keys(FREE_LIMITS) as Array<keyof SubscriptionEntitlementLimits>;

function unavailable(
  organizationId: string,
  reason: UnavailableSubscriptionEntitlement["reason"],
  retryable: boolean,
  detail: string,
): UnavailableSubscriptionEntitlement {
  return { kind: "unavailable", organizationId, reason, retryable, detail };
}

function isVersion(value: string): boolean {
  return value.trim().length > 0 && value.length <= 128;
}

function isLimit(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function limitsAreValid(limits: SubscriptionEntitlementLimits): boolean {
  return LIMIT_KEYS.every((key) => isLimit(limits[key]));
}

function sameLimits(
  left: SubscriptionEntitlementLimits,
  right: SubscriptionEntitlementLimits,
): boolean {
  return LIMIT_KEYS.every((key) => left[key] === right[key]);
}

function catalogLimits(planKey: SubscriptionPlanKey): {
  catalogVersion: string;
  limits: SubscriptionEntitlementLimits;
} {
  const plan = getSubscriptionCatalogPlan(planKey);
  return {
    catalogVersion: plan.catalogVersion,
    limits: {
      ...plan.rateLimits,
      ...plan.resourceCeilings,
    },
  };
}

function freeBase(
  organizationId: string,
  lifecycleState: SubscriptionEntitlementLifecycleState,
  entitlementVersion: string,
): ReadySubscriptionEntitlement {
  return {
    kind: "ready",
    organizationId,
    source: "free",
    baseSource: "free",
    planKey: "free",
    lifecycleState,
    legacySelectorKey: null,
    limits: { ...FREE_LIMITS },
    catalogVersion: FREE_CATALOG_VERSION,
    entitlementVersion,
    versions: {
      catalog: FREE_CATALOG_VERSION,
      entitlement: entitlementVersion,
      manualOverride: null,
    },
  };
}

function resolveProjectionBase(
  organizationId: string,
  projection: SubscriptionEntitlementProjection,
  now: Date,
): ReadySubscriptionEntitlement | UnavailableSubscriptionEntitlement | null {
  if (
    !Number.isSafeInteger(projection.projectionRevision) ||
    projection.projectionRevision < 0 ||
    !isVersion(projection.catalogVersion) ||
    !limitsAreValid(projection.limits) ||
    !Number.isFinite(projection.effectiveFrom.getTime()) ||
    (projection.effectiveUntil !== null && !Number.isFinite(projection.effectiveUntil.getTime()))
  ) {
    return unavailable(organizationId, "invalid_projection", false, "Projection shape is invalid");
  }
  const entitlementVersion = `projection:${projection.projectionRevision}`;
  if (projection.state === "free") {
    if (projection.planKey !== "free") {
      return unavailable(
        organizationId,
        "invalid_projection",
        false,
        "Free state requires the free plan",
      );
    }
    return null;
  }
  if (projection.planKey === "free") {
    return unavailable(
      organizationId,
      "invalid_projection",
      false,
      "Paid lifecycle state requires a paid plan",
    );
  }
  const approved = catalogLimits(projection.planKey);
  if (
    projection.catalogVersion !== approved.catalogVersion ||
    !sameLimits(projection.limits, approved.limits)
  ) {
    return unavailable(
      organizationId,
      "catalog_projection_mismatch",
      false,
      "Projection does not match its immutable catalog version",
    );
  }
  if (["past_due", "unpaid", "canceled"].includes(projection.state)) {
    return freeBase(organizationId, projection.state, entitlementVersion);
  }
  if (projection.state !== "active" && projection.state !== "grace") {
    return unavailable(
      organizationId,
      "invalid_projection",
      false,
      "Projection lifecycle state is unsupported",
    );
  }
  if (
    now < projection.effectiveFrom ||
    (projection.effectiveUntil !== null && now >= projection.effectiveUntil)
  ) {
    return unavailable(
      organizationId,
      "projection_not_effective",
      true,
      "Paid projection is outside its effective interval",
    );
  }
  return {
    kind: "ready",
    organizationId,
    source: "subscription",
    baseSource: "subscription",
    planKey: projection.planKey,
    lifecycleState: projection.state,
    legacySelectorKey: null,
    limits: { ...approved.limits },
    catalogVersion: approved.catalogVersion,
    entitlementVersion,
    versions: {
      catalog: approved.catalogVersion,
      entitlement: entitlementVersion,
      manualOverride: null,
    },
  };
}

function resolveLegacyBase(
  organizationId: string,
  legacy: LegacyEntitlementSelection | null,
): ReadySubscriptionEntitlement | UnavailableSubscriptionEntitlement {
  if (legacy === null) return freeBase(organizationId, "free", "free:v1");
  if (
    !isVersion(legacy.selectorKey) ||
    !isVersion(legacy.selectorVersion) ||
    !limitsAreValid(legacy.limits)
  ) {
    return unavailable(
      organizationId,
      "invalid_legacy_selection",
      false,
      "Legacy selector is invalid",
    );
  }
  const entitlementVersion = `legacy:${legacy.selectorVersion}`;
  return {
    kind: "ready",
    organizationId,
    source: "legacy",
    baseSource: "legacy",
    planKey: "free",
    lifecycleState: "free",
    legacySelectorKey: legacy.selectorKey,
    limits: { ...legacy.limits },
    catalogVersion: FREE_CATALOG_VERSION,
    entitlementVersion,
    versions: {
      catalog: FREE_CATALOG_VERSION,
      entitlement: entitlementVersion,
      manualOverride: null,
    },
  };
}

function applyManualOverride(
  organizationId: string,
  base: ReadySubscriptionEntitlement,
  override: ManualEntitlementOverride | null,
): SubscriptionEntitlementResolution {
  if (override === null) return base;
  const fields = Object.entries(override.fields) as Array<
    [keyof SubscriptionEntitlementLimits, number]
  >;
  if (
    !isVersion(override.auditId) ||
    !isVersion(override.version) ||
    fields.length === 0 ||
    fields.some(([key, value]) => !LIMIT_KEYS.includes(key) || !isLimit(value))
  ) {
    return unavailable(
      organizationId,
      "invalid_manual_override",
      false,
      "Manual override must be audited, versioned, and bounded",
    );
  }
  const limits = { ...base.limits };
  for (const [key, value] of fields) limits[key] = value;
  const entitlementVersion = `${base.entitlementVersion}|override:${override.version}`;
  return {
    ...base,
    source: "manual_override",
    limits,
    entitlementVersion,
    versions: {
      ...base.versions,
      entitlement: entitlementVersion,
      manualOverride: override.version,
    },
  };
}

export class SubscriptionEntitlementService {
  constructor(private readonly sources: SubscriptionEntitlementSources) {}

  async resolve(
    organizationId: string,
    now: Date = new Date(),
  ): Promise<SubscriptionEntitlementResolution> {
    const [projectionSource, overrideSource] = await Promise.all([
      this.sources.readProjection(organizationId),
      this.sources.readManualOverride(organizationId),
    ]);
    if (projectionSource.kind === "unavailable") {
      return unavailable(
        organizationId,
        "projection_source_unavailable",
        projectionSource.retryable,
        projectionSource.reason,
      );
    }
    if (overrideSource.kind === "unavailable") {
      return unavailable(
        organizationId,
        "manual_override_source_unavailable",
        overrideSource.retryable,
        overrideSource.reason,
      );
    }

    const projection = projectionSource.value;
    const projectedBase = projection
      ? resolveProjectionBase(organizationId, projection, now)
      : null;
    if (projectedBase?.kind === "unavailable") return projectedBase;
    if (projectedBase) {
      return applyManualOverride(organizationId, projectedBase, overrideSource.value);
    }

    const legacySource = await this.sources.readLegacySelection(organizationId);
    if (legacySource.kind === "unavailable") {
      return unavailable(
        organizationId,
        "legacy_source_unavailable",
        legacySource.retryable,
        legacySource.reason,
      );
    }
    const legacyBase = resolveLegacyBase(organizationId, legacySource.value);
    if (legacyBase.kind === "unavailable") return legacyBase;
    return applyManualOverride(organizationId, legacyBase, overrideSource.value);
  }
}

export const FREE_SUBSCRIPTION_ENTITLEMENT_LIMITS = FREE_LIMITS;
