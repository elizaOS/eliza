/**
 * Exercises secure remote relay HTTP boundaries with deterministic persistence
 * collaborators, covering owner scope, one-use activation, replay mapping,
 * host authentication, activation compensation, start fencing, ambiguity, and
 * idempotent revocation.
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
const createPendingForOwnedAgent = mock();
const createPendingForOwnedHost = mock();
const activatePendingHost = mock();
const activatePendingHostByCode = mock();
const compensateHostActivation = mock();
const commitHostActivation = mock();
const listActiveByOwnedAgent = mock();
const listByOwnedHost = mock();
const revokeSession = mock();
const enqueue = mock();
const claimNext = mock();
const recordStart = mock();
const complete = mock();
const readOwnedResult = mock();
const activationRateLimitConfigs: Array<{
  windowMs: number;
  maxRequests: number;
  localLease?: boolean;
  failClosed?: boolean;
  keyGenerator?: (context: {
    req: { header(name: string): string | undefined };
  }) => string;
}> = [];

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
  },
}));
mock.module("@/db/repositories/remote-sessions", () => ({
  remoteSessionsRepository: {
    createPendingForOwnedAgent,
    createPendingForOwnedHost,
    activatePendingHost,
    activatePendingHostByCode,
    compensateHostActivation,
    commitHostActivation,
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
mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  getIpKey: () => "ip:test-source",
  rateLimit: (config: (typeof activationRateLimitConfigs)[number]) => {
    activationRateLimitConfigs.push(config);
    return async (_context: unknown, next: () => Promise<void>) => next();
  },
}));

const { default: hostsRoute } = await import("./hosts/route");
const { default: hostRevokeRoute } = await import("./hosts/[id]/revoke/route");
const { default: pairRoute } = await import("./pair/route");
const { default: sessionsRoute } = await import("./sessions/route");
const { default: activateRoute } = await import(
  "./sessions/[id]/activate/route"
);
const activateByCodeModule = await import("./sessions/activate/route");
const activateByCodeRoute = activateByCodeModule.default;
const { activationRouteInternals } = activateByCodeModule;
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
app.route("/api/v1/remote/sessions/activate", activateByCodeRoute);
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
  body: unknown = undefined,
  headers: Record<string, string> = {},
  method = "POST",
) {
  return app.fetch(
    new Request(`https://api.example.test${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    {
      REMOTE_PAIRING_HMAC_SECRET:
        "route-pairing-secret-at-least-thirty-two-bytes",
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
    createPendingForOwnedAgent,
    createPendingForOwnedHost,
    activatePendingHost,
    activatePendingHostByCode,
    compensateHostActivation,
    commitHostActivation,
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
        status: "activating",
        last_seen_at: new Date(),
        created_at: new Date(),
        revoked_at: null,
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

  test("commits only the exact host-authenticated staged activation and maps replay", async () => {
    commitHostActivation.mockResolvedValueOnce({
      kind: "committed",
      session: { id: sessionId, status: "active" },
      alreadyCommitted: false,
    });
    const first = await request(
      `/api/v1/remote/sessions/${sessionId}/activate`,
      undefined,
      hostHeaders(),
      "PUT",
    );
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toEqual({
      success: true,
      data: { sessionId, status: "active", alreadyCommitted: false },
    });
    expect(commitHostActivation).toHaveBeenCalledWith({
      sessionId,
      hostId,
      hostToken,
    });

    commitHostActivation.mockResolvedValueOnce({
      kind: "committed",
      session: { id: sessionId, status: "active" },
      alreadyCommitted: true,
    });
    const replay = await request(
      `/api/v1/remote/sessions/${sessionId}/activate`,
      undefined,
      hostHeaders(),
      "PUT",
    );
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({
      data: { alreadyCommitted: true },
    });

    commitHostActivation.mockResolvedValueOnce({ kind: "conflict" });
    const conflict = await request(
      `/api/v1/remote/sessions/${sessionId}/activate`,
      undefined,
      hostHeaders(),
      "PUT",
    );
    expect(conflict.status).toBe(409);
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
        status: "activating",
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
        status: "activating",
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

  test("compensates only the exact host-authenticated activation and maps replay", async () => {
    compensateHostActivation.mockResolvedValueOnce({
      kind: "compensated",
      session: { id: sessionId, status: "revoked" },
      alreadyCompensated: false,
    });
    const first = await request(
      `/api/v1/remote/sessions/${sessionId}/activate`,
      undefined,
      hostHeaders(),
      "DELETE",
    );
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toEqual({
      success: true,
      data: { sessionId, status: "revoked", alreadyCompensated: false },
    });
    expect(compensateHostActivation).toHaveBeenCalledWith({
      sessionId,
      hostId,
      hostToken,
    });

    compensateHostActivation.mockResolvedValueOnce({
      kind: "compensated",
      session: { id: sessionId, status: "revoked" },
      alreadyCompensated: true,
    });
    const replay = await request(
      `/api/v1/remote/sessions/${sessionId}/activate`,
      undefined,
      hostHeaders(),
      "DELETE",
    );
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({
      data: { alreadyCompensated: true },
    });

    compensateHostActivation.mockResolvedValueOnce({ kind: "conflict" });
    const conflict = await request(
      `/api/v1/remote/sessions/${sessionId}/activate`,
      undefined,
      hostHeaders(),
      "DELETE",
    );
    expect(conflict.status).toBe(409);

    compensateHostActivation.mockRejectedValueOnce(
      new Error("compensation-storage-unavailable"),
    );
    const unavailable = await request(
      `/api/v1/remote/sessions/${sessionId}/activate`,
      undefined,
      hostHeaders(),
      "DELETE",
    );
    expect(unavailable.status).toBe(500);
    await expect(unavailable.json()).resolves.toMatchObject({ success: false });
  });

  test("discovers a pairing session by code only through the authenticated host", async () => {
    const createdAt = new Date("2026-08-22T06:30:00.000Z");
    activatePendingHostByCode.mockResolvedValue({
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
      "/api/v1/remote/sessions/activate",
      { code: "123456" },
      hostHeaders(),
    );
    expect(response.status).toBe(200);
    expect(activatePendingHostByCode).toHaveBeenCalledWith({
      hostId,
      hostToken,
      code: "123456",
      pairingSecret: "route-pairing-secret-at-least-thirty-two-bytes",
    });
    await expect(response.json()).resolves.toMatchObject({
      data: {
        sessionId,
        targetRuntimeId: hostId,
        controllerKeyId,
        status: "active",
      },
    });
  });

  test("does not expose code-only discovery without exact host authentication", async () => {
    const unauthorized = await request("/api/v1/remote/sessions/activate", {
      code: "123456",
    });
    expect(unauthorized.status).toBe(401);
    expect(activatePendingHostByCode).not.toHaveBeenCalled();

    activatePendingHostByCode.mockResolvedValue({ kind: "invalid_pairing" });
    const invalid = await request(
      "/api/v1/remote/sessions/activate",
      { code: "123456" },
      hostHeaders(),
    );
    expect(invalid.status).toBe(404);
    await expect(invalid.json()).resolves.toMatchObject({
      error: "Pairing session not found or invalid",
    });
  });

  test("bounds activation JSON by exact bytes and accepts only the exact code schema", async () => {
    const oversized = await request(
      "/api/v1/remote/sessions/activate",
      { code: "123456", padding: "x".repeat(80) },
      hostHeaders(),
    );
    expect(oversized.status).toBe(413);

    const extraField = await request(
      "/api/v1/remote/sessions/activate",
      { code: "123456", extra: true },
      hostHeaders(),
    );
    expect(extraField.status).toBe(400);
    expect(activatePendingHostByCode).not.toHaveBeenCalled();

    const atLimit = await activationRouteInternals.readActivationBody(
      new Request("https://api.example.test/activate", {
        method: "POST",
        body: JSON.stringify("x".repeat(62)),
      }),
    );
    expect(atLimit.kind).toBe("ok");
    const overLimit = await activationRouteInternals.readActivationBody(
      new Request("https://api.example.test/activate", {
        method: "POST",
        body: JSON.stringify("x".repeat(63)),
      }),
    );
    expect(overLimit.kind).toBe("too_large");
  });

  test("installs fail-closed shared throttles for both source and host", () => {
    expect(activationRateLimitConfigs).toHaveLength(2);
    expect(activationRateLimitConfigs).toEqual([
      expect.objectContaining({
        windowMs: 300_000,
        maxRequests: 20,
        localLease: false,
        failClosed: true,
      }),
      expect.objectContaining({
        windowMs: 300_000,
        maxRequests: 5,
        localLease: false,
        failClosed: true,
      }),
    ]);
    const context = {
      req: {
        header: (name: string) =>
          name === "x-remote-host-id" ? hostId : undefined,
      },
    };
    expect(activationRateLimitConfigs[0]?.keyGenerator?.(context)).toBe(
      "remote-activation:source:ip:test-source",
    );
    expect(activationRateLimitConfigs[1]?.keyGenerator?.(context)).toBe(
      `remote-activation:host:${hostId}`,
    );
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
});
