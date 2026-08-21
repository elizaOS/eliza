/**
 * Projects the on-device personal-data bridges (location, contacts, calendar,
 * reminders, health, photos, phone, messages) into the provider-neutral
 * connected-account capability contracts from `@elizaos/core`, so hosts and
 * planners can reason about native data access the same way they reason about
 * managed cloud connections.
 *
 * The projection is metadata-only by construction: it carries permission and
 * availability state, never contact rows, message bodies, coordinates, or any
 * other personal payload. `residency` is always `"device"` — nothing here
 * authorizes or implies a Cloud upload, and every domain works offline because
 * the data source is the device itself. Consumers are the agent host's
 * `/api/permissions/native-projection` route and native app shells, which call
 * the pure projection directly with their live permission and app state.
 */
import type {
  CapabilityRiskLevel,
  ConnectedAccount,
  ConnectedAccountCapability,
  ConnectedAccountStatus,
} from "@elizaos/core";
import { ElizaError } from "@elizaos/core";
import type {
  PermissionId,
  PermissionRestrictedReason,
  PermissionState,
  PermissionStatus,
  Platform,
} from "./permissions.js";

/** Personal data never leaves the device as part of this contract. */
export const NATIVE_PERSONAL_DATA_RESIDENCY = "device" as const;
export type NativePersonalDataResidency = typeof NATIVE_PERSONAL_DATA_RESIDENCY;

export const NATIVE_PERSONAL_DATA_DOMAINS = [
  "location",
  "contacts",
  "calendar",
  "reminders",
  "health",
  "photos",
  "phone",
  "messages",
] as const;
export type NativePersonalDataDomain =
  (typeof NATIVE_PERSONAL_DATA_DOMAINS)[number];

export function isNativePersonalDataDomain(
  value: unknown,
): value is NativePersonalDataDomain {
  return (
    typeof value === "string" &&
    (NATIVE_PERSONAL_DATA_DOMAINS as readonly string[]).includes(value)
  );
}

/** One bridge operation projected as a capability. */
export interface NativePersonalDataOperation {
  /** Stable capability handle: `native.<domain>.<operation>`. */
  capabilityId: string;
  operation: "read" | "write" | "dispatch";
  riskLevel: CapabilityRiskLevel;
  /**
   * True when the bridge can only serve the operation while the app is
   * foregrounded (system picker or call UI); such capabilities project as
   * `provider_unavailable` from a backgrounded app.
   */
  requiresForeground: boolean;
}

export interface NativePersonalDataDomainDefinition {
  domain: NativePersonalDataDomain;
  permissionId: PermissionId;
  label: string;
  operations: readonly NativePersonalDataOperation[];
}

function op(
  domain: NativePersonalDataDomain,
  operation: NativePersonalDataOperation["operation"],
  riskLevel: CapabilityRiskLevel,
  requiresForeground = false,
): NativePersonalDataOperation {
  return {
    capabilityId: `native.${domain}.${operation}`,
    operation,
    riskLevel,
    requiresForeground,
  };
}

/**
 * Canonical domain → permission/capability table. Reads of personal data are
 * R1 (R2 for health, the most sensitive store), on-device writes are R2, and
 * outward-visible dispatches (placing a call, sending a message) are R3.
 */
export const NATIVE_PERSONAL_DATA_DOMAIN_DEFINITIONS: Readonly<
  Record<NativePersonalDataDomain, NativePersonalDataDomainDefinition>
