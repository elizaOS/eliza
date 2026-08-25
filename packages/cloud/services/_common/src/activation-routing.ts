/**
 * Atomically resolves the managed dedicated-sandbox activation route for one agent.
 *
 * The durable managed marker is the one-way cutover fence: once present, callers
 * must not consult a legacy routing source. The registration authority is durable,
 * while the activation route is a renewable TTL projection of that authority.
 */

const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SNAPSHOT_MISSING_SENTINEL = "activation-routing-missing:v1";
const SNAPSHOT_SENTINEL = "activation-routing-snapshot:v1";
const SNAPSHOT_VALUE_PREFIX = "activation-routing:v1:";

const MARKER_KEYS = ["version", "managed"] as const;
const AUTHORITY_KEYS = [
  "version",
  "state",
  "generation",
  "publicationId",
  "endpointSha256",
] as const;
const ROUTE_KEYS = [
  "version",
  "kind",
  "generation",
  "publicationId",
  "endpointSha256",
  "serverName",
] as const;

export type ActivationRoutingSnapshotKeys = readonly [
  managedMarker: string,
  registrationAuthority: string,
  activationRoute: string,
];

/**
 * Purpose-bound read-only boundary implemented by each Redis transport.
 *
 * A direct Redis adapter must execute {@link ACTIVATION_ROUTING_REDIS_EVAL_RO_SCRIPT}
 * with EVAL_RO. An `@upstash/redis` adapter must call
 * `evalRo(ACTIVATION_ROUTING_UPSTASH_READ_ONLY_SCRIPT, keys, [])`. Keeping
 * that transport choice behind this method prevents the authority reader from
 * being handed a generic, potentially mutating EVAL capability.
 */
export interface ActivationRoutingSnapshotReader {
  readActivationRoutingSnapshot(
    keys: ActivationRoutingSnapshotKeys,
  ): Promise<unknown>;
}

export interface ActivationRoutingMarkerV1 {
  readonly version: 1;
  readonly managed: true;
}

export interface ActiveRegistrationAuthorityV1 {
  readonly version: 1;
  readonly state: "active";
  readonly generation: string;
  readonly publicationId: string;
  readonly endpointSha256: string;
}

export interface TransitionRegistrationAuthorityV1 {
  readonly version: 1;
  readonly state: "transition";
  readonly generation: string;
  readonly publicationId: null;
  readonly endpointSha256: null;
}

export interface RevokedRegistrationAuthorityV1 {
  readonly version: 1;
  readonly state: "revoked";
  readonly generation: string;
  readonly publicationId: null;
  readonly endpointSha256: null;
}

export type InactiveRegistrationAuthorityV1 =
  | TransitionRegistrationAuthorityV1
  | RevokedRegistrationAuthorityV1;

export type ActivationRegistrationAuthorityV1 =
  | ActiveRegistrationAuthorityV1
  | InactiveRegistrationAuthorityV1;

export interface DedicatedSandboxActivationRouteV1 {
  readonly version: 1;
  readonly kind: "dedicated-sandbox";
  readonly generation: string;
  readonly publicationId: string;
  readonly endpointSha256: string;
  readonly serverName: string;
}

export type ActivationRoutingAuthorityUnavailableReason =
  | "invalid_agent_id"
  | "redis_unavailable"
  | "invalid_snapshot"
  | "invalid_marker"
  | "authority_missing"
  | "invalid_authority";

export type ActivationRoutingConflictReason =
  | "partial_managed_state"
  | "invalid_route"
  | "generation_mismatch"
  | "publication_mismatch"
  | "endpoint_hash_mismatch";

export type ActivationRoutingReadResult =
  | Readonly<{ status: "unmanaged" }>
  | Readonly<{
      status: "authority_unavailable";
      reason: ActivationRoutingAuthorityUnavailableReason;
    }>
  | Readonly<{
      status: "starting";
      authority:
        | ActiveRegistrationAuthorityV1
        | TransitionRegistrationAuthorityV1;
    }>
  | Readonly<{
      status: "revoked";
      authority: RevokedRegistrationAuthorityV1;
    }>
  | Readonly<{
      status: "conflict";
      reason: ActivationRoutingConflictReason;
    }>
  | Readonly<{
      status: "ready";
      authority: ActiveRegistrationAuthorityV1;
      route: DedicatedSandboxActivationRouteV1;
    }>;

