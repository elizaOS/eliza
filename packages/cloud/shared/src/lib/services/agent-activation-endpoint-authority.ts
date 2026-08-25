/** Canonical validation and hashing for one dedicated-sandbox activation endpoint. */

import { createHash } from "node:crypto";
import type { AgentActivationEndpointEnvelopeV1 } from "../../db/schemas/agent-sandboxes";

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_ENDPOINT_URL_BYTES = 4096;
const ENDPOINT_KEYS = [
  "version",
  "generation",
  "kind",
  "serverName",
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
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    !/^https?:\/\//.test(value) ||
    new TextEncoder().encode(value).byteLength > MAX_ENDPOINT_URL_BYTES ||
    /[\s\u0000-\u001f\u007f-\u009f\\?#]/u.test(value)
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
