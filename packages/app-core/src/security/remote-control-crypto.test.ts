/**
 * Adversarial deterministic tests for the real Node cryptographic boundary;
 * key generation, signatures, ECDH, HKDF, and AES-GCM are not mocked.
 */

import { generateKeyPairSync } from "node:crypto";
import {
  copyRemoteCommandBinding,
  REMOTE_CONTROL_PROTOCOL_VERSION,
  type RemoteCommandBody,
  type RemoteControllerGrant,
  type RemoteControllerPublicIdentity,
  type RemoteJsonValue,
  type RemoteTargetPublicIdentity,
} from "@elizaos/shared";
import { describe, expect, it } from "vitest";
import {
  digestRemoteCommand,
  digestRemotePayload,
  digestRemoteResultValue,
  openRemoteControlMessage,
  sealRemoteControlMessage,
  signRemoteCommand,
  signRemoteCommandResult,
  signRemoteCommandStartReceipt,
  verifyRemoteCommandAuthenticity,
  verifyRemoteCommandResult,
  verifyRemoteCommandStartReceipt,
} from "./remote-control-crypto.js";

const NOW = 2_000_000_000_000;
const controllerSigning = generateKeyPairSync("ec", {
  namedCurve: "prime256v1",
});
const controllerEncryption = generateKeyPairSync("ec", {
  namedCurve: "prime256v1",
});
const targetSigning = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const targetEncryption = generateKeyPairSync("ec", {
  namedCurve: "prime256v1",
});
const otherSigning = generateKeyPairSync("ec", { namedCurve: "prime256v1" });

const controllerIdentity: RemoteControllerPublicIdentity = {
  version: REMOTE_CONTROL_PROTOCOL_VERSION,
  role: "controller",
  ownerId: "owner-1",
  deviceId: "controller-1",
  keyId: "controller-key-1",
  displayName: "Controller",
  platform: "linux",
  signingPublicKeyJwk: controllerSigning.publicKey.export({ format: "jwk" }),
  encryptionPublicKeyJwk: controllerEncryption.publicKey.export({
    format: "jwk",
  }),
  createdAt: NOW - 10_000,
};

const targetIdentity: RemoteTargetPublicIdentity = {
  version: REMOTE_CONTROL_PROTOCOL_VERSION,
  role: "target",
  ownerId: "owner-1",
  runtimeId: "runtime-1",
  keyId: "target-key-1",
  displayName: "Runtime",
  platform: "linux",
  signingPublicKeyJwk: targetSigning.publicKey.export({ format: "jwk" }),
  encryptionPublicKeyJwk: targetEncryption.publicKey.export({ format: "jwk" }),
  createdAt: NOW - 10_000,
};

const grant: RemoteControllerGrant = {
  version: REMOTE_CONTROL_PROTOCOL_VERSION,
  grantId: "grant-1",
  revision: 1,
  ownerId: "owner-1",
  controllerDeviceId: "controller-1",
  controllerKeyId: "controller-key-1",
  targetRuntimeIds: ["runtime-1"],
  sessionId: "session-1",
  createdAt: NOW - 10_000,
  expiresAt: null,
  revokedAt: null,
};

function makeBody(
  overrides: Partial<RemoteCommandBody> = {},
): RemoteCommandBody {
  const payload = overrides.payload ?? { message: "hello" };
  return {
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
    sequence: 1,
    nonce: "nonce-1",
    issuedAt: NOW - 1_000,
    expiresAt: NOW + 20_000,
    action: "agent.message",
    payload,
    payloadDigest: digestRemotePayload(payload),
    ...overrides,
  };
}

function command(overrides: Partial<RemoteCommandBody> = {}) {
  return signRemoteCommand(
    makeBody(overrides),
    controllerSigning.privateKey.export({ format: "jwk" }),
  );
}

function verifyCommand(
  candidate: ReturnType<typeof command>,
  overrides: Partial<
    Parameters<typeof verifyRemoteCommandAuthenticity>[0]
  > = {},
) {
  return verifyRemoteCommandAuthenticity({
    command: candidate,
    identity: controllerIdentity,
    targetIdentity,
    grant,
    expectedOwnerId: "owner-1",
    expectedSessionId: "session-1",
    expectedTargetRuntimeId: "runtime-1",
    now: NOW,
    ...overrides,
  });
}