const ACTIVATION_ROUTING_READ_SCRIPT_BODY = `if #KEYS ~= 3 or #ARGV ~= 0 then
  return redis.error_reply("activation-routing read requires exactly 3 keys and 0 args")
end

local function capture(key)
  local value = redis.call("GET", key)
  if value == false then
    return "${SNAPSHOT_MISSING_SENTINEL}"
  end
  return "${SNAPSHOT_VALUE_PREFIX}" .. value
end

return {
  "${SNAPSHOT_SENTINEL}",
  capture(KEYS[1]),
  capture(KEYS[2]),
  capture(KEYS[3])
}
`;

/**
 * Direct-Redis variant. Adapters must invoke this script with EVAL_RO, never
 * EVAL. It deliberately omits the Upstash-only `allow-key-locking` flag, which
 * Redis OSS does not recognize.
 */
export const ACTIVATION_ROUTING_REDIS_EVAL_RO_SCRIPT =
  ACTIVATION_ROUTING_READ_SCRIPT_BODY;

/**
 * Upstash variant. Even `evalRo` defaults to a database-wide lock, so the
 * shebang preserves read-only enforcement while opting into per-key read locks
 * for the three declared keys.
 */
export const ACTIVATION_ROUTING_UPSTASH_READ_ONLY_SCRIPT = `#!lua flags=no-writes,allow-key-locking\n${ACTIVATION_ROUTING_READ_SCRIPT_BODY}`;

type JsonObject = Record<string, unknown>;

function hasExactKeys(
  value: unknown,
  expected: readonly string[],
): value is JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const actual = Object.keys(value);
  return (
    actual.length === expected.length &&
    expected.every((key) => actual.includes(key))
  );
}

function parseJsonObject(raw: string): JsonObject | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as JsonObject)
      : null;
  } catch {
    // error-policy:J3 untrusted Redis JSON becomes an explicit invalid result.
    return null;
  }
}

