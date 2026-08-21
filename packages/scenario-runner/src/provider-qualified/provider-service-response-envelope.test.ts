/**
 * Exercises the provider-service response envelope with real Ed25519 keys and
 * adversarial substitutions across requests, roles, endpoints, identities,
 * results, signatures, and freshness windows.
 */

import { generateKeyPairSync, sign as signBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  type ProviderServiceResponsePin,
  providerServiceIdentitySha256,
  signProviderServiceResponse,
  verifyProviderServiceResponse,
} from "./provider-service-response-envelope.ts";
import { providerObserverKeyId } from "./qualification.ts";

const REQUESTED_AT = "2026-08-20T10:00:00.000Z";
const RESPONDED_AT = "2026-08-20T10:00:01.000Z";
const COMPLETED_AT = "2026-08-20T10:00:02.000Z";
const EXPIRES_AT = "2026-08-20T10:01:00.000Z";
const REQUEST_NONCE = "A".repeat(43);
const REQUEST_SHA256 = "1".repeat(64);

function fixture() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey
    .export({ type: "spki", format: "pem" })
    .toString();
  const keyId = providerObserverKeyId(publicKeyPem);
  const identity = {
    endpoint: "https://controller.example.test/provider-canary/v1/service",
    organizationId: "operator-org",
    administrativeDomain: "controller-domain",
    keyId,
  };
  const pin: ProviderServiceResponsePin = {
    ...identity,
    publicKeyPem,
    serviceIdentitySha256: providerServiceIdentitySha256(identity),
  };
  const signer = {
    keyId,
    publicKeyPem,
    async sign(input: { bytes: Uint8Array }) {
      return signBytes(null, input.bytes, privateKey).toString("base64url");
    },
  };
  return { pin, signer };
}

async function signedFixture() {
  const { pin, signer } = fixture();
  const envelope = await signProviderServiceResponse({
    pin,
    signer,
    role: "controller-execute",
    requestNonce: REQUEST_NONCE,
    requestSha256: REQUEST_SHA256,
    respondedAtIso: RESPONDED_AT,
    expiresAtIso: EXPIRES_AT,
    result: { providerReceiptId: "receipt-123", accepted: true },
  });
  return { pin, envelope };
}

function verifyInput(
  value: unknown,
  pin: ProviderServiceResponsePin,
): Parameters<typeof verifyProviderServiceResponse>[0] {
  return {
    value,
    pin,
    expectedRole: "controller-execute",
    expectedRequestNonce: REQUEST_NONCE,
    expectedRequestSha256: REQUEST_SHA256,
    requestedAtIso: REQUESTED_AT,
    expiresAtIso: EXPIRES_AT,
    completedAtIso: COMPLETED_AT,
  };
}

describe("provider service signed response envelope", () => {
  it("verifies and returns only the exactly signed result", async () => {
    const { pin, envelope } = await signedFixture();
    expect(verifyProviderServiceResponse(verifyInput(envelope, pin))).toEqual({
      providerReceiptId: "receipt-123",
      accepted: true,
    });
  });

  it.each([
    ["role", "cleanup-execute"],
    ["requestNonce", "B".repeat(43)],
    ["requestSha256", "2".repeat(64)],
    ["endpoint", "https://proxy.example.test/provider-canary/v1/service"],
    ["organizationId", "substitute-org"],
    ["administrativeDomain", "substitute-domain"],
    ["respondedAtIso", "2026-08-20T10:02:00.000Z"],
  ])("rejects signed-payload %s substitution", async (field, value) => {
    const { pin, envelope } = await signedFixture();
    const substituted = structuredClone(envelope) as unknown as {
      payload: Record<string, unknown>;
      signature: string;
    };
    substituted.payload[field] = value;
    expect(() =>
      verifyProviderServiceResponse(verifyInput(substituted, pin)),
    ).toThrow(/provider service response refused/);
  });

  it("rejects result and signature substitution", async () => {
    const { pin, envelope } = await signedFixture();
    const resultSubstitution = structuredClone(envelope) as unknown as {
      payload: { result: unknown };
    };
    resultSubstitution.payload.result = { providerReceiptId: "proxy-result" };
    expect(() =>
      verifyProviderServiceResponse(verifyInput(resultSubstitution, pin)),
    ).toThrow(/result digest/);

    const signatureSubstitution = structuredClone(envelope);
    signatureSubstitution.signature = "A".repeat(86);
    expect(() =>
      verifyProviderServiceResponse(verifyInput(signatureSubstitution, pin)),
    ).toThrow(/signature is invalid/);
  });

  it("rejects cross-request replay and delayed delivery", async () => {
    const { pin, envelope } = await signedFixture();
    expect(() =>
      verifyProviderServiceResponse({
        ...verifyInput(envelope, pin),
        expectedRequestNonce: "C".repeat(43),
      }),
    ).toThrow(/correlation/);
    expect(() =>
      verifyProviderServiceResponse({
        ...verifyInput(envelope, pin),
        completedAtIso: "2026-08-20T10:01:06.000Z",
      }),
    ).toThrow(/freshness/);
  });

  it("rejects a different organization's otherwise valid key and envelope", async () => {
    const first = await signedFixture();
    const second = fixture();
    expect(() =>
      verifyProviderServiceResponse(verifyInput(first.envelope, second.pin)),
    ).toThrow(/correlation/);
  });
});
