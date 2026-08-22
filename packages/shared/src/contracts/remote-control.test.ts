/** Tests the deterministic, bounded remote-control wire contract directly. */

import { describe, expect, it } from "vitest";
import {
  canonicalizeRemoteControlValue,
  isEncryptedRemoteControlEnvelope,
  isRemoteControlIdentifier,
  isSignedRemoteCommand,
  REMOTE_CONTROL_ENVELOPE_ALGORITHM,
  REMOTE_CONTROL_PROTOCOL_VERSION,
  REMOTE_CONTROL_SIGNATURE_ALGORITHM,
} from "./remote-control.js";

const binding = {
  version: REMOTE_CONTROL_PROTOCOL_VERSION,
  ownerId: "owner-1",
  grantId: "grant-1",
  grantRevision: 1,
  sessionId: "session-1",
  controllerDeviceId: "controller-1",
  controllerKeyId: "controller-key-1",
  targetRuntimeId: "runtime-1",
  targetKeyId: "target-key-1",
  commandId: "command-1",
} as const;

describe("remote-control contract", () => {
  it("canonicalizes nested keys and preserves array order", () => {
    expect(
      canonicalizeRemoteControlValue({
        z: [{ b: 2, a: 1 }],
        a: "hello",
        omitted: undefined,
      }),
    ).toBe('{"a":"hello","z":[{"a":1,"b":2}]}');
  });

  it("rejects cycles and values beyond the protocol depth bound", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalizeRemoteControlValue(cyclic)).toThrow(
      "canonical JSON limits",
    );

    let deep: unknown = "leaf";
    for (let index = 0; index < 70; index += 1) deep = [deep];
    expect(() => canonicalizeRemoteControlValue(deep)).toThrow(
      "canonical JSON limits",
    );
  });

  it("accepts strict identifiers and rejects normalization ambiguity", () => {
    expect(isRemoteControlIdentifier("runtime-1")).toBe(true);
    expect(isRemoteControlIdentifier(" runtime-1")).toBe(false);
    expect(isRemoteControlIdentifier("runtime\n1")).toBe(false);
    expect(isRemoteControlIdentifier("")).toBe(false);
  });

  it("validates the signed command shape before cryptographic processing", () => {
    const command = {
      body: {
        ...binding,
        sequence: 1,
        nonce: "nonce-1",
        issuedAt: 2_000_000_000_000,
        expiresAt: 2_000_000_030_000,
        action: "agent.message",
        payload: { message: "hello" },
        payloadDigest: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      },
      signatureAlgorithm: REMOTE_CONTROL_SIGNATURE_ALGORITHM,
      signature: "AQID",
    };
    expect(isSignedRemoteCommand(command)).toBe(true);
    expect(
      isSignedRemoteCommand({
        ...command,
        body: { ...command.body, sequence: 0 },
      }),
    ).toBe(false);
  });

  it("rejects malformed or partially rebound encrypted envelopes", () => {
    const envelope = {
      ...binding,
      messageKind: "command",
      algorithm: REMOTE_CONTROL_ENVELOPE_ALGORITHM,
      senderKeyId: "controller-key-1",
      recipientKeyId: "target-key-1",
      messageDigest: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      ephemeralPublicKeyJwk: {
        kty: "EC",
        crv: "P-256",
        x: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        y: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      },
      salt: "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
      iv: "DDDDDDDDDDDDDDDD",
      ciphertext: "EEEEEEEEEEEEEEEEEEEEEEE",
      sequence: 1,
      nonce: "nonce-1",
      issuedAt: 2_000_000_000_000,
      expiresAt: 2_000_000_030_000,
    };
    expect(isEncryptedRemoteControlEnvelope(envelope)).toBe(true);
    expect(
      isEncryptedRemoteControlEnvelope({ ...envelope, targetRuntimeId: "" }),
    ).toBe(false);
    expect(
      isEncryptedRemoteControlEnvelope({
        ...envelope,
        messageKind: "plaintext",
      }),
    ).toBe(false);
    expect(isEncryptedRemoteControlEnvelope({ ...envelope, sequence: 0 })).toBe(
      false,
    );
  });
});
