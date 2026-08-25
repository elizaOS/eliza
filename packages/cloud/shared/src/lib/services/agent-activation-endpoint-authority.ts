/** Canonical validation and hashing for one dedicated-sandbox activation endpoint. */

import { createHash } from "node:crypto";
import type { AgentActivationEndpointEnvelopeV1 } from "../../db/schemas/agent-sandboxes";

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_ENDPOINT_URL_BYTES = 4096;
// Deliberately narrower than the WHATWG URL grammar so the application and
// PostgreSQL CHECK constraints can enforce the exact same endpoint language.
// V1 accepts canonical ASCII DNS names or IPv4 literals and ports 1..65535.
const IPV4_OCTET = "(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])";
const IPV4_HOST = String.raw`${IPV4_OCTET}(?:\.${IPV4_OCTET}){3}`;
const DNS_LABEL = "(?:[A-Za-z0-9]|[A-Za-z0-9][A-Za-z0-9-]{0,61}[A-Za-z0-9])";
const DNS_HOST = String.raw`(?:${DNS_LABEL}\.)*[A-Za-z](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?`;
const TCP_PORT =
  "(?::(?:6553[0-5]|655[0-2][0-9]|65[0-4][0-9]{2}|6[0-4][0-9]{3}|[1-5][0-9]{4}|[1-9][0-9]{0,3}))?";
const ENDPOINT_URL_V1 = new RegExp(
  String.raw`^https?://(?:${IPV4_HOST}|${DNS_HOST})${TCP_PORT}(?:/[^\\?#\s\u0000-\u001f\u007f-\u009f]*)?$`,
);
const ENDPOINT_KEYS = [
  "version",
  "generation",
  "kind",
  "serverName",
  "runtimeAgentId",
  "registryUrl",
  "bridgeUrl",
  "healthUrl",
] as const;

type EndpointKey = (typeof ENDPOINT_KEYS)[number];

function readExactDataProperties(value: unknown): Record<EndpointKey, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;

  try {
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== ENDPOINT_KEYS.length ||
      keys.some((key) => typeof key !== "string" || !ENDPOINT_KEYS.includes(key as EndpointKey))
    ) {
      return null;
    }

    const snapshot = {} as Record<EndpointKey, unknown>;
    for (const key of ENDPOINT_KEYS) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) return null;
      snapshot[key] = descriptor.value;
    }
    return snapshot;
  } catch {
    // error-policy:J3 an untrusted object that cannot be inspected is invalid authority.
    return null;
  }
}

function isBoundedHttpEndpoint(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const encodedLength = new TextEncoder().encode(value).byteLength;
  if (
    value.length === 0 ||
    value !== value.trim() ||
    !/^https?:\/\//.test(value) ||
    encodedLength !== value.length ||
    encodedLength > MAX_ENDPOINT_URL_BYTES ||
    !ENDPOINT_URL_V1.test(value)
  ) {
    return false;
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

/** Parse one exact V1 envelope without invoking accessors or accepting extra fields. */
export function parseAgentActivationEndpointEnvelopeV1(
  value: unknown,
  expectedGeneration: string,
): Readonly<AgentActivationEndpointEnvelopeV1> | null {
  if (!CANONICAL_UUID.test(expectedGeneration)) return null;
  const endpoint = readExactDataProperties(value);
  if (
    !endpoint ||
    endpoint.version !== 1 ||
    endpoint.generation !== expectedGeneration ||
    endpoint.kind !== "dedicated-sandbox" ||
    endpoint.serverName !== `sandbox-${expectedGeneration}` ||
    typeof endpoint.runtimeAgentId !== "string" ||
    !CANONICAL_UUID.test(endpoint.runtimeAgentId) ||
    !isBoundedHttpEndpoint(endpoint.registryUrl) ||
    !isBoundedHttpEndpoint(endpoint.bridgeUrl) ||
    !isBoundedHttpEndpoint(endpoint.healthUrl)
  ) {
    return null;
  }

  return Object.freeze({
    version: 1,
    generation: expectedGeneration,
    kind: "dedicated-sandbox",
    serverName: endpoint.serverName,
    runtimeAgentId: endpoint.runtimeAgentId,
    registryUrl: endpoint.registryUrl,
    bridgeUrl: endpoint.bridgeUrl,
    healthUrl: endpoint.healthUrl,
  });
}

/** Fixed property order is the V1 canonical JSON representation used by every writer. */
export function canonicalAgentActivationEndpointEnvelopeJson(
  endpoint: Readonly<AgentActivationEndpointEnvelopeV1>,
): string {
  return JSON.stringify({
    version: 1,
    generation: endpoint.generation,
    kind: "dedicated-sandbox",
    serverName: endpoint.serverName,
    runtimeAgentId: endpoint.runtimeAgentId,
    registryUrl: endpoint.registryUrl,
    bridgeUrl: endpoint.bridgeUrl,
    healthUrl: endpoint.healthUrl,
  });
}

export function hashAgentActivationEndpointEnvelope(
  endpoint: Readonly<AgentActivationEndpointEnvelopeV1>,
): string {
  return createHash("sha256")
    .update(canonicalAgentActivationEndpointEnvelopeJson(endpoint), "utf8")
    .digest("hex");
}

/** Validate both halves of the persisted content-addressed endpoint authority. */
export function parseAgentActivationEndpointAuthority(
  endpoint: unknown,
  sha256: unknown,
  expectedGeneration: string,
): Readonly<AgentActivationEndpointEnvelopeV1> | null {
  if (typeof sha256 !== "string" || !SHA256.test(sha256)) return null;
  const parsed = parseAgentActivationEndpointEnvelopeV1(endpoint, expectedGeneration);
  if (!parsed || hashAgentActivationEndpointEnvelope(parsed) !== sha256) return null;
  return parsed;
}

export function agentActivationEndpointEnvelopesEqual(
  left: Readonly<AgentActivationEndpointEnvelopeV1>,
  right: Readonly<AgentActivationEndpointEnvelopeV1>,
): boolean {
  return (
    canonicalAgentActivationEndpointEnvelopeJson(left) ===
    canonicalAgentActivationEndpointEnvelopeJson(right)
  );
}
