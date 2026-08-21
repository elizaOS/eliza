/**
 * Shared capability presentation vocabulary for the Connections and
 * Permissions surfaces (#19884). Both surfaces render connection/permission
 * state through the same tone union and capability-chip model so a granted
 * Gmail scope and a granted microphone permission read identically.
 *
 * The connector-side inputs are untrusted wire metadata: granted capability
 * ids ride inside `ConnectorAccountRecord.metadata` until the shared
 * capability projection API (#19883) lands, so extraction here sanitizes and
 * keeps "the server did not report access" (`reported: false`) explicitly
 * distinct from "the server reported an empty grant set". Consumers must not
 * collapse the unreported state into a healthy-looking empty list.
 */

import type { ConnectorOAuthCapabilityDeclaration } from "@elizaos/shared/connector-account-catalog";
import type {
  ConnectorAccountRecord,
  ConnectorAccountStatus,
} from "../../api/client-agent-connector-accounts";

/**
 * The one badge/chip tone vocabulary shared by connection cards and the
 * Permissions settings badges (`PERMISSION_BADGE_LABELS`). Matches the
 * `StatusBadge` tone union so both surfaces render through the same primitive.
 */
export type CapabilityTone = "success" | "warning" | "danger" | "muted";

/** Granted-capability read result. `reported: false` means the server sent no
 * grant information at all — render it as a visibly distinct state. */
export type ConnectorCapabilityAccess =
  | { reported: true; granted: ReadonlySet<string> }
  | { reported: false };

/** One capability chip: a declared least-privilege choice and whether this
 * account currently holds it. `action: "grant"` marks the incremental-scope
 * affordance for a missing capability. */
export interface CapabilityChipModel {
  id: string;
  label: string;
  description: string;
  state: "granted" | "missing";
  action: "grant" | null;
}

/** Unified account status presentation: tone plus whether the account needs a
 * reconnect (reauth) affordance rather than a plain retry. */
export interface ConnectorAccountStatusPresentation {
  tone: CapabilityTone;
  needsReconnect: boolean;
}

/** Metadata keys that historically carry granted capability/scope ids. The
 * first key present wins so a provider that reports both granted and requested
 * sets is read from its authoritative granted set. Intent-only keys such as
 * `requestedCapabilities` are deliberately excluded: they are written by this
 * client before the OAuth round trip, so a denied or partially granted consent
 * must read as unreported, never as granted. */
const GRANTED_CAPABILITY_METADATA_KEYS = [
  "grantedCapabilities",
  "grantedScopes",
  "capabilities",
  "scopes",
] as const;

function sanitizeCapabilityIds(value: unknown): ReadonlySet<string> | null {
  if (!Array.isArray(value)) return null;
  const ids = new Set<string>();
  for (const item of value) {
    if (typeof item === "string") {
      const trimmed = item.trim();
      if (trimmed && trimmed.length <= 120) ids.add(trimmed);
    }
  }
  return ids;
}

/**
 * Reads the granted capability ids from an account record's wire metadata.
 * Malformed values (non-arrays, non-string members) are dropped by
 * sanitization; a record whose metadata carries none of the known keys is
 * explicitly `reported: false`, never an empty granted set.
 */
export function readConnectorAccountCapabilityAccess(
  account: Pick<ConnectorAccountRecord, "metadata">,
): ConnectorCapabilityAccess {
  const metadata = account.metadata;
  if (!metadata || typeof metadata !== "object") return { reported: false };
  for (const key of GRANTED_CAPABILITY_METADATA_KEYS) {
    // error-policy:J3 wire metadata is untrusted — malformed entries drop to
    // an explicit unreported state instead of a fake-valid empty grant.
    const granted = sanitizeCapabilityIds(
      (metadata as Record<string, unknown>)[key],
    );
    if (granted !== null) return { reported: true, granted };
  }
  return { reported: false };
}

/**
 * Builds the chip list for one account from the provider's declared
 * least-privilege capability catalog and the account's reported access.
 * Granted-but-undeclared ids are included as plain granted chips so a scope
 * the catalog no longer declares stays visible instead of silently vanishing.
 * Returns `null` when access was never reported — the caller must render the
 * distinct "access not reported" state instead of chips.
 */
export function presentConnectorCapabilityChips(
  access: ConnectorCapabilityAccess,
  declared: readonly ConnectorOAuthCapabilityDeclaration[],
): CapabilityChipModel[] | null {
  if (!access.reported) return null;
  const chips: CapabilityChipModel[] = declared.map((capability) => {
    const granted = access.granted.has(capability.id);
    return {
      id: capability.id,
      label: capability.label,
      description: `${capability.group}: ${capability.description}`,
      state: granted ? "granted" : "missing",
      action: granted ? null : "grant",
    };
  });
  const declaredIds = new Set(declared.map((capability) => capability.id));
  for (const id of access.granted) {
    if (!declaredIds.has(id)) {
      chips.push({
        id,
        label: id,
        description: id,
        state: "granted",
        action: null,
      });
    }
  }
  return chips;
}

/** Maps the connector account status union onto the shared tone vocabulary. */
export function presentConnectorAccountStatus(
  status: ConnectorAccountStatus | undefined,
): ConnectorAccountStatusPresentation {
  switch (status) {
    case "connected":
      return { tone: "success", needsReconnect: false };
    case "pending":
      return { tone: "warning", needsReconnect: false };
    case "needs-reauth":
      return { tone: "danger", needsReconnect: true };
    case "error":
      return { tone: "danger", needsReconnect: true };
    case "disconnected":
      return { tone: "muted", needsReconnect: true };
    case "unknown":
    case undefined:
      return { tone: "muted", needsReconnect: false };
  }
}

/**
 * Computes the scope list for an incremental-scope OAuth restart: the union of
 * every currently granted capability and the newly requested one, so a grant
 * never narrows existing access. When access was never reported the request
 * fails closed to only the clicked capability — the declared catalog is a set
 * of least-privilege choices, not required scopes, so an unreported account
 * must not have one Grant click expand into the whole catalog. (The Grant
 * affordance is only rendered for reported access; this fallback guards
 * direct callers.)
 */
export function incrementalScopeRequest(
  access: ConnectorCapabilityAccess,
  requestedCapabilityId: string,
): string[] {
  const scopes = new Set<string>();
  if (access.reported) {
    for (const id of access.granted) scopes.add(id);
  }
  scopes.add(requestedCapabilityId);
  return [...scopes].sort();
}
