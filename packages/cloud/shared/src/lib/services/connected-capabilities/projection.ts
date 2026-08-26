/**
 * Pure projection of managed connection rows into the provider-neutral
 * `ConnectedAccount` capability DTO defined by `@elizaos/core`. Storage tables
 * stay separate; this module reads their already-loaded rows and emits only
 * contract-normalized projections, so no token, ciphertext, DEK, nonce, or
 * other secret column can reach an API payload.
 *
 * Account IDs are opaque capability handles derived from a SHA-256 digest of
 * the source family and row ID — never the raw credential row ID — so clients
 * cannot correlate the handle back to a storage row without the projection.
 */

import {
  type CapabilityRiskLevel,
  type CapabilityUnavailableCode,
  type ConnectedAccount,
  type ConnectedAccountCapability,
  type ConnectedAccountStatus,
  normalizeConnectedAccount,
  PROVIDER_INTEGRATION_CONTRACT_VERSION,
} from "@elizaos/core";
import type { discordConnections } from "../../../db/schemas/discord-connections";
import type { phoneGatewayDevices } from "../../../db/schemas/phone-gateway-devices";
import type { platformCredentials } from "../../../db/schemas/platform-credentials";
import type { vendorConnections } from "../../../db/schemas/vendor-connections";
import { sha256Hex } from "../../crypto/worker";

/**
 * Row shapes are `Pick`s of the Drizzle select model, not the full inferred
 * row: they are the contract the DB loader's explicit column list (`./index.ts`)
 * must satisfy, so a column can never rejoin this read path by falling out of
 * sync with what the query actually selects (#19883 follow-up). No
 * token/ciphertext/DEK/nonce column appears in any of them.
 */
export type PlatformCredentialRow = Pick<
  typeof platformCredentials.$inferSelect,
  | "id"
  | "platform"
  | "platform_display_name"
  | "platform_username"
  | "status"
  | "scopes"
  | "last_used_at"
  | "deleted_at"
>;

/**
 * `hasRefreshToken` replaces the raw `refresh_token_encrypted` column: the
 * loader computes the null-check in SQL (`col IS NOT NULL`) so the ciphertext
 * itself never crosses into Worker memory, only whether a refresh token row
 * exists.
 */
export type VendorConnectionRow = Pick<
  typeof vendorConnections.$inferSelect,
  "id" | "vendor" | "label" | "expires_at" | "scopes" | "deleted_at"
> & { hasRefreshToken: boolean };

export type DiscordConnectionRow = Pick<
  typeof discordConnections.$inferSelect,
  "id" | "is_active" | "status" | "last_heartbeat"
>;

export type PhoneGatewayDeviceRow = Pick<
  typeof phoneGatewayDevices.$inferSelect,
  | "id"
  | "is_active"
  | "can_send_sms"
  | "can_receive_sms"
  | "can_send_imessage"
  | "can_receive_imessage"
  | "friendly_name"
  | "phone_account_label"
  | "last_seen_at"
> & { isRetiredBlueBubbles: boolean };

/** One organization's raw connection rows across every projected source table. */
export interface ConnectedCapabilitySourceRows {
  platformCredentials: readonly PlatformCredentialRow[];
  vendorConnections: readonly VendorConnectionRow[];
  discordConnections: readonly DiscordConnectionRow[];
  phoneGatewayDevices: readonly PhoneGatewayDeviceRow[];
}

const ACCOUNT_ID_PREFIX = "ca_";

/**
 * Only scopes affirmatively recognized as read-only carry the low (R1) risk
 * classification; every other scope string — including one this pattern has
 * never seen — defaults to elevated (R2). This is deliberately the inverse of
 * a "flag known-dangerous verbs" pattern: a provider scope vocabulary this
 * code doesn't recognize must fail closed to the higher-risk class rather
 * than silently under-classify it (the earlier write-verb allowlist let scopes
 * like `issues:create` — a mutating verb absent from its word list — default
 * to R1).
 */
const READ_ONLY_SCOPE_PATTERN = /read|view|list|get|fetch/i;