describe("remote command authenticity", () => {
  it("accepts the exact owner/session/controller/target/key binding", () => {
    expect(verifyCommand(command())).toEqual({
      ok: true,
      commandDigest: digestRemoteCommand(command()),
    });
  });

  it.each([
    ["owner", { ownerId: "owner-2" }, "wrong_owner"],
    ["grant", { grantId: "grant-2" }, "wrong_grant"],
    ["grant revision", { grantRevision: 2 }, "stale_grant"],
    ["session", { sessionId: "session-2" }, "wrong_session"],
    ["controller", { controllerDeviceId: "controller-2" }, "wrong_controller"],
    ["target", { targetRuntimeId: "runtime-2" }, "wrong_target"],
    ["target key", { targetKeyId: "target-key-2" }, "wrong_target_key"],
  ] as const)("rejects the wrong %s", (_name, bodyOverride, reason) => {
    expect(verifyCommand(command(bodyOverride))).toEqual({ ok: false, reason });
  });

  it("rejects revoked, expired, future, and overlong authority", () => {
    expect(
      verifyCommand(command(), { grant: { ...grant, revokedAt: NOW - 1 } }),
    ).toEqual({ ok: false, reason: "revoked" });
    expect(
      verifyCommand(
        command({ issuedAt: NOW - 100_000, expiresAt: NOW - 40_000 }),
      ),
    ).toEqual({ ok: false, reason: "expired" });
    expect(
      verifyCommand(
        command({ issuedAt: NOW + 40_000, expiresAt: NOW + 50_000 }),
      ),
    ).toEqual({ ok: false, reason: "issued_in_future" });
    expect(
      verifyCommand(command({ issuedAt: NOW, expiresAt: NOW + 60_001 })),
    ).toEqual({ ok: false, reason: "ttl_too_long" });
  });

  it("rejects payload and signature tampering", () => {
    const payloadTampered = command();
    payloadTampered.body.payload = { message: "changed" };
    expect(verifyCommand(payloadTampered)).toEqual({
      ok: false,
      reason: "payload_digest_mismatch",
    });

    const wrongSignature = signRemoteCommand(
      makeBody(),
      otherSigning.privateKey.export({ format: "jwk" }),
    );
    expect(verifyCommand(wrongSignature)).toEqual({
      ok: false,
      reason: "invalid_signature",
    });
  });
});

describe("recipient-bound encryption", () => {
  it("round-trips a command while keeping plaintext out of the relay envelope", () => {
    const signed = command();
    const scope = {
      ...signed.body,
      messageKind: "command" as const,
      senderKeyId: "controller-key-1",
      recipientKeyId: "target-key-1",
    };
    const envelope = sealRemoteControlMessage(
      signed,
      scope,
      targetIdentity.encryptionPublicKeyJwk,
    );
    expect(envelope.ciphertext).not.toContain("hello");
    expect(
      openRemoteControlMessage(
        envelope,
        targetEncryption.privateKey.export({ format: "jwk" }),
        scope,
      ),
    ).toEqual(signed);
  });

  it("rejects recipient retargeting, AAD mutation, ciphertext tampering, and kind mismatch", () => {
    const signed = command();
    const scope = {
      ...signed.body,
      messageKind: "command" as const,
      senderKeyId: "controller-key-1",
      recipientKeyId: "target-key-1",
    };
    const envelope = sealRemoteControlMessage(
      signed,
      scope,
      targetIdentity.encryptionPublicKeyJwk,
    );
    expect(() =>
      openRemoteControlMessage(
        envelope,
        targetEncryption.privateKey.export({ format: "jwk" }),
        { ...scope, recipientKeyId: "other-target-key" },
      ),
    ).toThrow("scope mismatch");
    expect(() =>
      openRemoteControlMessage(
        { ...envelope, ownerId: "owner-2" },
        targetEncryption.privateKey.export({ format: "jwk" }),
        scope,
      ),
    ).toThrow("scope mismatch");
    const ciphertext = Buffer.from(envelope.ciphertext, "base64url");
    ciphertext[0] ^= 1;
    expect(() =>
      openRemoteControlMessage(
        { ...envelope, ciphertext: ciphertext.toString("base64url") },
        targetEncryption.privateKey.export({ format: "jwk" }),
        scope,
      ),
    ).toThrow();
    expect(() =>
      sealRemoteControlMessage(
        signed,
        { ...scope, messageKind: "result" },
        targetIdentity.encryptionPublicKeyJwk,
      ),
    ).toThrow("does not match envelope kind");
  });
});

describe("target receipts and results", () => {
  it("binds start and completion to the original command and target key", () => {
    const signed = command();
    const commandDigest = digestRemoteCommand(signed);
    const start = signRemoteCommandStartReceipt(
      {
        ...copyRemoteCommandBinding(signed.body),
        status: "started",
        commandDigest,
        executionId: "execution-1",
        startedAt: NOW,
      },
      targetSigning.privateKey.export({ format: "jwk" }),
    );
    expect(verifyRemoteCommandStartReceipt(start, targetIdentity, signed)).toBe(
      true,
    );
    expect(
      verifyRemoteCommandStartReceipt(
        { ...start, body: { ...start.body, ownerId: "owner-2" } },
        targetIdentity,
        signed,
      ),
    ).toBe(false);

    const resultValue: RemoteJsonValue = { text: "done" };
    const result = signRemoteCommandResult(
      {
        ...copyRemoteCommandBinding(signed.body),
        commandDigest,
        status: "completed",
        executionId: "execution-1",
        startedAt: NOW,
        completedAt: NOW + 1,
        result: resultValue,
        resultDigest: digestRemoteResultValue(resultValue, undefined),
      },
      targetSigning.privateKey.export({ format: "jwk" }),
    );
    expect(verifyRemoteCommandResult(result, targetIdentity, signed)).toBe(
      true,
    );
    expect(
      verifyRemoteCommandResult(
        { ...result, body: { ...result.body, commandId: "command-2" } },
        targetIdentity,
        signed,
      ),
    ).toBe(false);
    expect(
      verifyRemoteCommandResult(
        { ...result, body: { ...result.body, result: { text: "tampered" } } },
        targetIdentity,
        signed,
      ),
    ).toBe(false);
  });
});