function isCanonicalUuid(value: unknown): value is string {
  return typeof value === "string" && CANONICAL_UUID.test(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256.test(value);
}

function parseMarker(raw: string): ActivationRoutingMarkerV1 | null {
  const value = parseJsonObject(raw);
  if (
    !hasExactKeys(value, MARKER_KEYS) ||
    value.version !== 1 ||
    value.managed !== true
  ) {
    return null;
  }
  return Object.freeze({ version: 1, managed: true });
}

function parseAuthority(raw: string): ActivationRegistrationAuthorityV1 | null {
  const value = parseJsonObject(raw);
  if (
    !hasExactKeys(value, AUTHORITY_KEYS) ||
    value.version !== 1 ||
    !isCanonicalUuid(value.generation)
  ) {
    return null;
  }

  if (value.state === "active") {
    if (
      !isCanonicalUuid(value.publicationId) ||
      !isSha256(value.endpointSha256)
    )
      return null;
    return Object.freeze({
      version: 1,
      state: "active",
      generation: value.generation,
      publicationId: value.publicationId,
      endpointSha256: value.endpointSha256,
    });
  }

  if (
    (value.state === "transition" || value.state === "revoked") &&
    value.publicationId === null &&
    value.endpointSha256 === null
  ) {
    return Object.freeze({
      version: 1,
      state: value.state,
      generation: value.generation,
      publicationId: null,
      endpointSha256: null,
    });
  }

  return null;
}

function parseRoute(raw: string): DedicatedSandboxActivationRouteV1 | null {
  const value = parseJsonObject(raw);
  if (
    !hasExactKeys(value, ROUTE_KEYS) ||
    value.version !== 1 ||
    value.kind !== "dedicated-sandbox" ||
    !isCanonicalUuid(value.generation) ||
    !isCanonicalUuid(value.publicationId) ||
    !isSha256(value.endpointSha256) ||
    value.serverName !== `sandbox-${value.generation}`
  ) {
    return null;
  }

  return Object.freeze({
    version: 1,
    kind: "dedicated-sandbox",
    generation: value.generation,
    publicationId: value.publicationId,
    endpointSha256: value.endpointSha256,
    serverName: value.serverName,
  });
}

function parseSnapshot(
  value: unknown,
): readonly [string | null, string | null, string | null] | null {
  if (
    !Array.isArray(value) ||
    value.length !== 4 ||
    value[0] !== SNAPSHOT_SENTINEL
  ) {
    return null;
  }
  const decoded: Array<string | null> = [];
  for (const entry of value.slice(1)) {
    if (entry === SNAPSHOT_MISSING_SENTINEL) {
      decoded.push(null);
      continue;
    }
    if (typeof entry !== "string" || !entry.startsWith(SNAPSHOT_VALUE_PREFIX)) {
      return null;
    }
    decoded.push(entry.slice(SNAPSHOT_VALUE_PREFIX.length));
  }
  return decoded as [string | null, string | null, string | null];
}

function redisKeys(agentId: string): ActivationRoutingSnapshotKeys {
  return [
    `agent:${agentId}:routing-managed`,
    `agent:${agentId}:registration-authority`,
    `agent:${agentId}:activation-route`,
  ];
}

/**
 * Resolve managed activation routing without any legacy read.
 *
 * Redis transport and untrusted-value failures are returned as non-ready typed
 * states, so callers cannot accidentally route through malformed authority.
 */
export async function readActivationRoutingState(
  snapshotReader: ActivationRoutingSnapshotReader,
  agentId: string,
): Promise<ActivationRoutingReadResult> {
  if (!isCanonicalUuid(agentId)) {
    return Object.freeze({
      status: "authority_unavailable",
      reason: "invalid_agent_id",
    });
  }

  let evaluated: unknown;
  try {
    evaluated = await snapshotReader.readActivationRoutingSnapshot(
      redisKeys(agentId),
    );
  } catch {
    // error-policy:J4 Redis failure becomes an explicit authority-unavailable state.
    return Object.freeze({
      status: "authority_unavailable",
      reason: "redis_unavailable",
    });
  }

  const snapshot = parseSnapshot(evaluated);
  if (!snapshot) {
    return Object.freeze({
      status: "authority_unavailable",
      reason: "invalid_snapshot",
    });
  }

  const [rawMarker, rawAuthority, rawRoute] = snapshot;
  if (rawMarker === null) {
    if (rawAuthority === null && rawRoute === null) {
      return Object.freeze({ status: "unmanaged" });
    }
    return Object.freeze({
      status: "conflict",
      reason: "partial_managed_state",
    });
  }

  const marker = parseMarker(rawMarker);
  if (!marker) {
    return Object.freeze({
      status: "authority_unavailable",
      reason: "invalid_marker",
    });
  }

  if (rawAuthority === null) {
    return Object.freeze({
      status: "authority_unavailable",
      reason: "authority_missing",
    });
  }

  const authority = parseAuthority(rawAuthority);
  if (!authority) {
    return Object.freeze({
      status: "authority_unavailable",
      reason: "invalid_authority",
    });
  }

  // Parse every present projection in JS as a second trust boundary. A durable
  // transition or tombstone still dominates any stale TTL route.
  const route = rawRoute === null ? null : parseRoute(rawRoute);
  if (authority.state === "revoked") {
    return Object.freeze({ status: "revoked", authority });
  }
  if (authority.state === "transition") {
    return Object.freeze({ status: "starting", authority });
  }

  if (rawRoute === null) {
    return Object.freeze({ status: "starting", authority });
  }
  if (!route) {
    return Object.freeze({ status: "conflict", reason: "invalid_route" });
  }
  if (route.generation !== authority.generation) {
    return Object.freeze({ status: "conflict", reason: "generation_mismatch" });
  }
  if (route.publicationId !== authority.publicationId) {
    return Object.freeze({
      status: "conflict",
      reason: "publication_mismatch",
    });
  }
  if (route.endpointSha256 !== authority.endpointSha256) {
    return Object.freeze({
      status: "conflict",
      reason: "endpoint_hash_mismatch",
    });
  }

  return Object.freeze({ status: "ready", authority, route });
}
