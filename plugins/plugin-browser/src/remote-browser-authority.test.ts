/** Verifies real cryptographic authorization denies legacy grants and binds browser effects to one profile. */
import { generateKeyPairSync } from "node:crypto";
import type {
  RemoteCommandBody,
  RemoteControllerGrant,
  RemoteControllerPublicIdentity,
  RemoteTargetPublicIdentity,
} from "@elizaos/core/contracts/remote-control";
import { describe, expect, it } from "vitest";
import {
  digestRemotePayload,
  signRemoteCommand,
  verifyRemoteCommandAuthenticity,
} from "../../../packages/app/src/security/remote-control-crypto";

function fixture() {
  const controller = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const target = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const publicKey = controller.publicKey.export({ format: "jwk" });
  const targetKey = target.publicKey.export({ format: "jwk" });
  const now = Date.now();
  const identity: RemoteControllerPublicIdentity = {
    version: 1,
    role: "controller",
    ownerId: "owner",
    deviceId: "controller-device",
    keyId: "controller-key",
    displayName: "Controller",
    platform: "linux",
    signingPublicKeyJwk: publicKey,
    encryptionPublicKeyJwk: publicKey,
    createdAt: now,
  };
  const targetIdentity: RemoteTargetPublicIdentity = {
    version: 1,
    role: "target",
    ownerId: "owner",
    runtimeId: "target-runtime",
    keyId: "target-key",
    displayName: "Target",
    platform: "linux",
    signingPublicKeyJwk: targetKey,
    encryptionPublicKeyJwk: targetKey,
    createdAt: now,
  };
  const grant: RemoteControllerGrant = {
    version: 1,
    grantId: "grant",
    revision: 1,
    ownerId: "owner",
    controllerDeviceId: identity.deviceId,
    controllerKeyId: identity.keyId,
    targetRuntimeIds: [targetIdentity.runtimeId],
    sessionId: "session",
    createdAt: now,
    expiresAt: now + 60000,
    revokedAt: null,
  };
  const payload = {
    profileId: "profile-one",
    command: { subaction: "click", id: "12", selector: "snapshot:0:1" },
  };
  const body: RemoteCommandBody = {
    version: 1,
    ownerId: "owner",
    grantId: grant.grantId,
    grantRevision: 1,
    sessionId: grant.sessionId,
    controllerDeviceId: identity.deviceId,
    controllerKeyId: identity.keyId,
    targetRuntimeId: targetIdentity.runtimeId,
    targetKeyId: targetIdentity.keyId,
    commandId: "command",
    sequence: 1,
    nonce: "nonce",
    issuedAt: now,
    expiresAt: now + 30000,
    action: "browser.command",
    payload,
    payloadDigest: digestRemotePayload(payload),
  };
  const command = signRemoteCommand(
    body,
    controller.privateKey.export({ format: "jwk" }),
  );
  return {
    command,
    grant,
    identity,
    targetIdentity,
    now,
    expectedOwnerId: "owner",
    expectedSessionId: "session",
    expectedTargetRuntimeId: "target-runtime",
  };
}

describe("explicit remote browser authority", () => {
  it("rejects browser effects under a legacy pairing grant", () => {
    expect(verifyRemoteCommandAuthenticity(fixture())).toEqual({
      ok: false,
      reason: "capability_denied",
    });
  });
  it("admits a real signed effect only for the explicitly granted profile", () => {
    const input = fixture();
    input.grant.browserProfileId = "profile-one";
    expect(verifyRemoteCommandAuthenticity(input)).toMatchObject({ ok: true });
    input.grant.browserProfileId = "other-profile";
    expect(verifyRemoteCommandAuthenticity(input)).toEqual({
      ok: false,
      reason: "capability_denied",
    });
  });
  it("retains signature and owner checks after browser scope admission", () => {
    const input = fixture();
    input.grant.browserProfileId = "profile-one";
    input.command.body.payload.command = { subaction: "close", id: "12" };
    expect(verifyRemoteCommandAuthenticity(input)).toEqual({
      ok: false,
      reason: "payload_digest_mismatch",
    });
    expect(
      verifyRemoteCommandAuthenticity({
        ...input,
        expectedOwnerId: "other-owner",
      }),
    ).toEqual({ ok: false, reason: "wrong_owner" });
  });
});
