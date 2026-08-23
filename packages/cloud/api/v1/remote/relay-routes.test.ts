/**
 * Exercises secure remote relay HTTP boundaries with deterministic persistence
 * collaborators, covering owner scope, one-use activation, replay mapping,
 * host authentication, start fencing, ambiguity, and idempotent revocation.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
  REMOTE_CONTROL_ENVELOPE_ALGORITHM,
  REMOTE_CONTROL_PROTOCOL_VERSION,
} from "@elizaos/shared/contracts/remote-control";
import { Hono } from "hono";
import type { AppEnv } from "@/types/cloud-worker-env";

const organizationId = "10000000-0000-4000-8000-000000000001";
const ownerId = "20000000-0000-4000-8000-000000000001";
const hostId = "40000000-0000-4000-8000-000000000001";
const sessionId = "50000000-0000-4000-8000-000000000001";
const grantId = "60000000-0000-4000-8000-000000000001";
const commandId = "command-one";
const claimToken = "70000000-0000-4000-8000-000000000001";
const controllerKeyId = "controller-key-one";
const targetKeyId = "target-key-one";
const hostToken = `rhost_v1_${"A".repeat(43)}`;
const publicJwk = {
  kty: "EC",
  crv: "P-256",
  x: "k6rgke6fNq62RpJc23PzYnmd9702xegeg3Ian-dsmqk",
  y: "LWE89OONX0oDV-cNpPQaAVu456yXJ70K8E9Iq2LQHvM",
};

const requireUserOrApiKeyWithOrg = mock(async () => ({
  id: ownerId,
  organization_id: organizationId,
}));
const createOwned = mock();
const recoverHostCredential = mock();
const listOwned = mock();
const revokeHost = mock();
const revokeAuthenticatedHost = mock();
const recordManagedEnrollment = mock();
const recordManagedCleanupPending = mock();
const recordManagedCleanupFailure = mock();
const completeManagedCleanup = mock();
const createPreAuthKey = mock();
const expirePreAuthKey = mock();
const deletePreAuthKey = mock();
const listNodesStrict = mock();
const deleteNode = mock();
const createPendingForOwnedAgent = mock();
const createPendingForOwnedHost = mock();
const activatePendingHost = mock();
const listActiveByOwnedAgent = mock();
const listByOwnedHost = mock();
const revokeSession = mock();
const enqueue = mock();
const claimNext = mock();
const recordStart = mock();
const complete = mock();
const readOwnedResult = mock();

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg,
}));
mock.module("@/db/repositories/remote-hosts", () => ({
  remoteHostsRepository: {
    createOwned,
    recoverCredential: recoverHostCredential,
    listOwned,
    revoke: revokeHost,
    revokeAuthenticated: revokeAuthenticatedHost,
    recordManagedEnrollment,
    recordManagedCleanupPending,
    recordManagedCleanupFailure,
    completeManagedCleanup,
  },
}));
mock.module("@/lib/services/headscale-client", () => ({
  HeadscaleClient: class {
    createPreAuthKey = createPreAuthKey;
    expirePreAuthKey = expirePreAuthKey;
    deletePreAuthKey = deletePreAuthKey;
    listNodesStrict = listNodesStrict;
    deleteNode = deleteNode;
  },
}));
mock.module("@/db/repositories/remote-sessions", () => ({
  remoteSessionsRepository: {
    createPendingForOwnedAgent,
    createPendingForOwnedHost,
    activatePendingHost,
    listActiveByOwnedAgent,
    listByOwnedHost,
    revoke: revokeSession,
  },
}));
mock.module("@/db/repositories/remote-command-envelopes", () => ({
  remoteCommandEnvelopesRepository: {
    enqueue,
    claimNext,
    recordStart,
    complete,
    readOwnedResult,
  },
}));

const { default: hostsRoute } = await import("./hosts/route");
const { default: hostRevokeRoute } = await import("./hosts/[id]/revoke/route");
const { default: pairRoute } = await import("./pair/route");
const { default: sessionsRoute } = await import("./sessions/route");
const { default: activateRoute } = await import(
  "./sessions/[id]/activate/route"
);
const { default: commandsRoute } = await import(
  "./sessions/[id]/commands/route"
);
const { default: commandRoute } = await import(
  "./sessions/[id]/commands/[commandId]/route"
);
const { default: startRoute } = await import(
  "./sessions/[id]/commands/[commandId]/start/route"
);
const { default: completeRoute } = await import(
  "./sessions/[id]/commands/[commandId]/complete/route"
);

const app = new Hono<AppEnv>();
app.route("/api/v1/remote/hosts", hostsRoute);
app.route("/api/v1/remote/hosts/:id/revoke", hostRevokeRoute);
app.route("/api/v1/remote/pair", pairRoute);
app.route("/api/v1/remote/sessions", sessionsRoute);
app.route("/api/v1/remote/sessions/:id/activate", activateRoute);
app.route("/api/v1/remote/sessions/:id/commands", commandsRoute);
app.route("/api/v1/remote/sessions/:id/commands/:commandId", commandRoute);
app.route("/api/v1/remote/sessions/:id/commands/:commandId/start", startRoute);
app.route(
  "/api/v1/remote/sessions/:id/commands/:commandId/complete",
  completeRoute,
);

function envelope(
  messageKind: "command" | "start_receipt" | "result",
  owner = ownerId,
) {
  const common = {
    version: REMOTE_CONTROL_PROTOCOL_VERSION,
    ownerId: owner,
    grantId,
    grantRevision: 1,
    sessionId,
    controllerDeviceId: "controller-one",
    controllerKeyId,
    targetRuntimeId: hostId,
    targetKeyId,
    commandId,
    algorithm: REMOTE_CONTROL_ENVELOPE_ALGORITHM,
    senderKeyId: messageKind === "command" ? controllerKeyId : targetKeyId,
    recipientKeyId: messageKind === "command" ? targetKeyId : controllerKeyId,
    messageDigest: "A".repeat(43),
    ephemeralPublicKeyJwk: publicJwk,
    salt: "A".repeat(43),
    iv: "B".repeat(16),
    ciphertext: "C".repeat(23),
  };
  return messageKind === "command"
    ? {
        ...common,
        messageKind,
        sequence: 1,
        nonce: "nonce-one",
        issuedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      }
    : { ...common, messageKind };
}

function hostHeaders() {
  return {
    "content-type": "application/json",
    "x-remote-host-id": hostId,
    authorization: `Bearer ${hostToken}`,
  };
}

function request(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
  bindings: Partial<AppEnv["Bindings"]> = {},
) {
  return app.fetch(
    new Request(`https://api.example.test${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
    {
      REMOTE_PAIRING_HMAC_SECRET:
        "route-pairing-secret-at-least-thirty-two-bytes",
      ...bindings,
    } as AppEnv["Bindings"],
  );
}

beforeEach(() => {
  for (const collaborator of [
    createOwned,
    recoverHostCredential,
    listOwned,
    revokeHost,
    revokeAuthenticatedHost,
    recordManagedEnrollment,
    recordManagedCleanupPending,
    recordManagedCleanupFailure,
    completeManagedCleanup,
    createPreAuthKey,
    expirePreAuthKey,
    deletePreAuthKey,
    listNodesStrict,
    deleteNode,
    createPendingForOwnedAgent,
    createPendingForOwnedHost,
    activatePendingHost,
    listActiveByOwnedAgent,
    listByOwnedHost,
    revokeSession,
    enqueue,
    claimNext,
    recordStart,
    complete,
    readOwnedResult,
  ]) {
    collaborator.mockReset();
  }
  listOwned.mockResolvedValue([]);
  recordManagedEnrollment.mockResolvedValue(undefined);
  recordManagedCleanupFailure.mockResolvedValue(undefined);
  completeManagedCleanup.mockResolvedValue(undefined);
  createPreAuthKey.mockResolvedValue({
    id: "123",
    key: "hskey-auth-one-use-secret",
    reusable: false,
    ephemeral: false,
    used: false,
    expiration: "2026-08-22T06:30:00.000Z",
  });
  expirePreAuthKey.mockResolvedValue(undefined);
  deletePreAuthKey.mockResolvedValue(undefined);
  listNodesStrict.mockResolvedValue([]);
  deleteNode.mockResolvedValue(undefined);
});

describe("secure remote relay routes", () => {
  test("enrolls a host only in the authenticated owner scope and returns its token once", async () => {
    createOwned.mockImplementation(async (input) => ({
      kind: "created",
      host: { ...input, created_at: new Date("2026-08-22T06:15:00.000Z") },
    }));
    const response = await request("/api/v1/remote/hosts", {
      ownerId: "attacker",
      deviceId: "linux-one",
      displayName: "Linux One",
      platform: "linux",
      connectionMode: "relay",
      runtimeKeyId: targetKeyId,
      signingPublicKeyJwk: publicJwk,
      encryptionPublicKeyJwk: publicJwk,
    });
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(createOwned).toHaveBeenCalledTimes(1);
    expect(createOwned.mock.calls[0]?.[0]).toMatchObject({
      organization_id: organizationId,
      user_id: ownerId,
      device_id: "linux-one",
    });
    const body = (await response.json()) as {
      data: { hostToken: string; createdAt: string };
    };
    expect(body.data.hostToken).toMatch(/^rhost_v1_[A-Za-z0-9_-]{43}$/);
    expect(body.data.createdAt).toBe("2026-08-22T06:15:00.000Z");
    expect(createOwned.mock.calls[0]?.[0].host_token_hash).not.toBe(
      body.data.hostToken,
    );
  });

  test("returns a one-use managed-network key without persisting it", async () => {
    createOwned.mockImplementation(async (input) => ({
      kind: "created",
      host: { ...input, created_at: new Date("2026-08-22T06:15:00.000Z") },
    }));
    const response = await request(
      "/api/v1/remote/hosts",
      {
        deviceId: "mac-one",
        displayName: "Mac One",
        platform: "macos",
        connectionMode: "relay",
        managedNetwork: true,
        runtimeKeyId: targetKeyId,
        signingPublicKeyJwk: publicJwk,
        encryptionPublicKeyJwk: publicJwk,
      },
      {},
      {
        HEADSCALE_API_URL: "https://headscale-staging.example",
        HEADSCALE_PUBLIC_URL: "https://headscale-staging.example",
        HEADSCALE_API_KEY: "headscale-api-secret",
      },
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      data: {
        hostToken: string;
        status: string;
        managedNetworkEnrollment: { authKey: string; hostname: string };
      };
    };
    expect(createOwned.mock.calls[0]?.[0]).toMatchObject({ status: "pending" });
    expect(body.data.status).toBe("active");
    expect(body.data.managedNetworkEnrollment.authKey).toBe(
      "hskey-auth-one-use-secret",
    );
    expect(recordManagedEnrollment).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId,
        userId: ownerId,
        preAuthKeyId: "123",
      }),
    );
    expect(JSON.stringify(recordManagedEnrollment.mock.calls)).not.toContain(
      body.data.managedNetworkEnrollment.authKey,
    );
    expect(JSON.stringify(createOwned.mock.calls)).not.toContain(
      body.data.managedNetworkEnrollment.authKey,
    );
  });

  test("revokes the new host after managed-network enrollment fails", async () => {
    createOwned.mockImplementation(async (input) => ({
      kind: "created",
      host: { ...input, created_at: new Date("2026-08-22T06:15:00.000Z") },
    }));
    recordManagedEnrollment.mockRejectedValue(
      new Error("database unavailable"),
    );
    revokeHost.mockResolvedValue({
      host: { id: hostId, status: "revoked" },
      alreadyRevoked: false,
      cleanup: { sessions: 0, commands: 0, more: false },
    });
    const response = await request(
      "/api/v1/remote/hosts",
      {
        deviceId: "mac-one",
        displayName: "Mac One",
        platform: "macos",
        connectionMode: "relay",
        managedNetwork: true,
        runtimeKeyId: targetKeyId,
        signingPublicKeyJwk: publicJwk,
        encryptionPublicKeyJwk: publicJwk,
      },
      {},
      {
        HEADSCALE_API_URL: "https://headscale-staging.example",
        HEADSCALE_PUBLIC_URL: "https://headscale-staging.example",
        HEADSCALE_API_KEY: "headscale-api-secret",
      },
    );
    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(expirePreAuthKey).toHaveBeenCalledWith("123");
    expect(deletePreAuthKey).toHaveBeenCalledWith("123");
    expect(revokeHost).toHaveBeenCalledTimes(1);
  });

  test("bootstraps the authenticated owner and target public keys without leaking host credentials", async () => {
    const staleHostId = "40000000-0000-4000-8000-000000000002";
    listOwned.mockResolvedValue([
      {
        id: hostId,
        device_id: "linux-one",
        display_name: "Linux One",
        platform: "linux",
        connection_mode: "relay",
        runtime_key_id: targetKeyId,
        signing_public_jwk: publicJwk,
        encryption_public_jwk: publicJwk,
        host_token_hash: "sha256:must-not-leak",
        status: "active",
        last_seen_at: new Date(),
        created_at: new Date(),
        revoked_at: null,
      },
      {
        id: "40000000-0000-4000-8000-000000000003",
        status: "pending",
        created_at: new Date(),
      },
      {
        id: staleHostId,
        device_id: "linux-stale",
        display_name: "Linux Stale",
        platform: "linux",
        connection_mode: "relay",
        runtime_key_id: "target-key-stale",
        signing_public_jwk: publicJwk,
        encryption_public_jwk: publicJwk,
        host_token_hash: "sha256:also-must-not-leak",
        status: "active",
        last_seen_at: new Date(Date.now() - 60_000),
        created_at: new Date(),
        revoked_at: null,
      },
    ]);
    const response = await app.request(
      "https://api.example.test/api/v1/remote/hosts",
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { ownerId: string; hosts: Record<string, unknown>[] };
    };
    expect(listOwned).toHaveBeenCalledWith(organizationId, ownerId);
    expect(body.data.ownerId).toBe(ownerId);
    expect(body.data.hosts[0]).toMatchObject({
      id: hostId,
      runtimeKeyId: targetKeyId,
      signingPublicKeyJwk: publicJwk,
      encryptionPublicKeyJwk: publicJwk,
      status: "active",
    });
    expect(body.data.hosts).toHaveLength(2);
    expect(body.data.hosts[1]).toMatchObject({
      id: staleHostId,
      status: "offline",
    });
    expect(body.data.hosts[0]).not.toHaveProperty("hostTokenHash");
    expect(JSON.stringify(body)).not.toContain("must-not-leak");
    expect(JSON.stringify(body)).not.toContain("also-must-not-leak");
  });

  test("recovers a lost one-time host token only through the owner-bound identity", async () => {
    recoverHostCredential.mockImplementation(async (input) => ({
      kind: "recovered",
      host: {
        id: input.hostId,
        runtime_key_id: input.runtimeKeyId,
        status: "active",
        created_at: new Date("2026-08-22T06:15:00.000Z"),
      },
    }));
    const response = await request("/api/v1/remote/hosts", {
      recoveryHostId: hostId,
      deviceId: "linux-one",
      displayName: "Linux One",
      platform: "linux",
      connectionMode: "relay",
      runtimeKeyId: targetKeyId,
      signingPublicKeyJwk: publicJwk,
      encryptionPublicKeyJwk: publicJwk,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as {
      data: { hostToken: string; recovered: boolean };
    };
    expect(body.data.recovered).toBe(true);
    expect(body.data.hostToken).toMatch(/^rhost_v1_[A-Za-z0-9_-]{43}$/);
    expect(recoverHostCredential).toHaveBeenCalledWith(
      expect.objectContaining({
        hostId,
        organizationId,
        userId: ownerId,
        deviceId: "linux-one",
        runtimeKeyId: targetKeyId,
      }),
    );
    expect(recoverHostCredential.mock.calls[0]?.[0].hostTokenHash).not.toBe(
      body.data.hostToken,
    );
  });

  test("does not disclose a replacement token when host recovery mismatches", async () => {
    recoverHostCredential.mockResolvedValue({ kind: "mismatch" });
    const response = await request("/api/v1/remote/hosts", {
      recoveryHostId: hostId,
      deviceId: "linux-one",
      displayName: "Linux One",
      platform: "linux",
      connectionMode: "relay",
      runtimeKeyId: targetKeyId,
      signingPublicKeyJwk: publicJwk,
      encryptionPublicKeyJwk: publicJwk,
    });
    expect(response.status).toBe(409);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ code: "RECOVERY_MISMATCH" });
    expect(JSON.stringify(body)).not.toContain("rhost_v1_");
  });

  test("issues a host-bound grant and never persists the six-digit code", async () => {
    createPendingForOwnedHost.mockImplementation(async (input) => ({
      ...input,
      target_key_id: targetKeyId,
    }));
    const response = await request("/api/v1/remote/pair", {
      hostId,
      controller: {
        deviceId: "controller-one",
        keyId: controllerKeyId,
        displayName: "Controller One",
        platform: "linux",
        signingPublicKeyJwk: publicJwk,
        encryptionPublicKeyJwk: publicJwk,
      },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: {
        code: string;
        grantRevision: number;
        ownerId: string;
        targetRuntimeId: string;
        targetKeyId: string;
      };
    };
    expect(body.data.code).toMatch(/^\d{6}$/);
    expect(body.data.grantRevision).toBe(1);
    expect(body.data).toMatchObject({
      ownerId,
      targetRuntimeId: hostId,
      targetKeyId,
    });
    const persisted = createPendingForOwnedHost.mock.calls[0]?.[0];
    expect(persisted).toMatchObject({
      organization_id: organizationId,
      user_id: ownerId,
      host_id: hostId,
      grant_revision: 1,
    });
    expect(persisted.pairing_token_hash).toMatch(/^hmac-sha256-v3:/);
    expect(persisted.pairing_token_hash).not.toContain(body.data.code);
  });

  test("maps reused or expired host pairing to an oracle-safe not-found response", async () => {
    activatePendingHost.mockResolvedValue({ kind: "invalid_pairing" });
    const response = await request(
      `/api/v1/remote/sessions/${sessionId}/activate`,
      { code: "123456" },
      hostHeaders(),
    );
    expect(response.status).toBe(404);
    expect(activatePendingHost).toHaveBeenCalledWith({
      sessionId,
      hostId,
      hostToken,
      code: "123456",
      pairingSecret: "route-pairing-secret-at-least-thirty-two-bytes",
    });
  });

  test("returns a complete authoritative controller identity on activation", async () => {
    const createdAt = new Date("2026-08-22T06:30:00.000Z");
    activatePendingHost.mockResolvedValue({
      kind: "activated",
      session: {
        id: sessionId,
        grant_id: grantId,
        grant_revision: 1,
        user_id: ownerId,
        controller_device_id: "controller-one",
        controller_key_id: controllerKeyId,
        controller_display_name: "Controller One",
        controller_platform: "linux",
        controller_signing_public_jwk: publicJwk,
        controller_encryption_public_jwk: publicJwk,
        host_id: hostId,
        target_key_id: targetKeyId,
        grant_expires_at: new Date("2026-08-22T14:30:00.000Z"),
        created_at: createdAt,
        status: "active",
      },
    });
    const response = await request(
      `/api/v1/remote/sessions/${sessionId}/activate`,
      { code: "123456" },
      hostHeaders(),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        controllerDeviceId: "controller-one",
        controllerKeyId,
        controllerDisplayName: "Controller One",
        controllerPlatform: "linux",
        controllerSigningPublicKeyJwk: publicJwk,
        controllerEncryptionPublicKeyJwk: publicJwk,
        controllerCreatedAt: createdAt.toISOString(),
      },
    });
  });

  test("lists a host session with the explicit owner and complete envelope binding", async () => {
    listByOwnedHost.mockResolvedValue([
      {
        id: sessionId,
        user_id: ownerId,
        grant_id: grantId,
        grant_revision: 1,
        host_id: hostId,
        status: "active",
        requester_identity: ownerId,
        ingress_url: null,
        ingress_reason: null,
        controller_device_id: "controller-one",
        controller_key_id: controllerKeyId,
        target_key_id: targetKeyId,
        grant_expires_at: new Date(),
        created_at: new Date(),
        updated_at: new Date(),
      },
    ]);
    const response = await app.request(
      `https://api.example.test/api/v1/remote/sessions?hostId=${hostId}`,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        sessions: [
          {
            id: sessionId,
            ownerId,
            grantId,
            grantRevision: 1,
            hostId,
            controllerKeyId,
            targetKeyId,
          },
        ],
      },
    });
    expect(listByOwnedHost).toHaveBeenCalledWith(
      hostId,
      organizationId,
      ownerId,
    );
  });

  test("rejects malformed envelopes and authenticated-owner mismatches before persistence", async () => {
    const malformed = await request(
      `/api/v1/remote/sessions/${sessionId}/commands`,
      {
        envelope: { messageKind: "command" },
      },
    );
    expect(malformed.status).toBe(400);
    expect(enqueue).not.toHaveBeenCalled();

    const foreign = await request(
      `/api/v1/remote/sessions/${sessionId}/commands`,
      {
        envelope: envelope("command", "another-owner"),
      },
    );
    expect(foreign.status).toBe(404);
    expect(enqueue).not.toHaveBeenCalled();
  });

  test("maps replay and sequence gaps to stable conflict codes", async () => {
    enqueue.mockResolvedValueOnce({ kind: "replay" }).mockResolvedValueOnce({
      kind: "sequence_gap",
    });
    const replay = await request(
      `/api/v1/remote/sessions/${sessionId}/commands`,
      {
        envelope: envelope("command"),
      },
    );
    expect(replay.status).toBe(409);
    await expect(replay.json()).resolves.toMatchObject({ code: "REPLAY" });
    const gap = await request(`/api/v1/remote/sessions/${sessionId}/commands`, {
      envelope: envelope("command"),
    });
    expect(gap.status).toBe(409);
    await expect(gap.json()).resolves.toMatchObject({ code: "SEQUENCE_GAP" });
  });

  test("requires host auth for claims and returns only an opaque claimed envelope", async () => {
    const unauthorized = await app.request(
      `https://api.example.test/api/v1/remote/sessions/${sessionId}/commands`,
    );
    expect(unauthorized.status).toBe(401);
    claimNext.mockResolvedValue({
      kind: "claimed",
      command: {
        command_id: commandId,
        sequence: 1,
        envelope: envelope("command"),
        attempts: 1,
        claim_token: claimToken,
        claim_expires_at: new Date(),
      },
      session: {},
    });
    const claimed = await app.request(
      `https://api.example.test/api/v1/remote/sessions/${sessionId}/commands`,
      { headers: hostHeaders() },
    );
    expect(claimed.status).toBe(200);
    await expect(claimed.json()).resolves.toMatchObject({
      data: {
        claimAttempt: 1,
        claimToken,
        envelope: { messageKind: "command" },
      },
    });
  });

  test("reports stale starts and post-start ambiguous completion distinctly", async () => {
    recordStart.mockResolvedValue({ kind: "claim_lost" });
    const stale = await request(
      `/api/v1/remote/sessions/${sessionId}/commands/${commandId}/start`,
      { claimAttempt: 1, claimToken, envelope: envelope("start_receipt") },
      hostHeaders(),
    );
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toMatchObject({ code: "CLAIM_LOST" });

    complete.mockResolvedValue({ kind: "execution_ambiguous", command: {} });
    const ambiguous = await request(
      `/api/v1/remote/sessions/${sessionId}/commands/${commandId}/complete`,
      { claimAttempt: 1, claimToken, envelope: envelope("result") },
      hostHeaders(),
    );
    expect(ambiguous.status).toBe(409);
    await expect(ambiguous.json()).resolves.toMatchObject({
      code: "EXECUTION_AMBIGUOUS",
    });
  });

  test("returns idempotent host revocation and bounded-cleanup progress", async () => {
    revokeHost.mockResolvedValue({
      host: { id: hostId, status: "revoked" },
      alreadyRevoked: true,
      cleanup: { sessions: 100, commands: 500, more: true },
    });
    const response = await request(`/api/v1/remote/hosts/${hostId}/revoke`, {});
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        alreadyRevoked: true,
        cleanup: { sessions: 100, commands: 500, more: true },
      },
    });
    expect(revokeHost).toHaveBeenCalledWith(hostId, organizationId, ownerId);
  });

  test("lets a host bearer revoke only its bound host for native cleanup", async () => {
    requireUserOrApiKeyWithOrg.mockClear();
    revokeAuthenticatedHost.mockResolvedValue({
      host: { id: hostId, status: "revoked" },
      alreadyRevoked: false,
      cleanup: { sessions: 1, commands: 2, more: false },
    });
    const response = await request(
      `/api/v1/remote/hosts/${hostId}/revoke`,
      {},
      hostHeaders(),
    );
    expect(response.status).toBe(200);
    expect(revokeAuthenticatedHost).toHaveBeenCalledWith(hostId, hostToken);
    expect(requireUserOrApiKeyWithOrg).not.toHaveBeenCalled();

    const wrongHost = "40000000-0000-4000-8000-000000000002";
    const rejected = await request(
      `/api/v1/remote/hosts/${wrongHost}/revoke`,
      {},
      hostHeaders(),
    );
    expect(rejected.status).toBe(404);
    expect(revokeAuthenticatedHost).toHaveBeenCalledTimes(1);
  });

  test("completes managed-network cleanup only after bounded relay cleanup", async () => {
    revokeHost.mockResolvedValue({
      host: {
        id: hostId,
        organization_id: organizationId,
        user_id: ownerId,
        status: "revoked",
        headscale_hostname: "eliza-host-one",
        headscale_preauth_key_id: "123",
        headscale_cleanup_pending: true,
        created_at: new Date(0),
      },
      alreadyRevoked: true,
      cleanup: { sessions: 0, commands: 0, more: false },
    });
    listNodesStrict.mockResolvedValue([
      {
        id: "9",
        name: "eliza-host-one",
        createdAt: new Date(0).toISOString(),
      },
    ]);
    const response = await request(
      `/api/v1/remote/hosts/${hostId}/revoke`,
      {},
      {},
      {
        HEADSCALE_API_URL: "https://headscale-staging.example",
        HEADSCALE_PUBLIC_URL: "https://headscale-staging.example",
        HEADSCALE_API_KEY: "headscale-api-secret",
      },
    );
    expect(response.status).toBe(200);
    expect(expirePreAuthKey).toHaveBeenCalledWith("123");
    expect(deleteNode).toHaveBeenCalledWith("9");
    expect(deletePreAuthKey).toHaveBeenCalledWith("123");
    expect(completeManagedCleanup).toHaveBeenCalledWith(
      expect.objectContaining({ hostId, organizationId, userId: ownerId }),
    );
  });
});
