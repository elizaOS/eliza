/** Exact-shape and content-addressing proofs for activation endpoint authority. */

import { describe, expect, test } from "bun:test";
import {
  canonicalAgentActivationEndpointEnvelopeJson,
  hashAgentActivationEndpointEnvelope,
  parseAgentActivationEndpointAuthority,
  parseAgentActivationEndpointEnvelopeV1,
} from "./agent-activation-endpoint-authority";

const GENERATION = "00000000-0000-4000-8000-000000000101";
const ENDPOINT = Object.freeze({
  version: 1,
  generation: GENERATION,
  kind: "dedicated-sandbox",
  serverName: `sandbox-${GENERATION}`,
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
    [{ ...ENDPOINT, registryUrl: "redis://cache.internal" }, "non-http URL"],
    [{ ...ENDPOINT, registryUrl: "HTTPS://sandbox.example.test" }, "non-canonical scheme"],
    [{ ...ENDPOINT, registryUrl: "https://user:secret@sandbox.example.test" }, "credentials"],
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
    [{ ...ENDPOINT, healthUrl: " https://sandbox.example.test/health" }, "whitespace"],
    [
      { ...ENDPOINT, healthUrl: "https://sandbox.example.test/health check" },
      "embedded whitespace",
    ],
  ])("rejects %s (%s)", (candidate) => {
    expect(parseAgentActivationEndpointEnvelopeV1(candidate, GENERATION)).toBeNull();
  });

  test("rejects accessors and an incorrect content digest", () => {
    let reads = 0;
    const accessor = { ...ENDPOINT } as Record<string, unknown>;
    Object.defineProperty(accessor, "healthUrl", {
      enumerable: true,
      get() {
        reads += 1;
        return ENDPOINT.healthUrl;
      },
    });
    expect(parseAgentActivationEndpointEnvelopeV1(accessor, GENERATION)).toBeNull();
    expect(reads).toBe(0);
    expect(parseAgentActivationEndpointAuthority(ENDPOINT, "a".repeat(64), GENERATION)).toBeNull();
  });
});