> = Object.freeze({
  location: {
    domain: "location",
    permissionId: "location",
    label: "Location",
    operations: [op("location", "read", "R1")],
  },
  contacts: {
    domain: "contacts",
    permissionId: "contacts",
    label: "Contacts",
    operations: [op("contacts", "read", "R1"), op("contacts", "write", "R2")],
  },
  calendar: {
    domain: "calendar",
    permissionId: "calendar",
    label: "Calendar",
    operations: [op("calendar", "read", "R1"), op("calendar", "write", "R2")],
  },
  reminders: {
    domain: "reminders",
    permissionId: "reminders",
    label: "Reminders",
    operations: [op("reminders", "read", "R1"), op("reminders", "write", "R2")],
  },
  health: {
    domain: "health",
    permissionId: "health",
    label: "Health",
    operations: [op("health", "read", "R2")],
  },
  photos: {
    domain: "photos",
    permissionId: "photos",
    label: "Photos",
    operations: [op("photos", "read", "R1", true)],
  },
  phone: {
    domain: "phone",
    permissionId: "phone",
    label: "Phone",
    operations: [
      op("phone", "read", "R1"),
      op("phone", "dispatch", "R3", true),
    ],
  },
  messages: {
    domain: "messages",
    permissionId: "messages",
    label: "Messages",
    operations: [
      op("messages", "read", "R2"),
      op("messages", "dispatch", "R3"),
    ],
  },
});

/** Domain-level availability derived from the permission probe. */
export type NativePersonalDataAvailability =
  | "available"
  | "limited"
  | "needs_permission"
  | "denied"
  | "restricted"
  | "unsupported";

export interface NativePersonalDataDomainStatus {
  domain: NativePersonalDataDomain;
  permissionId: PermissionId;
  label: string;
  availability: NativePersonalDataAvailability;
  permissionStatus: PermissionStatus;
  restrictedReason: PermissionRestrictedReason | null;
  canRequest: boolean;
  platform: Platform;
  residency: NativePersonalDataResidency;
  /** On-device stores do not depend on connectivity. */
  worksOffline: true;
  lastCheckedAt: number;
  capabilities: readonly ConnectedAccountCapability[];
}

/** Host context the projection is evaluated against. */
export interface NativePersonalDataRuntimeContext {
  platform: Platform;
  /** Recorded for evidence; availability never degrades offline. */
  online: boolean;
  appState: "foreground" | "background";
}

export interface NativePersonalDataProjection {
  generatedAt: string;
  residency: NativePersonalDataResidency;
  runtime: NativePersonalDataRuntimeContext;
  domains: readonly NativePersonalDataDomainStatus[];
  account: ConnectedAccount;
}

const AVAILABILITY_BY_STATUS: Readonly<
  Record<PermissionStatus, NativePersonalDataAvailability>
> = Object.freeze({
  granted: "available",
  limited: "limited",
  "not-determined": "needs_permission",
  denied: "denied",
  restricted: "restricted",
  "not-applicable": "unsupported",
});

function capabilityStatus(
  state: PermissionState,
  operation: NativePersonalDataOperation,
  appState: NativePersonalDataRuntimeContext["appState"],
): ConnectedAccountCapability["status"] {
  switch (state.status) {
    case "granted":
    case "limited":
      return operation.requiresForeground && appState === "background"
        ? "provider_unavailable"
        : "available";
    case "not-determined":
      return "not_configured";
    case "denied":
      return "needs_scope";
    case "restricted":
      return state.restrictedReason === "platform_unsupported"
        ? "unsupported"
        : "needs_admin";
    case "not-applicable":
      return "unsupported";
  }
}

/**
 * Pure, deterministic projection of the native personal-data bridges into the
 * shared capability contract. `states` must contain exactly one entry per
 * domain permission id (extra unrelated permission ids are ignored); a missing
 * or duplicated entry throws — never a fabricated healthy default.
 */