async function deriveAccountId(source: string, rowId: string): Promise<string> {
  const digest = await sha256Hex(`eliza-cloud/connected-capability\n${source}\n${rowId}`);
  return `${ACCOUNT_ID_PREFIX}${digest.slice(0, 32)}`;
}

function unavailableCodeFor(
  status: ConnectedAccountStatus,
): "available" | CapabilityUnavailableCode {
  switch (status) {
    case "connected":
      return "available";
    case "disabled":
      return "account_disabled";
    case "error":
      return "account_error";
    case "revoked":
      return "account_revoked";
    case "reauth_required":
      return "needs_scope";
    case "unavailable":
      return "not_configured";
  }
}

/**
 * Project granted OAuth scopes into capability entries. Scope strings are
 * provider data, so risk is classified structurally: only scopes recognized
 * as read-only map to R1, everything else fails closed to R2. A connection
 * with no recorded scopes still exposes a single base connection capability
 * so it remains addressable.
 *
 * `scopes === null`/`undefined` is a distinct, narrower case than `[]`: it
 * means the grant set was never recorded (e.g. rows written before scope
 * tracking existed), not that the connection was verified to hold zero
 * scopes. Projecting that as a live `available` base capability would be an
 * unknown-reads-as-healthy over-grant — the same failure mode
 * `projectPhoneGatewayDevice` avoids for ungranted device permissions below —
 * so an unrecorded scope set always projects as `unsupported`, never as a
 * status derived from the (possibly "connected") account state.
 */
function scopeCapabilities(
  providerId: string,
  scopes: readonly string[] | null | undefined,
  accountStatus: ConnectedAccountStatus,
): ConnectedAccountCapability[] {
  if (scopes == null) {
    return [
      {
        capabilityId: `${providerId}/connection`,
        riskLevel: "R1",
        status: "unsupported",
      },
    ];
  }
  const status = unavailableCodeFor(accountStatus);
  const entries = new Map<string, ConnectedAccountCapability>();
  for (const scope of scopes) {
    const trimmed = scope.trim();
    if (trimmed.length === 0 || trimmed.length > 200) {
      continue;
    }
    const capabilityId = `${providerId}/${trimmed}`;
    if (!entries.has(capabilityId)) {
      entries.set(capabilityId, {
        capabilityId,
        riskLevel: READ_ONLY_SCOPE_PATTERN.test(trimmed) ? "R1" : "R2",
        status,
      });
    }
  }
  if (entries.size === 0) {
    entries.set(`${providerId}/connection`, {
      capabilityId: `${providerId}/connection`,
      riskLevel: "R1",
      status,
    });
  }
  return [...entries.values()];
}

function isoOrNull(value: Date | null | undefined): string | null {
  return value instanceof Date ? value.toISOString() : null;
}

function platformCredentialStatus(row: PlatformCredentialRow): ConnectedAccountStatus {
  switch (row.status) {
    case "active":
      return "connected";
    case "expired":
      return "reauth_required";
    case "revoked":
      return "revoked";
    case "error":
      return "error";
    case "pending":
      return "unavailable";
  }
}

async function projectPlatformCredential(row: PlatformCredentialRow): Promise<ConnectedAccount> {
  const status = platformCredentialStatus(row);
  const displayName = row.platform_display_name?.trim() || row.platform_username?.trim() || null;
  return normalizeConnectedAccount({
    contractVersion: PROVIDER_INTEGRATION_CONTRACT_VERSION,
    accountId: await deriveAccountId("platform-credential", row.id),
    providerId: row.platform,
    mode: "cloud",
    status,
    displayName,
    capabilities: scopeCapabilities(row.platform, row.scopes, status),
    lastUsedAt: isoOrNull(row.last_used_at),
  });
}

function vendorConnectionStatus(row: VendorConnectionRow, now: Date): ConnectedAccountStatus {
  if (row.deleted_at !== null) {
    return "revoked";
  }
  const expired = row.expires_at !== null && row.expires_at.getTime() <= now.getTime();
  if (expired && !row.hasRefreshToken) {
    return "reauth_required";
  }
  return "connected";
}

