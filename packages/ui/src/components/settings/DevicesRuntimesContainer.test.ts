/** Pure state-reconciliation and destructive-cleanup tests for Devices & Runtimes. */
import { describe, expect, it, vi } from "vitest";

import type {
  RemoteHostDirectory,
  RemoteHostSummary,
  RemoteSessionSummary,
} from "../../api/remote-control-cloud-client";
import type { AgentProfile } from "../../state";
import { devicesRuntimesInternals } from "./DevicesRuntimesContainer";

const PUBLIC_JWK: JsonWebKey = {
  kty: "EC",
  crv: "P-256",
  x: "x",
  y: "y",
};

const HOST: RemoteHostSummary = {
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

const SESSION: RemoteSessionSummary = {
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
    targetCreatedAt: Date.parse("2026-08-22T00:00:00.000Z"),
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
      removeSsh: vi.fn(),
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
        removeSsh: vi.fn(),
        removeProfile: failedRemove,
      }),
    ).rejects.toThrow("Cloud unavailable");
    expect(failedRemove).not.toHaveBeenCalled();
  });

  it("revokes a desktop host in Cloud before native credential cleanup", async () => {
    const events: string[] = [];
    await devicesRuntimesInternals.revokeDesktopHostCloudFirst("host-1", {
      revokeHost: vi.fn(async () => {
        events.push("cloud");
      }),
      finalizeLocal: vi.fn(async () => {
        events.push("native");
        return true;
      }),
    });
    expect(events).toEqual(["cloud", "native"]);

    const finalizeLocal = vi.fn();
    await expect(
      devicesRuntimesInternals.revokeDesktopHostCloudFirst("host-1", {
        revokeHost: vi.fn(async () => {
          throw new Error("Cloud unavailable");
        }),
        finalizeLocal,
      }),
    ).rejects.toThrow("Cloud unavailable");
    expect(finalizeLocal).not.toHaveBeenCalled();
  });

  it("requires every persisted SSH cleanup receipt to finish", () => {
    expect(() =>
      devicesRuntimesInternals.requireCompleteSshCleanup([
        {
          complete: false,
          failures: [],
          receipt: {
            version: 2,
            operationId: "operation-1",
            state: "removal",
            runtimeId: "runtime-1",
            profileId: "runtime-1",
            createdAt: "2026-08-22T00:00:00.000Z",
            pending: {
              stopTunnel: true,
              deleteCredential: false,
              removeProfile: false,
            },
          },
        },
      ]),
    ).toThrow(/cleanup is incomplete/i);
  });
});
