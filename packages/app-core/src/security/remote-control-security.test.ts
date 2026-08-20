/** Adversarial tests for signed, target-bound remote command verification. */

import { generateKeyPairSync, sign } from "node:crypto";
import {
  canonicalizeRemoteControlValue,
  REMOTE_CONTROL_PROTOCOL_VERSION,
  type RemoteCommandBody,
  type RemoteControllerGrant,
  type RemoteControllerPublicIdentity,
  type SignedRemoteCommand,
  type SignedRemoteCommandResult,
} from "@elizaos/shared";
import { beforeEach, describe, expect, it } from "vitest";
import {
  decryptRemoteCommand,
  digestRemotePayload,
  encryptRemoteCommand,
  InMemoryRemoteReplayStore,
  verifyRemoteCommand,
  verifyRemoteCommandResult,
} from "./remote-control-security";

const NOW = 2_000_000_000_000;
const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const otherKeys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });

const identity: RemoteControllerPublicIdentity = {
  version: REMOTE_CONTROL_PROTOCOL_VERSION,
  deviceId: "phone-1",
  keyId: "phone-key-1",
  displayName: "Nubs's iPhone",
  platform: "ios",
  signingPublicKeyJwk: keys.publicKey.export({ format: "jwk" }),
  encryptionPublicKeyJwk: keys.publicKey.export({ format: "jwk" }),
  createdAt: NOW - 10_000,
};

const grant: RemoteControllerGrant = {
  version: REMOTE_CONTROL_PROTOCOL_VERSION,
  grantId: "grant-1",
  ownerId: "owner-1",
  controllerDeviceId: identity.deviceId,
  controllerKeyId: identity.keyId,
  targetRuntimeIds: ["mac-1", "mac-2"],
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
    commandId: "command-1",
    ownerId: "owner-1",
    sessionId: "session-1",
    controllerDeviceId: "phone-1",
    controllerKeyId: "phone-key-1",
    targetRuntimeId: "mac-1",
    sequence: 1,
    nonce: "one-time-nonce",
    issuedAt: NOW - 1_000,
    expiresAt: NOW + 20_000,
    action: "agent.message",
    payload,
    payloadDigest: digestRemotePayload(payload),
    ...overrides,
  };
}

function signed(
  overrides: Partial<RemoteCommandBody> = {},
  privateKey = keys.privateKey,
): SignedRemoteCommand {
  const body = makeBody(overrides);
  return {
    body,
    signature: sign(
      "sha256",
      Buffer.from(canonicalizeRemoteControlValue(body)),
      privateKey,
    ).toString("base64url"),
  };
}

describe("verifyRemoteCommand", () => {
  let replayStore: InMemoryRemoteReplayStore;

  beforeEach(() => {
    replayStore = new InMemoryRemoteReplayStore();
  });

  function verifyCommand(
    command: SignedRemoteCommand,
    overrides: Partial<Parameters<typeof verifyRemoteCommand>[0]> = {},
  ) {
    return verifyRemoteCommand({
      command,
      identity,
      grant,
      replayStore,
      expectedOwnerId: "owner-1",
      expectedSessionId: "session-1",
      expectedTargetRuntimeId: "mac-1",
      now: NOW,
      ...overrides,
    });
  }

  it("accepts a correctly signed and bound command exactly once", async () => {
    const command = signed();
    await expect(verifyCommand(command)).resolves.toEqual({ ok: true });
    await expect(verifyCommand(command)).resolves.toEqual({
      ok: false,
      reason: "replay",
    });
  });

  it.each([
    ["wrong owner", { ownerId: "owner-2" }, "wrong_owner"],
    ["wrong session", { sessionId: "session-2" }, "wrong_session"],
    ["wrong target", { targetRuntimeId: "mac-2" }, "wrong_target"],
  ] as const)("rejects %s binding", async (_name, bodyOverride, reason) => {
    await expect(verifyCommand(signed(bodyOverride))).resolves.toEqual({
      ok: false,
      reason,
    });
  });

  it("rejects expired, future, and overlong commands", async () => {
    await expect(
      verifyCommand(
        signed({ issuedAt: NOW - 100_000, expiresAt: NOW - 40_000 }),
      ),
    ).resolves.toEqual({ ok: false, reason: "expired" });
    await expect(
      verifyCommand(
        signed({ issuedAt: NOW + 40_000, expiresAt: NOW + 50_000 }),
      ),
    ).resolves.toEqual({ ok: false, reason: "issued_in_future" });
    await expect(
      verifyCommand(signed({ issuedAt: NOW, expiresAt: NOW + 60_001 })),
    ).resolves.toEqual({ ok: false, reason: "ttl_too_long" });
  });

  it("rejects payload tampering and signatures from another device", async () => {
    const tampered = signed();
    tampered.body.payload = { message: "changed after signing" };
    await expect(verifyCommand(tampered)).resolves.toEqual({
      ok: false,
      reason: "payload_digest_mismatch",
    });
    await expect(
      verifyCommand(signed({}, otherKeys.privateKey)),
    ).resolves.toEqual({
      ok: false,
      reason: "invalid_signature",
    });
  });

  it("rejects revoked devices before touching replay state", async () => {
    const command = signed();
    await expect(
      verifyCommand(command, { grant: { ...grant, revokedAt: NOW - 1 } }),
    ).resolves.toEqual({ ok: false, reason: "revoked" });
    await expect(verifyCommand(command)).resolves.toEqual({ ok: true });
  });

  it("rejects reused or out-of-order sequences even with fresh nonces", async () => {
    await expect(verifyCommand(signed())).resolves.toEqual({ ok: true });
    await expect(
      verifyCommand(signed({ commandId: "command-2", nonce: "nonce-2" })),
    ).resolves.toEqual({ ok: false, reason: "replay" });
    await expect(
      verifyCommand(
        signed({ commandId: "command-3", nonce: "nonce-3", sequence: 2 }),
      ),
    ).resolves.toEqual({ ok: true });
  });
});

