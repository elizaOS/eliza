/** Pure state-reconciliation and destructive-cleanup tests for Devices & Runtimes. */
import { describe, expect, it, vi } from "vitest";

import type { RemoteHostDirectory } from "../../api/remote-control-cloud-client";
import type { AgentProfile } from "../../state";
import { devicesRuntimesInternals } from "./DevicesRuntimesContainer";

const PUBLIC_JWK: JsonWebKey = {
  kty: "EC",
  crv: "P-256",
  x: "x",
  y: "y",
};

const HOST = {
  id: "host-1",
  deviceId: "target-device",
  displayName: "Studio Mac",
  platform: "macos" as const,
  connectionMode: "relay",
  runtimeKeyId: "target-key",
  signingPublicKeyJwk: PUBLIC_JWK,
  encryptionPublicKeyJwk: PUBLIC_JWK,
  status: "active",
  lastSeenAt: null,
  createdAt: "2026-08-22T00:00:00.000Z",
  revokedAt: null,
};

const SESSION = {
  id: "session-1",
  ownerId: "owner-1",
  grantId: "grant-1",
  grantRevision: 1,
  hostId: "host-1",
  targetRuntimeId: "host-1",
  status: "active",
  controllerDeviceId: "other-device",
  controllerKeyId: "other-key",
  targetKeyId: "target-key",
  grantExpiresAt: "2026-08-23T00:00:00.000Z",
  createdAt: "2026-08-22T00:00:00.000Z",
  updatedAt: "2026-08-22T00:00:00.000Z",
};

const PROFILE: AgentProfile = {
  id: "profile-1",
  label: "Studio Mac",
  kind: "remote",
  apiBase: "eliza-remote://session/session-1",
  connectionMode: "relay",
  createdAt: "2026-08-22T00:00:00.000Z",
  remoteRelay: {
    ownerId: "owner-1",
    controllerDeviceId: "this-device",
    controllerKeyId: "this-key",
    grantId: "grant-1",
    grantRevision: 1,
    sessionId: "session-1",
    targetRuntimeId: "host-1",
    targetKeyId: "target-key",
    targetDisplayName: "Studio Mac",
    targetPlatform: "macos",
    targetSigningPublicKeyJwk: PUBLIC_JWK,
    targetEncryptionPublicKeyJwk: PUBLIC_JWK,
    expiresAt: "2026-08-23T00:00:00.000Z",
  },
};

describe("Devices & Runtimes reconciliation", () => {
  it("does not expose another controller's active session as this device's grant", () => {
    const target = devicesRuntimesInternals.hostTarget(
      HOST,
      new Map([[HOST.id, [SESSION]]]),
      {
        version: 1,
        role: "controller",
        ownerId: "owner-1",
        deviceId: "this-device",
        keyId: "this-key",
        displayName: "Linux",
        platform: "linux",
        signingPublicKeyJwk: PUBLIC_JWK,
        encryptionPublicKeyJwk: PUBLIC_JWK,
        createdAt: 1,
      },
    );
    expect(target.activity).toBe("Paired on another controller");
    expect(target.canPair).toBe(true);
    expect(target.canRevoke).toBe(false);
  });

  it("marks a stale local relay profile as an error instead of connected", () => {
    const directory: RemoteHostDirectory = {
      ownerId: "owner-1",
      hosts: [HOST],
    };
    const target = devicesRuntimesInternals.profileTarget(
      PROFILE,
      PROFILE.id,
      new Map(),
      directory,
      new Map([[HOST.id, [{ ...SESSION, status: "revoked" }]]]),
    );
    expect(target.status).toBe("error");
    expect(target.error).toMatch(/no longer active/);
  });

  it("revokes Cloud before local cleanup and retains the profile after partial failure", async () => {
    const events: string[] = [];
    const removeProfile = vi.fn(() => events.push("remove"));
    await devicesRuntimesInternals.removeRuntimeWithAuthority(PROFILE, {
      revokeSession: vi.fn(async () => {
        events.push("revoke");
      }),
      clearSession: vi.fn(async () => events.push("clear")),
      stopSsh: vi.fn(),
      deleteCredential: vi.fn(),
      removeProfile,
    });
    expect(events).toEqual(["revoke", "clear", "remove"]);

    const failedRemove = vi.fn();
    await expect(
      devicesRuntimesInternals.removeRuntimeWithAuthority(PROFILE, {
        revokeSession: vi.fn(async () => {
          throw new Error("Cloud unavailable");
        }),
        clearSession: vi.fn(),
        stopSsh: vi.fn(),
        deleteCredential: vi.fn(),
        removeProfile: failedRemove,
      }),
    ).rejects.toThrow("Cloud unavailable");
    expect(failedRemove).not.toHaveBeenCalled();
  });
});
