/**
 * Exercises the real remote-pair route boundary with deterministic repository
 * collaborators and WebCrypto-backed pairing-code verifiers.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import {
  deriveRemotePairingCodeVerifier,
  isRemotePairingSessionCurrent,
  isRemotePairingVerifierCurrent,
  verifyRemotePairingCodeVerifier,
} from "@/db/crypto/remote-pairing-code";
import type { AppEnv } from "@/types/cloud-worker-env";

const requireUserOrApiKeyWithOrg = mock(async () => ({
  id: userId,
  organization_id: organizationId,
}));
const createPendingForOwnedAgent = mock();

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg,
}));

mock.module("@/db/repositories/remote-sessions", () => ({
  remoteSessionsRepository: { createPendingForOwnedAgent },
}));

const { default: pairingRoute } = await import("./route");

const app = new Hono<AppEnv>();
app.route("/api/v1/remote/pair", pairingRoute);

const secret = "a-dedicated-remote-pairing-secret-with-32-bytes";
const userId = "11111111-1111-4111-8111-111111111111";
const organizationId = "22222222-2222-4222-8222-222222222222";
const agentId = "33333333-3333-4333-8333-333333333333";

function verifierContext(sessionId: string) {
  return { organizationId, userId, agentId, sessionId };
}

async function postPair(
  body: string,
  bindings: Partial<AppEnv["Bindings"]> = {
    REMOTE_PAIRING_HMAC_SECRET: secret,
  },
) {
  return app.fetch(
    new Request("https://api.example.test/api/v1/remote/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    }),
    bindings as AppEnv["Bindings"],
  );
}

describe("remote pairing route", () => {
  beforeEach(() => {
    requireUserOrApiKeyWithOrg.mockClear();
    createPendingForOwnedAgent.mockReset();
    createPendingForOwnedAgent.mockImplementation(async (data) => ({
      ...data,
      created_at: new Date(),
      updated_at: new Date(),
      ended_at: null,
      ingress_url: null,
      ingress_reason: null,
    }));
  });

  test("binds a short-lived keyed verifier to the authenticated owner and session", async () => {
    const startedAt = Date.now();
    const response = await postPair(
      JSON.stringify({ agentId, requesterIdentity: "attacker-controlled" }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const body = (await response.json()) as {
      data: {
        sessionId: string;
        code: string;
        expiresAt: string;
        ttlSeconds: number;
      };
    };
    expect(body.data.code).toMatch(/^\d{6}$/);
    expect(body.data.ttlSeconds).toBe(300);
    expect(Date.parse(body.data.expiresAt)).toBeGreaterThanOrEqual(
      startedAt + 299_000,
    );

    expect(createPendingForOwnedAgent).toHaveBeenCalledTimes(1);
    const persisted = createPendingForOwnedAgent.mock.calls[0]?.[0] as {
      id: string;
      requester_identity: string;
      pairing_token_hash: string;
    };
    expect(persisted.id).toBe(body.data.sessionId);
    expect(persisted.requester_identity).toBe(
      "11111111-1111-4111-8111-111111111111",
    );
    expect(persisted.pairing_token_hash).toBe(
      await deriveRemotePairingCodeVerifier(
        secret,
        verifierContext(body.data.sessionId),
        body.data.code,
        new Date(body.data.expiresAt),
      ),
    );
    expect(persisted.pairing_token_hash).toMatch(
      /^hmac-sha256-v2:\d{13}:[0-9a-f]{64}$/,
    );
    expect(persisted.pairing_token_hash).not.toBe(body.data.code);
  });

  test("binds the verifier to every authority identity and dedicated secret", async () => {
    const expiry = new Date("2026-08-18T20:00:00.000Z");
    const context = verifierContext("44444444-4444-4444-8444-444444444444");
    const first = await deriveRemotePairingCodeVerifier(
      secret,
      context,
      "123456",
      expiry,
    );
    const otherSession = await deriveRemotePairingCodeVerifier(
      secret,
      { ...context, sessionId: "55555555-5555-4555-8555-555555555555" },
      "123456",
      expiry,
    );
    const otherSecret = await deriveRemotePairingCodeVerifier(
      "another-dedicated-remote-pairing-secret-value",
      context,
      "123456",
      expiry,
    );

    expect(first).toMatch(/^hmac-sha256-v2:\d{13}:[0-9a-f]{64}$/);
    expect(otherSession).not.toBe(first);
    expect(otherSecret).not.toBe(first);
    for (const changedContext of [
      { ...context, organizationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
      { ...context, userId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
      { ...context, agentId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" },
    ]) {
      expect(
        await verifyRemotePairingCodeVerifier(
          secret,
          changedContext,
          "123456",
          first,
          new Date(expiry.getTime() - 1),
        ),
      ).toBe(false);
    }
    expect(isRemotePairingVerifierCurrent(first, expiry.getTime() - 1)).toBe(
      true,
    );
    expect(isRemotePairingVerifierCurrent(first, expiry.getTime())).toBe(false);
    expect(
      isRemotePairingSessionCurrent("pending", first, expiry.getTime() - 1),
    ).toBe(true);
    expect(
      isRemotePairingSessionCurrent("pending", first, expiry.getTime()),
    ).toBe(false);
    expect(
      isRemotePairingSessionCurrent(
        "pending",
        "0f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f",
        expiry.getTime() - 1,
      ),
    ).toBe(false);
    expect(
      isRemotePairingSessionCurrent("active", null, expiry.getTime()),
    ).toBe(true);
    expect(
      await verifyRemotePairingCodeVerifier(
        secret,
        context,
        "123456",
        first,
        new Date(expiry.getTime() - 1),
      ),
    ).toBe(true);
    expect(
      await verifyRemotePairingCodeVerifier(
        secret,
        context,
        "123457",
        first,
        new Date(expiry.getTime() - 1),
      ),
    ).toBe(false);
    expect(
      await verifyRemotePairingCodeVerifier(
        secret,
        context,
        "123456",
        first,
        expiry,
      ),
    ).toBe(false);
    expect(
      await verifyRemotePairingCodeVerifier(
        secret,
        context,
        "123456",
        first,
        new Date(Number.NaN),
      ),
    ).toBe(false);
    await expect(
      verifyRemotePairingCodeVerifier(
        "too-short",
        context,
        "123456",
        first,
        new Date(expiry.getTime() - 1),
      ),
    ).rejects.toThrow("REMOTE_PAIRING_HMAC_SECRET");
  });

  test("fails closed before creating state when the dedicated secret is absent", async () => {
    const response = await postPair(JSON.stringify({ agentId }), {});

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      code: "REMOTE_PAIRING_NOT_CONFIGURED",
    });
    expect(createPendingForOwnedAgent).not.toHaveBeenCalled();
  });

  test("rejects malformed JSON without fabricating an empty request", async () => {
    const response = await postPair("{");

    expect(response.status).toBe(400);
    expect(createPendingForOwnedAgent).not.toHaveBeenCalled();
  });

  test("rejects a malformed agent identifier before deriving or persisting authority", async () => {
    const response = await postPair(JSON.stringify({ agentId: "not-a-uuid" }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: "agentId must be a UUID",
    });
    expect(createPendingForOwnedAgent).not.toHaveBeenCalled();
  });

  test("does not create a pairing session for another organization agent", async () => {
    createPendingForOwnedAgent.mockResolvedValue(undefined);

    const response = await postPair(JSON.stringify({ agentId }));

    expect(response.status).toBe(404);
    expect(createPendingForOwnedAgent).toHaveBeenCalledTimes(1);
  });

  test("does not create a pairing session for another user in the organization", async () => {
    createPendingForOwnedAgent.mockResolvedValue(undefined);

    const response = await postPair(JSON.stringify({ agentId }));

    expect(response.status).toBe(404);
    expect(createPendingForOwnedAgent).toHaveBeenCalledTimes(1);
  });
});
