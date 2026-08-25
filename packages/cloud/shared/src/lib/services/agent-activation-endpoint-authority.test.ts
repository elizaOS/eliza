/** Exact-shape and content-addressing proofs for activation endpoint authority. */

import { describe, expect, test } from "bun:test";
import {
  canonicalAgentActivationEndpointEnvelopeJson,
  hashAgentActivationEndpointEnvelope,
  parseAgentActivationEndpointAuthority,
  parseAgentActivationEndpointEnvelopeV1,
} from "./agent-activation-endpoint-authority";

const GENERATION = "00000000-0000-4000-8000-000000000101";
const RUNTIME_AGENT_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1";
const ENDPOINT = Object.freeze({
  version: 1,
  generation: GENERATION,
  kind: "dedicated-sandbox",
  serverName: `sandbox-${GENERATION}`,
  runtimeAgentId: RUNTIME_AGENT_ID,
  registryUrl: "https://sandbox.example.test/api",
  bridgeUrl: "http://100.64.0.101:3000",
  healthUrl: "http://100.64.0.101:3000/health",
} as const);

describe("agent activation endpoint authority", () => {
  test("parses and hashes one exact generation-bound envelope", () => {
    const sha256 = hashAgentActivationEndpointEnvelope(ENDPOINT);
    expect(parseAgentActivationEndpointAuthority(ENDPOINT, sha256, GENERATION)).toEqual(ENDPOINT);
    expect(sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(canonicalAgentActivationEndpointEnvelopeJson(ENDPOINT)).toBe(JSON.stringify(ENDPOINT));
  });

  test("canonicalizes independently of incoming property order", () => {
    const reordered = {
      healthUrl: ENDPOINT.healthUrl,
      bridgeUrl: ENDPOINT.bridgeUrl,
      registryUrl: ENDPOINT.registryUrl,
      runtimeAgentId: ENDPOINT.runtimeAgentId,
      serverName: ENDPOINT.serverName,
      kind: ENDPOINT.kind,
      generation: ENDPOINT.generation,
      version: ENDPOINT.version,
    };
    const parsed = parseAgentActivationEndpointEnvelopeV1(reordered, GENERATION);
    expect(parsed).not.toBeNull();
    expect(parsed && hashAgentActivationEndpointEnvelope(parsed)).toBe(
      hashAgentActivationEndpointEnvelope(ENDPOINT),
    );
  });

  test.each([
    [{ ...ENDPOINT, extra: true }, "extra field"],
    [{ ...ENDPOINT, generation: "00000000-0000-4000-8000-000000000102" }, "generation"],
    [{ ...ENDPOINT, serverName: "sandbox-stale" }, "server name"],
    [{ ...ENDPOINT, runtimeAgentId: RUNTIME_AGENT_ID.toUpperCase() }, "runtime identity case"],
    [{ ...ENDPOINT, runtimeAgentId: "not-a-uuid" }, "runtime identity shape"],
    [{ ...ENDPOINT, registryUrl: "redis://cache.internal" }, "non-http URL"],
    [{ ...ENDPOINT, registryUrl: "HTTPS://sandbox.example.test" }, "non-canonical scheme"],
    [{ ...ENDPOINT, registryUrl: "https://user:secret@sandbox.example.test" }, "credentials"],
    [{ ...ENDPOINT, registryUrl: "http://:80/path" }, "empty hostname"],
    [{ ...ENDPOINT, registryUrl: "http://host:99999/path" }, "out-of-range port"],
    [{ ...ENDPOINT, registryUrl: "http://999.999/path" }, "invalid numeric hostname"],
    [{ ...ENDPOINT, bridgeUrl: "https://sandbox.example.test/?token=secret" }, "query"],
    [{ ...ENDPOINT, bridgeUrl: "https://sandbox.example.test/?" }, "empty query delimiter"],
    [{ ...ENDPOINT, healthUrl: "https://sandbox.example.test/health#ready" }, "fragment"],
    [
      { ...ENDPOINT, healthUrl: "https://sandbox.example.test/health#" },
      "empty fragment delimiter",
    ],
    [
      { ...ENDPOINT, registryUrl: "https://sandbox.example.test\\@evil.test/path" },
      "backslash normalization",
    ],
    [
      { ...ENDPOINT, registryUrl: "https://sandbox.example.test\\evil/path" },
      "backslash path separator",
    ],
    [{ ...ENDPOINT, healthUrl: " https://sandbox.example.test/health" }, "whitespace"],
    [
      { ...ENDPOINT, healthUrl: "https://sandbox.example.test/health check" },
      "embedded whitespace",
    ],
    [{ ...ENDPOINT, healthUrl: "https://sandbox.example.test/a\u00a0b" }, "non-breaking space"],
    [
      { ...ENDPOINT, healthUrl: "https://sandbox.example.test/a\u202fb" },
      "narrow non-breaking space",
    ],
    [{ ...ENDPOINT, healthUrl: "https://sandbox.example.test/a\ufeffb" }, "byte-order mark"],
    [{ ...ENDPOINT, healthUrl: "https://sandbox.example.test/café" }, "non-ASCII path"],
  ])("rejects %s (%s)", (candidate) => {
    expect(parseAgentActivationEndpointEnvelopeV1(candidate, GENERATION)).toBeNull();
  });

  test("rejects a missing runtime identity, accessors, and an incorrect content digest", () => {
    const missingRuntime = { ...ENDPOINT } as Record<string, unknown>;
    delete missingRuntime.runtimeAgentId;
    expect(parseAgentActivationEndpointEnvelopeV1(missingRuntime, GENERATION)).toBeNull();

    let reads = 0;
    const accessor = { ...ENDPOINT } as Record<string, unknown>;
    Object.defineProperty(accessor, "runtimeAgentId", {
      enumerable: true,
      get() {
        reads += 1;
        return ENDPOINT.runtimeAgentId;
      },
    });
    expect(parseAgentActivationEndpointEnvelopeV1(accessor, GENERATION)).toBeNull();
    expect(reads).toBe(0);
    expect(parseAgentActivationEndpointAuthority(ENDPOINT, "a".repeat(64), GENERATION)).toBeNull();
  });

  test("content-addresses the exact runtime identity", () => {
    const otherRuntime = {
      ...ENDPOINT,
      runtimeAgentId: "00000000-0000-4000-8000-000000000103",
    } as const;
    expect(hashAgentActivationEndpointEnvelope(otherRuntime)).not.toBe(
      hashAgentActivationEndpointEnvelope(ENDPOINT),
    );
  });

  test("accepts the V1 TCP port boundaries", () => {
    for (const port of [1, 65535]) {
      const candidate = {
        ...ENDPOINT,
        bridgeUrl: `http://127.0.0.1:${port}/bridge`,
      };
      expect(parseAgentActivationEndpointEnvelopeV1(candidate, GENERATION)).not.toBeNull();
    }
  });
});