async function projectVendorConnection(
  row: VendorConnectionRow,
  now: Date,
): Promise<ConnectedAccount> {
  const status = vendorConnectionStatus(row, now);
  return normalizeConnectedAccount({
    contractVersion: PROVIDER_INTEGRATION_CONTRACT_VERSION,
    accountId: await deriveAccountId("vendor-connection", row.id),
    providerId: row.vendor,
    mode: "cloud",
    status,
    displayName: row.label?.trim() || null,
    capabilities: scopeCapabilities(row.vendor, row.scopes, status),
    lastUsedAt: null,
  });
}

function discordConnectionStatus(row: DiscordConnectionRow): ConnectedAccountStatus {
  if (!row.is_active) {
    return "disabled";
  }
  switch (row.status) {
    case "connected":
      return "connected";
    case "error":
      return "error";
    case "disconnected":
      return "disabled";
    default:
      return "unavailable";
  }
}

async function projectDiscordConnection(row: DiscordConnectionRow): Promise<ConnectedAccount> {
  const status = discordConnectionStatus(row);
  const capabilityStatus = unavailableCodeFor(status);
  return normalizeConnectedAccount({
    contractVersion: PROVIDER_INTEGRATION_CONTRACT_VERSION,
    accountId: await deriveAccountId("discord-connection", row.id),
    providerId: "discord",
    mode: "connector",
    status,
    displayName: null,
    capabilities: [
      {
        capabilityId: "discord/messaging",
        riskLevel: "R2",
        status: capabilityStatus,
      },
    ],
    lastUsedAt: isoOrNull(row.last_heartbeat),
  });
}

/**
 * Phone gateway devices carry native permission state as capability booleans;
 * a permission the device has not granted is projected as an `unsupported`
 * capability rather than omitted, so the API reflects what the device cannot
 * do instead of hiding it.
 */
async function projectPhoneGatewayDevice(row: PhoneGatewayDeviceRow): Promise<ConnectedAccount> {
  const status: ConnectedAccountStatus = row.is_active ? "connected" : "disabled";
  const grantedStatus = unavailableCodeFor(status);
  const permission = (
    capabilityId: string,
    granted: boolean,
    riskLevel: CapabilityRiskLevel,
  ): ConnectedAccountCapability => ({
    capabilityId,
    riskLevel,
    status: granted ? grantedStatus : "unsupported",
  });
  return normalizeConnectedAccount({
    contractVersion: PROVIDER_INTEGRATION_CONTRACT_VERSION,
    accountId: await deriveAccountId("phone-gateway-device", row.id),
    providerId: "phone-gateway",
    mode: "native",
    status,
    displayName: row.friendly_name?.trim() || row.phone_account_label?.trim() || null,
    capabilities: [
      permission("phone-gateway/sms.send", row.can_send_sms, "R2"),
      permission("phone-gateway/sms.receive", row.can_receive_sms, "R1"),
      permission("phone-gateway/imessage.send", row.can_send_imessage, "R2"),
      permission("phone-gateway/imessage.receive", row.can_receive_imessage, "R1"),
    ],
    lastUsedAt: isoOrNull(row.last_seen_at),
  });
}

/**
 * Project one organization's connection rows into contract-normalized
 * `ConnectedAccount` DTOs, deterministically ordered by provider then account
 * handle. Soft-deleted OAuth credentials are excluded entirely; soft-deleted
 * vendor connections surface as `revoked` until their row is purged.
 */
export async function projectConnectedAccounts(
  rows: ConnectedCapabilitySourceRows,
  now: Date,
): Promise<ConnectedAccount[]> {
  const accounts = await Promise.all([
    ...rows.platformCredentials
      .filter((row) => row.deleted_at === null)
      .map((row) => projectPlatformCredential(row)),
    ...rows.vendorConnections.map((row) => projectVendorConnection(row, now)),
    ...rows.discordConnections.map((row) => projectDiscordConnection(row)),
    ...rows.phoneGatewayDevices
      .filter((row) => !row.isRetiredBlueBubbles)
      .map((row) => projectPhoneGatewayDevice(row)),
  ]);
  return accounts.sort(
    (a, b) => a.providerId.localeCompare(b.providerId) || a.accountId.localeCompare(b.accountId),
  );
}