export function projectNativePersonalDataCapabilities(
  states: readonly PermissionState[],
  runtime: NativePersonalDataRuntimeContext,
  generatedAt: string,
): NativePersonalDataProjection {
  const byId = new Map<PermissionId, PermissionState>();
  for (const state of states) {
    if (!isNativePersonalDataDomain(state.id)) continue;
    if (byId.has(state.id)) {
      throw new ElizaError(
        `NativePersonalData: duplicate permission state for "${state.id}"`,
        {
          code: "NATIVE_PERSONAL_DATA_DUPLICATE_STATE",
          context: { permissionId: state.id },
        },
      );
    }
    byId.set(state.id, state);
  }

  const domains: NativePersonalDataDomainStatus[] = [];
  for (const domain of NATIVE_PERSONAL_DATA_DOMAINS) {
    const definition = NATIVE_PERSONAL_DATA_DOMAIN_DEFINITIONS[domain];
    const state = byId.get(definition.permissionId);
    if (!state) {
      throw new ElizaError(
        `NativePersonalData: no permission state supplied for "${definition.permissionId}"`,
        {
          code: "NATIVE_PERSONAL_DATA_STATE_MISSING",
          context: { permissionId: definition.permissionId },
        },
      );
    }
    domains.push({
      domain,
      permissionId: definition.permissionId,
      label: definition.label,
      availability: AVAILABILITY_BY_STATUS[state.status],
      permissionStatus: state.status,
      restrictedReason: state.restrictedReason ?? null,
      canRequest: state.canRequest,
      platform: state.platform,
      residency: NATIVE_PERSONAL_DATA_RESIDENCY,
      worksOffline: true,
      lastCheckedAt: state.lastChecked,
      capabilities: definition.operations.map((operation) => ({
        capabilityId: operation.capabilityId,
        riskLevel: operation.riskLevel,
        status: capabilityStatus(state, operation, runtime.appState),
      })),
    });
  }

  const anyUsable = domains.some(
    (d) => d.availability === "available" || d.availability === "limited",
  );
  const accountStatus: ConnectedAccountStatus = anyUsable
    ? "connected"
    : "unavailable";

  const account: ConnectedAccount = {
    contractVersion: 2,
    accountId: `native-device:${runtime.platform}`,
    providerId: "native-device",
    mode: "native",
    status: accountStatus,
    displayName: `On-device personal data (${runtime.platform})`,
    capabilities: domains.flatMap((d) => d.capabilities),
    lastUsedAt: null,
  };

  return {
    generatedAt,
    residency: NATIVE_PERSONAL_DATA_RESIDENCY,
    runtime,
    domains,
    account,
  };
}

const PROJECTION_KEYS = Object.freeze([
  "generatedAt",
  "residency",
  "runtime",
  "domains",
  "account",
]);
const RUNTIME_KEYS = Object.freeze(["platform", "online", "appState"]);
const DOMAIN_KEYS = Object.freeze([
  "domain",
  "permissionId",
  "label",
  "availability",
  "permissionStatus",
  "restrictedReason",
  "canRequest",
  "platform",
  "residency",
  "worksOffline",
  "lastCheckedAt",
  "capabilities",
]);
const CAPABILITY_KEYS = Object.freeze(["capabilityId", "riskLevel", "status"]);
const ACCOUNT_KEYS = Object.freeze([
  "contractVersion",
  "accountId",
  "providerId",
  "mode",
  "status",
  "displayName",
  "capabilities",
  "lastUsedAt",
]);

function assertClosedKeys(
  value: object,
  allowed: readonly string[],
  where: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new ElizaError(
        `NativePersonalData: unexpected field "${key}" in ${where}; the projection is metadata-only`,
        {
          code: "NATIVE_PERSONAL_DATA_PAYLOAD_LEAK",
          context: { where, key },
        },
      );
    }
  }
}

/**
 * Enforces the metadata-only invariant at trust boundaries: throws if the
 * projection carries any field outside the closed contract key sets, so a
 * personal-data payload can never ride along into logs, model context, or a
 * Cloud request.
 */
export function assertNativePersonalDataProjectionMetadataOnly(
  projection: NativePersonalDataProjection,
): void {
  assertClosedKeys(projection, PROJECTION_KEYS, "projection");
  assertClosedKeys(projection.runtime, RUNTIME_KEYS, "runtime");
  assertClosedKeys(projection.account, ACCOUNT_KEYS, "account");
  for (const capability of projection.account.capabilities) {
    assertClosedKeys(capability, CAPABILITY_KEYS, "account.capabilities[]");
  }
  for (const domain of projection.domains) {
    assertClosedKeys(domain, DOMAIN_KEYS, "domains[]");
    for (const capability of domain.capabilities) {
      assertClosedKeys(capability, CAPABILITY_KEYS, "domains[].capabilities[]");
    }
  }
}
