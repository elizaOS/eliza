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
const requirePaidRouteStanding = mock(async () => ({
  user: await requireUserOrApiKeyWithOrg(),
  apiKeyId: null,
  authSource: "combined_cache",
  appScopeId: null,
}));
const getCurrentUser = mock(async () => null);
const createOwned = mock();
const recoverHostCredential = mock();
const listOwned = mock();
const revokeHost = mock();
const revokeAuthenticatedHost = mock();
const authenticateManagedEnrollment = mock();
const activateManagedEnrollment = mock();
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
const createPendingForAuthenticatedHost = mock();
const claimPendingHostForOwner = mock();
const readAuthenticatedHostPairing = mock();
const confirmClaimedHost = mock();
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
  getCurrentUser,
  requireUserOrApiKeyWithOrg,
}));
mock.module("@/api-app/lib/paid-route-standing", () => ({
  requirePaidRouteStanding,
}));
mock.module("@/db/repositories/remote-hosts", () => ({
  remoteHostsRepository: {
    createOwned,
    recoverCredential: recoverHostCredential,
    listOwned,
    revoke: revokeHost,
    revokeAuthenticated: revokeAuthenticatedHost,
    authenticateManagedEnrollment,
    activateManagedEnrollment,
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
    createPendingForAuthenticatedHost,
    claimPendingHostForOwner,
    readAuthenticatedHostPairing,
    confirmClaimedHost,
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
  getRequestIp: () => "203.0.113.1",
  rateLimit: (config: (typeof activationRateLimitConfigs)[number]) => {
    activationRateLimitConfigs.push(config);
    return async (_context: unknown, next: () => Promise<void>) => next();
  },
}));

const { default: hostsRoute } = await import("./hosts/route");
const { default: hostRevokeRoute } = await import("./hosts/[id]/revoke/route");
const { default: managedNetworkActivateRoute } = await import(
  "./hosts/[id]/managed-network/activate/route"
);
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
const { authMiddleware } = await import("../../src/middleware/auth");
const { cookieMutationGuardMiddleware } = await import(
  "../../src/middleware/cookie-mutation-guard"
);

const app = new Hono<AppEnv>();
app.route("/api/v1/remote/hosts", hostsRoute);
app.route("/api/v1/remote/hosts/:id/revoke", hostRevokeRoute);
app.route(
  "/api/v1/remote/hosts/:id/managed-network/activate",
  managedNetworkActivateRoute,
);
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

const productionActivationApp = new Hono<AppEnv>();
productionActivationApp.use("*", authMiddleware);
productionActivationApp.use("*", cookieMutationGuardMiddleware);
productionActivationApp.route(
  "/api/v1/remote/hosts/:id/managed-network/activate",
  managedNetworkActivateRoute,
);
productionActivationApp.route(
  "/api/v1/remote/sessions/activate",
  activateByCodeRoute,
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
  bindings: Partial<AppEnv["Bindings"]> = {},
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
      ...bindings,
    } as AppEnv["Bindings"],
  );
}

