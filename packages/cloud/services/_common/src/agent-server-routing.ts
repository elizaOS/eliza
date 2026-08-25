/** Resolves managed and legacy agent-server routes without crossing the cutover fence. */

import {
  type ActivationRoutingAuthorityUnavailableReason,
  type ActivationRoutingConflictReason,
  type ActivationRoutingSnapshotReader,
  readActivationRoutingState,
} from "./activation-routing";

const UUID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const LEGACY_SERVER_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
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
  | "invalid_server_url";

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
        reason: "heartbeat_unavailable" | "invalid_server_url";
        mode: AgentServerRoutingMode;
        serverName: string;
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

  return Object.freeze({
    ...identity,
    kind: "ready",
    mode,
    serverName,
    serverUrl,
  });
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
    case "ready":
      return resolveHeartbeat(
        reader,
        identity,
        "managed",
        managed.route.serverName,
      );
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
      return Object.freeze({
        ...identity,
        kind: "routing_unavailable",
        reason: "managed_authority_unavailable",
        authorityReason: managed.reason,
      });
    case "unmanaged":
      break;
  }

  let legacyServerName: unknown;
  try {
    legacyServerName = await reader.readAgentServerRoutingValue(
      `agent:${runtimeAgentId}:server`,
    );
  } catch {
    // error-policy:J4 Redis failure is an explicit non-routable result.
    return Object.freeze({
      ...identity,
      kind: "routing_unavailable",
      reason: "legacy_pointer_unavailable",
      mode: "legacy",
    });
  }

  if (legacyServerName === null) {
    return Object.freeze({
      ...identity,
      kind: "unregistered",
      mode: "legacy",
      reason: "legacy_pointer_missing",
    });
  }
  if (!isLegacyServerName(legacyServerName)) {
    return Object.freeze({
      ...identity,
      kind: "routing_unavailable",
      reason: "invalid_legacy_pointer",
      mode: "legacy",
    });
  }

  return resolveHeartbeat(reader, identity, "legacy", legacyServerName);
}
