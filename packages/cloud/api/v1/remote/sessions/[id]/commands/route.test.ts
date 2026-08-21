/** Relay boundary tests: authenticated owner enqueue and host-only claim. */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "@/types/cloud-worker-env";

const enqueue = mock();
const claimNext = mock();
const authenticate = mock();
const requireUserOrApiKeyWithOrg = mock(async () => ({
  id: "11111111-1111-4111-8111-111111111111",
  organization_id: "22222222-2222-4222-8222-222222222222",
}));

mock.module("@/db/repositories/remote-command-envelopes", () => ({
  remoteCommandEnvelopesRepository: { enqueue, claimNext },
}));
mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg,
}));
mock.module("../../../host-auth", () => ({
  authenticateRemoteHost: authenticate,
}));

const { default: route } = await import("./route");
const app = new Hono<AppEnv>();
app.route("/api/v1/remote/sessions/:id/commands", route);

const publicKey = {
  kty: "EC",
  crv: "P-256",
  x: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  y: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
};
const envelope = {
  version: 1,
  algorithm: "ECDH-P256-HKDF-SHA256+A256GCM",
  senderKeyId: "phone-key",
  recipientKeyId: "host-key",
  ephemeralPublicKeyJwk: publicKey,
  salt: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  iv: "AAAAAAAAAAAAAAAA",
  ciphertext: "AAAAAAAAAAAAAAAAAAAAAAAA",
};

describe("remote command relay route", () => {
  beforeEach(() => {
    enqueue.mockReset();
    claimNext.mockReset();
    authenticate.mockReset();
  });

  test("queues a bounded encrypted envelope without plaintext", async () => {
    enqueue.mockImplementation(async (input) => ({
      kind: "queued",
      command: { command_id: input.commandId, status: "pending" },
    }));
    const response = await app.fetch(
      new Request(
        "https://api.example.test/api/v1/remote/sessions/44444444-4444-4444-8444-444444444444/commands",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            commandId: "55555555-5555-4555-8555-555555555555",
            sequence: 1,
            expiresAt: Date.now() + 30_000,
            envelope,
          }),
        },
      ),
      {} as AppEnv["Bindings"],
    );
    expect(response.status).toBe(202);
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        sequence: 1,
        envelope: expect.objectContaining({ ciphertext: envelope.ciphertext }),
      }),
    );
    expect(JSON.stringify(enqueue.mock.calls[0]?.[0])).not.toContain("hello");
  });

  test("rejects host polling without a host-only bearer", async () => {
    authenticate.mockResolvedValue(undefined);
    const response = await app.fetch(
      new Request(
        "https://api.example.test/api/v1/remote/sessions/44444444-4444-4444-8444-444444444444/commands",
      ),
      {} as AppEnv["Bindings"],
    );
    expect(response.status).toBe(401);
    expect(claimNext).not.toHaveBeenCalled();
  });

  test("claims only for the authenticated host identity", async () => {
    authenticate.mockResolvedValue({ id: "host-1" });
    claimNext.mockResolvedValue({
      command: {
        command_id: "55555555-5555-4555-8555-555555555555",
        attempts: 3,
        sequence: 1,
        expires_at: new Date(Date.now() + 30_000),
        envelope,
      },
      session: {
        id: "44444444-4444-4444-8444-444444444444",
        user_id: "owner-1",
        host_id: "host-1",
        controller_device_id: "phone-1",
        controller_key_id: "phone-key",
        controller_display_name: "Phone",
        controller_platform: "ios",
        controller_signing_public_jwk: publicKey,
        controller_encryption_public_jwk: publicKey,
        created_at: new Date(),
      },
    });
    const response = await app.fetch(
      new Request(
        "https://api.example.test/api/v1/remote/sessions/44444444-4444-4444-8444-444444444444/commands",
      ),
      {} as AppEnv["Bindings"],
    );
    expect(response.status).toBe(200);
    expect(claimNext).toHaveBeenCalledWith(
      "44444444-4444-4444-8444-444444444444",
      "host-1",
    );
    expect(await response.json()).toEqual(
      expect.objectContaining({
        data: expect.objectContaining({ claimAttempt: 3 }),
      }),
    );
  });
});