describe("encrypted relay envelope", () => {
  const runtimeKeys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });

  it("round-trips without exposing command plaintext to the relay", () => {
    const command = signed();
    const encrypted = encryptRemoteCommand(
      command,
      "phone-key-1",
      "runtime-encryption-key-1",
      runtimeKeys.publicKey.export({ format: "jwk" }),
    );
    expect(encrypted.ciphertext).not.toContain("hello");
    expect(
      decryptRemoteCommand(
        encrypted,
        runtimeKeys.privateKey.export({ format: "jwk" }),
        "runtime-encryption-key-1",
      ),
    ).toEqual(command);
  });

  it("rejects retargeting and ciphertext tampering", () => {
    const encrypted = encryptRemoteCommand(
      signed(),
      "phone-key-1",
      "runtime-encryption-key-1",
      runtimeKeys.publicKey.export({ format: "jwk" }),
    );
    expect(() =>
      decryptRemoteCommand(
        encrypted,
        runtimeKeys.privateKey.export({ format: "jwk" }),
        "different-runtime-key",
      ),
    ).toThrow("recipient or algorithm mismatch");
    const bytes = Buffer.from(encrypted.ciphertext, "base64url");
    bytes[0] ^= 1;
    expect(() =>
      decryptRemoteCommand(
        { ...encrypted, ciphertext: bytes.toString("base64url") },
        runtimeKeys.privateKey.export({ format: "jwk" }),
        "runtime-encryption-key-1",
      ),
    ).toThrow();
  });
});

describe("verifyRemoteCommandResult", () => {
  it("accepts only the target-signed result bound to the expected command", () => {
    const body = {
      version: REMOTE_CONTROL_PROTOCOL_VERSION,
      commandId: "command-1",
      targetRuntimeId: "mac-1",
      status: "completed" as const,
      result: { text: "hello from the Mac" },
      completedAt: NOW,
    };
    const signedResult: SignedRemoteCommandResult = {
      body,
      signature: sign(
        "sha256",
        Buffer.from(canonicalizeRemoteControlValue(body)),
        keys.privateKey,
      ).toString("base64url"),
    };
    const publicJwk = keys.publicKey.export({ format: "jwk" });
    expect(
      verifyRemoteCommandResult(signedResult, publicJwk, "command-1", "mac-1"),
    ).toBe(true);
    expect(
      verifyRemoteCommandResult(signedResult, publicJwk, "command-2", "mac-1"),
    ).toBe(false);
    expect(
      verifyRemoteCommandResult(
        {
          ...signedResult,
          signature: signed({}, otherKeys.privateKey).signature,
        },
        publicJwk,
        "command-1",
        "mac-1",
      ),
    ).toBe(false);
  });
});