function productionActivationRequest(
  path: string,
  body: unknown = undefined,
  headers: Record<string, string> = hostHeaders(),
) {
  return productionActivationApp.fetch(
    new Request(`https://api.example.test${path}`, {
      method: "POST",
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    {
      NODE_ENV: "production",
      REMOTE_PAIRING_HMAC_SECRET:
        "route-pairing-secret-at-least-thirty-two-bytes",
    } as AppEnv["Bindings"],
  );
}

beforeEach(() => {
  requirePaidRouteStanding.mockClear();
  for (const collaborator of [
    createOwned,
    recoverHostCredential,
    listOwned,
    revokeHost,
    revokeAuthenticatedHost,
    authenticateManagedEnrollment,
    activateManagedEnrollment,
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
    createPendingForAuthenticatedHost,
    claimPendingHostForOwner,
    readAuthenticatedHostPairing,
    confirmClaimedHost,
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
  test("reaches both activation handlers through the production auth chain", async () => {
    authenticateManagedEnrollment.mockResolvedValue(null);
    const managedResponse = await productionActivationRequest(
      `/api/v1/remote/hosts/${hostId}/managed-network/activate`,
    );
    expect(managedResponse.status).toBe(404);
    expect(authenticateManagedEnrollment).toHaveBeenCalledWith(
      hostId,
      hostToken,
    );

    activatePendingHostByCode.mockResolvedValue({ kind: "invalid_pairing" });
    const sessionResponse = await productionActivationRequest(
      "/api/v1/remote/sessions/activate",
      { code: "123456" },
    );
    expect(sessionResponse.status).toBe(404);
    expect(activatePendingHostByCode).toHaveBeenCalledWith({
      hostId,
      hostToken,
      code: "123456",
      pairingSecret: "route-pairing-secret-at-least-thirty-two-bytes",
    });
  });

  test("rejects malformed host credentials before either activation repository", async () => {
    const malformedHeaders = {
      ...hostHeaders(),
      authorization: "Bearer rhost_v1_too-short",
    };
    const managedResponse = await productionActivationRequest(
      `/api/v1/remote/hosts/${hostId}/managed-network/activate`,
      undefined,
      malformedHeaders,
    );
    const sessionResponse = await productionActivationRequest(
      "/api/v1/remote/sessions/activate",
      { code: "123456" },
      malformedHeaders,
    );
    expect(managedResponse.status).toBe(401);
    expect(sessionResponse.status).toBe(401);
    expect(authenticateManagedEnrollment).not.toHaveBeenCalled();
    expect(activatePendingHostByCode).not.toHaveBeenCalled();
  });

  test("rejects a non-relay connection mode before any host state is created", async () => {
    for (const connectionMode of ["headscale", "tunnel", "direct", "RELAY"]) {
      createOwned.mockReset();
      recoverHostCredential.mockReset();
      const response = await request("/api/v1/remote/hosts", {
        ownerId,
        deviceId: "linux-one",
        displayName: "Linux One",
        platform: "linux",
        connectionMode,
        runtimeKeyId: targetKeyId,
        signingPublicKeyJwk: publicJwk,
        encryptionPublicKeyJwk: publicJwk,
      });
      expect(response.status).toBe(400);
      expect(createOwned).not.toHaveBeenCalled();
      expect(recoverHostCredential).not.toHaveBeenCalled();
    }
  });

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

  test("standing denial creates no host credential or Headscale enrollment", async () => {
    requirePaidRouteStanding.mockRejectedValueOnce(
      new Error("Organization is inactive"),
    );

    const response = await request(
      "/api/v1/remote/hosts",
      {
        deviceId: "mac-denied",
        displayName: "Denied Mac",
        platform: "macos",
        connectionMode: "relay",
        managedNetwork: true,
        runtimeKeyId: targetKeyId,
        signingPublicKeyJwk: publicJwk,
        encryptionPublicKeyJwk: publicJwk,
      },
      {},
      "POST",
      {
        HEADSCALE_API_URL: "https://headscale-staging.example",
        HEADSCALE_PUBLIC_URL: "https://headscale-staging.example",
        HEADSCALE_API_KEY: "headscale-api-secret",
      },
    );

    expect(response.status).toBe(403);
    expect(requirePaidRouteStanding).toHaveBeenCalledTimes(1);
    expect(createOwned).not.toHaveBeenCalled();
    expect(createPreAuthKey).not.toHaveBeenCalled();
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
      "POST",
      {
        HEADSCALE_API_URL: "https://headscale-staging.example",
        HEADSCALE_PUBLIC_URL: "https://headscale-staging.example",
        HEADSCALE_API_KEY: "headscale-api-secret",
      },
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      data: {
        hostId: string;
        hostToken: string;
        status: string;
        managedNetworkEnrollment: { authKey: string; hostname: string };
      };
    };
    expect(createOwned.mock.calls[0]?.[0]).toMatchObject({ status: "pending" });
    expect(body.data.status).toBe("pending");
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
    expect(activateManagedEnrollment).not.toHaveBeenCalled();
    expect(body.data).toEqual(
      expect.objectContaining({
        hostId: body.data.hostId,
        runtimeKeyId: targetKeyId,
        status: "pending",
      }),
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
      "POST",
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
    expect(activateManagedEnrollment).not.toHaveBeenCalled();
    expect(createOwned.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ status: "pending" }),
    );
  });

  test("remains non-authoritative when enrollment and revocation both fail", async () => {
    createOwned.mockImplementation(async (input) => ({
      kind: "created",
      host: { ...input, created_at: new Date("2026-08-22T06:15:00.000Z") },
    }));
    createPreAuthKey.mockRejectedValue(new Error("Headscale unavailable"));
    revokeHost.mockRejectedValue(new Error("database unavailable"));

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
      "POST",
      {
        HEADSCALE_API_URL: "https://headscale-staging.example",
        HEADSCALE_PUBLIC_URL: "https://headscale-staging.example",
        HEADSCALE_API_KEY: "headscale-api-secret",
      },
    );

    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(createOwned.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ status: "pending" }),
    );
    expect(activateManagedEnrollment).not.toHaveBeenCalled();
    expect(revokeHost).toHaveBeenCalledTimes(1);
  });

  test("keeps the host pending when the native node has not joined", async () => {
    authenticateManagedEnrollment.mockResolvedValue({
      id: hostId,
      organization_id: organizationId,
      user_id: ownerId,
      status: "pending",
      created_at: new Date("2026-08-22T06:15:00.000Z"),
      headscale_hostname: "eliza-host-one",
      headscale_preauth_key_id: "123",
      headscale_cleanup_pending: true,
    });
    const response = await request(
      `/api/v1/remote/hosts/${hostId}/managed-network/activate`,
      {},
      hostHeaders(),
      "POST",
      {
        HEADSCALE_API_URL: "https://headscale-staging.example",
        HEADSCALE_PUBLIC_URL: "https://headscale-staging.example",
        HEADSCALE_API_KEY: "headscale-api-secret",
      },
    );

    expect(response.status).toBe(409);
    expect(activateManagedEnrollment).not.toHaveBeenCalled();
    expect(revokeHost).not.toHaveBeenCalled();
  });

  test("activates only after Headscale returns the exact fresh collision identity", async () => {
    authenticateManagedEnrollment.mockResolvedValue({
      id: hostId,
      organization_id: organizationId,
      user_id: ownerId,
      status: "pending",
      created_at: new Date("2026-08-22T06:15:00.000Z"),
      headscale_hostname: "eliza-host-one",
      headscale_preauth_key_id: "123",
      headscale_cleanup_pending: true,
    });
    listNodesStrict.mockResolvedValue([
      {
        id: "9",
        name: "eliza-host-one-cnpx9uop",
        user: { name: "tunnel" },
        createdAt: "2026-08-22T06:15:01.000Z",
      },
    ]);
    const response = await request(
      `/api/v1/remote/hosts/${hostId}/managed-network/activate`,
      {},
      hostHeaders(),
      "POST",
      {
        HEADSCALE_API_URL: "https://headscale-staging.example",
        HEADSCALE_PUBLIC_URL: "https://headscale-staging.example",
        HEADSCALE_API_KEY: "headscale-api-secret",
      },
    );
    expect(response.status).toBe(200);
    expect(activateManagedEnrollment).toHaveBeenCalledWith({
      hostId,
      organizationId,
      userId: ownerId,
      hostname: "eliza-host-one-cnpx9uop",
    });
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
    expect(body.data.hosts).toHaveLength(3);
    expect(body.data.hosts[1]).toMatchObject({
      id: "40000000-0000-4000-8000-000000000003",
      status: "pending",
    });
    expect(body.data.hosts[2]).toMatchObject({
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

  test("lets the authenticated Mac create a non-authoritative one-use controller challenge", async () => {
    const expiresAt = new Date(Date.now() + 300_000);
    const grantExpiresAt = new Date(Date.now() + 28_800_000);
    createPendingForAuthenticatedHost.mockImplementation(async (input) => ({
      id: input.id,
      organization_id: organizationId,
      user_id: ownerId,
      host_id: hostId,
      grant_id: input.grantId,
      grant_revision: 1,
      target_key_id: targetKeyId,
      expires_at: expiresAt,
      grant_expires_at: grantExpiresAt,
      status: "pending",
    }));

    const response = await request(
      "/api/v1/remote/sessions",
      undefined,
      hostHeaders(),
      "POST",
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as {
      data: { code: string; status: string; capabilities: string[] };
    };
    expect(body.data.code).toMatch(/^\d{6}$/);
    expect(body.data.status).toBe("pending");
    expect(body.data.capabilities).toEqual(["agent.status", "agent.request"]);
    expect(createPendingForAuthenticatedHost).toHaveBeenCalledWith(
      expect.objectContaining({
        hostId,
        hostToken,
        code: body.data.code,
        pairingSecret: "route-pairing-secret-at-least-thirty-two-bytes",
      }),
    );
    expect(
      createPendingForAuthenticatedHost.mock.calls[0]?.[0],
    ).not.toHaveProperty("controllerDeviceId");
  });

  test("binds an iPhone claim to the authenticated owner and waits for Mac confirmation", async () => {
    const claimedAt = new Date();
    const expiresAt = new Date(Date.now() + 300_000);
    const grantExpiresAt = new Date(Date.now() + 28_800_000);
    const claimedSession = {
      id: sessionId,
      organization_id: organizationId,
      user_id: ownerId,
      host_id: hostId,
      grant_id: grantId,
      grant_revision: 1,
      target_key_id: targetKeyId,
      expires_at: expiresAt,
      grant_expires_at: grantExpiresAt,
      status: "claimed",
      controller_device_id: "iphone-one",
      controller_key_id: controllerKeyId,
      controller_display_name: "Nubs's iPhone",
      controller_platform: "ios",
      controller_signing_public_jwk: publicJwk,
      controller_encryption_public_jwk: publicJwk,
      pairing_consumed_at: claimedAt,
    };
    claimPendingHostForOwner.mockResolvedValue({
      kind: "claimed",
      session: claimedSession,
      host: {
        id: hostId,
        device_id: "mac-one",
        display_name: "Nubs's Mac",
        platform: "macos",
        runtime_key_id: targetKeyId,
        signing_public_jwk: publicJwk,
        encryption_public_jwk: publicJwk,
        created_at: new Date("2026-08-22T06:15:00.000Z"),
      },
    });

    const response = await request("/api/v1/remote/pair", {
      sessionId,
      code: "123456",
      controller: {
        ownerId: "attacker-owner-is-ignored",
        deviceId: "iphone-one",
        keyId: controllerKeyId,
        displayName: "Nubs's iPhone",
        platform: "ios",
        signingPublicKeyJwk: publicJwk,
        encryptionPublicKeyJwk: publicJwk,
      },
    });

    expect(response.status).toBe(200);
    expect(claimPendingHostForOwner).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId,
        userId: ownerId,
        sessionId,
        code: "123456",
        controllerDeviceId: "iphone-one",
        controllerKeyId,
      }),
    );
    await expect(response.json()).resolves.toMatchObject({
      data: {
        sessionId,
        ownerId,
        status: "claimed",
        host: { id: hostId, displayName: "Nubs's Mac", platform: "macos" },
      },
    });

    readAuthenticatedHostPairing.mockResolvedValue({
      kind: "found",
      session: claimedSession,
    });
    const read = await request(
      `/api/v1/remote/sessions/${sessionId}/activate`,
      undefined,
      hostHeaders(),
      "GET",
    );
    expect(read.status).toBe(200);
    await expect(read.json()).resolves.toMatchObject({
      data: {
        status: "claimed",
        controllerDeviceId: "iphone-one",
        controllerKeyId,
        controllerDisplayName: "Nubs's iPhone",
        controllerPlatform: "ios",
      },
    });
  });

  test("fails closed on claim replay and requires explicit Mac confirmation", async () => {
    claimPendingHostForOwner.mockResolvedValue({ kind: "invalid_pairing" });
    const replay = await request("/api/v1/remote/pair", {
      sessionId,
      code: "123456",
      controller: {
        deviceId: "iphone-one",
        keyId: controllerKeyId,
        displayName: "Nubs's iPhone",
        platform: "ios",
        signingPublicKeyJwk: publicJwk,
        encryptionPublicKeyJwk: publicJwk,
      },
    });
    expect(replay.status).toBe(404);

    confirmClaimedHost.mockResolvedValue({
      kind: "activated",
      session: {
        id: sessionId,
        grant_id: grantId,
        grant_revision: 1,
        user_id: ownerId,
        host_id: hostId,
        target_key_id: targetKeyId,
        controller_device_id: "iphone-one",
        controller_key_id: controllerKeyId,
        controller_display_name: "Nubs's iPhone",
        controller_platform: "ios",
        controller_signing_public_jwk: publicJwk,
        controller_encryption_public_jwk: publicJwk,
        pairing_consumed_at: new Date("2026-08-22T06:30:00.000Z"),
        grant_expires_at: new Date("2026-08-22T14:30:00.000Z"),
        status: "activating",
      },
    });
    const confirm = await request(
      `/api/v1/remote/sessions/${sessionId}/activate`,
      undefined,
      hostHeaders(),
      "PATCH",
    );
    expect(confirm.status).toBe(200);
    expect(confirmClaimedHost).toHaveBeenCalledWith({
      sessionId,
      hostId,
      hostToken,
    });
    await expect(confirm.json()).resolves.toMatchObject({
      data: {
        status: "activating",
        controllerDeviceId: "iphone-one",
        controllerKeyId,
      },
    });
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
        user: { name: "tunnel" },
        createdAt: new Date(0).toISOString(),
      },
    ]);
    const response = await request(
      `/api/v1/remote/hosts/${hostId}/revoke`,
      {},
      {},
      "POST",
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
