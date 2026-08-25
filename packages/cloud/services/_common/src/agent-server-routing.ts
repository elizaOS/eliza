/** Resolves managed and legacy agent-server routes without crossing the cutover fence. */

import {
  type ActivationRoutingAuthorityUnavailableReason,
  type ActivationRoutingConflictReason,
  type ActivationRoutingReadResult,
  type ActivationRoutingSnapshotReader,
  readActivationRoutingState,
} from "./activation-routing";

const UUID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const LEGACY_SERVER_NAME = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/;
const MAX_SERVER_URL_BYTES = 4096;

export type AgentServerRoutingMode = "managed" | "legacy";

export interface AgentServerRoutingIdentity {
  readonly managedAgentId: string;
  readonly runtimeAgentId: string;
}

export interface AgentServerRoutingReader
  extends ActivationRoutingSnapshotReader {
  /**
   * Return the raw Redis GET reply without JSON auto-deserialization.
   *
   * The distinction between a missing key (`null`) and the literal stored value
   * `"null"` is security-relevant: only the former may mean unregistered or
   * unreachable. Transports that normally auto-deserialize GET replies must
   * expose the raw transport value or an equivalent presence envelope here.
   */
  readAgentServerRoutingValue(key: string): Promise<unknown>;
}

export type ManagedAgentNotReadyReason = "starting" | "revoked" | "conflict";

export type AgentServerRoutingUnavailableReason =
  | "invalid_managed_agent_id"
  | "invalid_runtime_agent_id"
  | "managed_authority_unavailable"
  | "legacy_pointer_unavailable"
  | "invalid_legacy_pointer"
  | "heartbeat_unavailable"
  | "invalid_server_url"
  | "managed_endpoint_mismatch"
  | "routing_state_changed";

type ManagedAgentNotReadyResult =
  | Readonly<
      AgentServerRoutingIdentity & {
        kind: "managed_not_ready";
        mode: "managed";
        reason: "starting" | "revoked";
      }
    >
  | Readonly<
      AgentServerRoutingIdentity & {
        kind: "managed_not_ready";
        mode: "managed";
        reason: "conflict";
        conflictReason: ActivationRoutingConflictReason;
      }
    >;

export type AgentServerRoutingResult =
  | Readonly<
      AgentServerRoutingIdentity & {
        kind: "ready";
        mode: AgentServerRoutingMode;
        serverName: string;
        serverUrl: string;
      }
    >
  | Readonly<
      AgentServerRoutingIdentity & {
        kind: "unregistered";
        mode: "legacy";
        reason: "legacy_pointer_missing";
      }
    >
  | Readonly<
      AgentServerRoutingIdentity & {
        kind: "unreachable";
        mode: AgentServerRoutingMode;
        reason: "heartbeat_missing";
        serverName: string;
      }
    >
  | ManagedAgentNotReadyResult
  | Readonly<{
      kind: "routing_unavailable";
      reason: "invalid_managed_agent_id" | "invalid_runtime_agent_id";
    }>
  | Readonly<
      AgentServerRoutingIdentity & {
        kind: "routing_unavailable";
        reason: "managed_authority_unavailable";
        authorityReason: ActivationRoutingAuthorityUnavailableReason;
      }
    >
  | Readonly<
      AgentServerRoutingIdentity & {
        kind: "routing_unavailable";
        reason: "legacy_pointer_unavailable" | "invalid_legacy_pointer";
        mode: "legacy";
      }
    >
  | Readonly<
      AgentServerRoutingIdentity & {
        kind: "routing_unavailable";
        reason:
          | "heartbeat_unavailable"
          | "invalid_server_url"
          | "managed_endpoint_mismatch";
        mode: AgentServerRoutingMode;
        serverName: string;
      }
    >
  | Readonly<
      AgentServerRoutingIdentity & {
        kind: "routing_unavailable";
        reason: "routing_state_changed";
      }
    >;

function parseCanonicalUuid(value: unknown): string | null {
  return typeof value === "string" && UUID_SHAPE.test(value) ? value : null;
}

function isLegacyServerName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value !== "null" &&
    LEGACY_SERVER_NAME.test(value)
  );
}

function isCanonicalHttpServerUrl(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_SERVER_URL_BYTES ||
    value !== value.trim() ||
    !/^https?:\/\//u.test(value) ||
    new TextEncoder().encode(value).byteLength > MAX_SERVER_URL_BYTES
  ) {
    return false;
  }

  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      /[\s\\?#]/u.test(character) ||
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f)
    ) {
      return false;
    }
  }

  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.hostname.length > 0 &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.search === "" &&
      parsed.hash === ""
    );
  } catch {
    return false;
  }
}

async function resolveHeartbeat(
  reader: AgentServerRoutingReader,
  identity: Readonly<AgentServerRoutingIdentity>,
  mode: AgentServerRoutingMode,
  serverName: string,
  expectedServerUrl?: string,
): Promise<AgentServerRoutingResult> {
  let serverUrl: unknown;
  try {
    serverUrl = await reader.readAgentServerRoutingValue(
      `server:${serverName}:url`,
    );
  } catch {
    // error-policy:J4 Redis failure is an explicit non-routable result.
    return Object.freeze({
      ...identity,
      kind: "routing_unavailable",
      reason: "heartbeat_unavailable",
      mode,
      serverName,
    });
  }

  if (serverUrl === null) {
    return Object.freeze({
      ...identity,
      kind: "unreachable",
      mode,
      reason: "heartbeat_missing",
      serverName,
    });
  }
  if (!isCanonicalHttpServerUrl(serverUrl)) {
    return Object.freeze({
      ...identity,
      kind: "routing_unavailable",
      reason: "invalid_server_url",
      mode,
      serverName,
    });
  }
  if (expectedServerUrl !== undefined && serverUrl !== expectedServerUrl) {
    return Object.freeze({
      ...identity,
      kind: "routing_unavailable",
      reason: "managed_endpoint_mismatch",
      mode,
      serverName,
    });
  }

  return Object.freeze({
    ...identity,
    kind: "ready",
    mode,
    serverName,
    serverUrl,
  });
}

type ManagedReadyState = Extract<
  ActivationRoutingReadResult,
  { status: "ready" }
>;

function managedReadyStatesEqual(
  left: ManagedReadyState,
  right: ManagedReadyState,
): boolean {
  return (
    left.authority.generation === right.authority.generation &&
    left.authority.publicationId === right.authority.publicationId &&
    left.authority.endpointSha256 === right.authority.endpointSha256 &&
    left.route.generation === right.route.generation &&
    left.route.publicationId === right.route.publicationId &&
    left.route.endpointSha256 === right.route.endpointSha256 &&
    left.route.endpoint.generation === right.route.endpoint.generation &&
    left.route.endpoint.serverName === right.route.endpoint.serverName &&
    left.route.endpoint.runtimeAgentId ===
      right.route.endpoint.runtimeAgentId &&
    left.route.endpoint.registryUrl === right.route.endpoint.registryUrl &&
    left.route.endpoint.bridgeUrl === right.route.endpoint.bridgeUrl &&
    left.route.endpoint.healthUrl === right.route.endpoint.healthUrl
  );
}

function routingStateChanged(
  identity: Readonly<AgentServerRoutingIdentity>,
): AgentServerRoutingResult {
  return Object.freeze({
    ...identity,
    kind: "routing_unavailable",
    reason: "routing_state_changed",
  });
}

function managedAuthorityUnavailable(
  identity: Readonly<AgentServerRoutingIdentity>,
  authorityReason: ActivationRoutingAuthorityUnavailableReason,
): AgentServerRoutingResult {
  return Object.freeze({
    ...identity,
    kind: "routing_unavailable",
    reason: "managed_authority_unavailable",
    authorityReason,
  });
}

async function confirmManagedCandidate(
  reader: AgentServerRoutingReader,
  identity: Readonly<AgentServerRoutingIdentity>,
  initial: ManagedReadyState,
  candidate: AgentServerRoutingResult,
): Promise<AgentServerRoutingResult> {
  const confirmed = await readActivationRoutingState(
    reader,
    identity.managedAgentId,
  );
  if (confirmed.status === "authority_unavailable") {
    return managedAuthorityUnavailable(identity, confirmed.reason);
  }
  if (
    confirmed.status !== "ready" ||
    !managedReadyStatesEqual(initial, confirmed)
  ) {
    return routingStateChanged(identity);
  }
  return candidate;
}

async function confirmLegacyCandidate(
  reader: AgentServerRoutingReader,
  identity: Readonly<AgentServerRoutingIdentity>,
  candidate: AgentServerRoutingResult,
  pointerKey: string,
  expectedPointer?: string | null,
): Promise<AgentServerRoutingResult> {
  let pointerStable = true;
  let pointerAvailable = true;
  if (expectedPointer !== undefined) {
    try {
      pointerStable =
        (await reader.readAgentServerRoutingValue(pointerKey)) ===
        expectedPointer;
    } catch {
      pointerAvailable = false;
    }
  }

  // This second managed snapshot is the linearization point. A legacy result
  // is usable only if the durable cutover fence is still wholly absent after
  // all pointer and heartbeat reads.
  const confirmed = await readActivationRoutingState(
    reader,
    identity.managedAgentId,
  );
  if (confirmed.status === "authority_unavailable") {
    return managedAuthorityUnavailable(identity, confirmed.reason);
  }
  if (confirmed.status !== "unmanaged" || !pointerStable) {
    return routingStateChanged(identity);
  }
  if (!pointerAvailable) {
    return Object.freeze({
      ...identity,
      kind: "routing_unavailable",
      reason: "legacy_pointer_unavailable",
      mode: "legacy",
    });
  }
  return candidate;
}

/**
 * Resolve the exact managed route, or the legacy route only while no durable
 * managed marker exists.
 *
 * Both identities are validated as canonical lowercase UUIDs before Redis is
 * touched.
 * Managed activation states other than `unmanaged` therefore form a strict
 * one-way fence: none can read `agent:<runtimeAgentId>:server`.
 */
export async function resolveAgentServerRouting(
  reader: AgentServerRoutingReader,
  input: Readonly<AgentServerRoutingIdentity>,
): Promise<AgentServerRoutingResult> {
  const managedAgentId = parseCanonicalUuid(input.managedAgentId);
  const runtimeAgentId = parseCanonicalUuid(input.runtimeAgentId);
  if (!managedAgentId) {
    return Object.freeze({
      kind: "routing_unavailable",
      reason: "invalid_managed_agent_id",
    });
  }
  if (!runtimeAgentId) {
    return Object.freeze({
      kind: "routing_unavailable",
      reason: "invalid_runtime_agent_id",
    });
  }

  const identity = Object.freeze({ managedAgentId, runtimeAgentId });
  const managed = await readActivationRoutingState(reader, managedAgentId);

  switch (managed.status) {
    case "ready": {
      if (managed.route.endpoint.runtimeAgentId !== runtimeAgentId) {
        return Object.freeze({
          ...identity,
          kind: "routing_unavailable",
          reason: "managed_endpoint_mismatch",
          mode: "managed",
          serverName: managed.route.endpoint.serverName,
        });
      }
      const candidate = await resolveHeartbeat(
        reader,
        identity,
        "managed",
        managed.route.endpoint.serverName,
        managed.route.endpoint.registryUrl,
      );
      // Re-read the exact managed snapshot after the non-atomic heartbeat GET.
      // A revoke or republish between the two reads must never yield a route.
      return confirmManagedCandidate(reader, identity, managed, candidate);
    }
    case "starting":
      return Object.freeze({
        ...identity,
        kind: "managed_not_ready",
        mode: "managed",
        reason: "starting",
      });
    case "revoked":
      return Object.freeze({
        ...identity,
        kind: "managed_not_ready",
        mode: "managed",
        reason: "revoked",
      });
    case "conflict":
      return Object.freeze({
        ...identity,
        kind: "managed_not_ready",
        mode: "managed",
        reason: "conflict",
        conflictReason: managed.reason,
      });
    case "authority_unavailable":
      return managedAuthorityUnavailable(identity, managed.reason);
    case "unmanaged":
      break;
  }

  const legacyPointerKey = `agent:${runtimeAgentId}:server`;
  let legacyServerName: unknown;
  try {
    legacyServerName =
      await reader.readAgentServerRoutingValue(legacyPointerKey);
  } catch {
    // error-policy:J4 Redis failure is an explicit non-routable result.
    return confirmLegacyCandidate(
      reader,
      identity,
      Object.freeze({
        ...identity,
        kind: "routing_unavailable",
        reason: "legacy_pointer_unavailable",
        mode: "legacy",
      }),
      legacyPointerKey,
    );
  }

  if (legacyServerName === null) {
    return confirmLegacyCandidate(
      reader,
      identity,
      Object.freeze({
        ...identity,
        kind: "unregistered",
        mode: "legacy",
        reason: "legacy_pointer_missing",
      }),
      legacyPointerKey,
      null,
    );
  }
  if (!isLegacyServerName(legacyServerName)) {
    return confirmLegacyCandidate(
      reader,
      identity,
      Object.freeze({
        ...identity,
        kind: "routing_unavailable",
        reason: "invalid_legacy_pointer",
        mode: "legacy",
      }),
      legacyPointerKey,
    );
  }

  const candidate = await resolveHeartbeat(
    reader,
    identity,
    "legacy",
    legacyServerName,
  );
  return confirmLegacyCandidate(
    reader,
    identity,
    candidate,
    legacyPointerKey,
    legacyServerName,
  );
}
