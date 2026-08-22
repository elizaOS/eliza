/** Contract validation for owner-scoped remote host and pairing responses. */
import { describe, expect, it, vi } from "vitest";

import { RemoteControlCloudClient } from "./remote-control-cloud-client";

const PUBLIC_JWK = {
  kty: "EC",
  crv: "P-256",
  x: "x-coordinate",
  y: "y-coordinate",
} satisfies JsonWebKey;

function response(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ success: status < 400, data }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("RemoteControlCloudClient", () => {
  it("requires the authenticated owner bootstrap and strips no host authority fields", async () => {
    const request = vi.fn().mockResolvedValue(
      response({
        ownerId: "owner-1",
        hosts: [
          {
            id: "host-1",
            deviceId: "device-1",
            displayName: "Studio Mac",
            platform: "macos",
            connectionMode: "relay",
            runtimeKeyId: "target-key-1",
            signingPublicKeyJwk: PUBLIC_JWK,
            encryptionPublicKeyJwk: PUBLIC_JWK,
            status: "active",
            lastSeenAt: null,
            createdAt: "2026-08-22T00:00:00.000Z",
            revokedAt: null,
          },
        ],
      }),
    );
    const client = new RemoteControlCloudClient({
      baseUrl: "https://cloud.example",
      authToken: "owner-token",
      request,
    });

    await expect(client.listHosts()).resolves.toMatchObject({
      ownerId: "owner-1",
      hosts: [{ id: "host-1", runtimeKeyId: "target-key-1" }],
    });
    expect(request).toHaveBeenCalledWith(
      "https://cloud.example/api/v1/remote/hosts",
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer owner-token",
        }),
      }),
    );
  });

  it("rejects a Cloud response that exposes private JWK material", async () => {
    const client = new RemoteControlCloudClient({
      baseUrl: "https://cloud.example",
      authToken: "token",
      request: vi.fn().mockResolvedValue(
        response({
          ownerId: "owner-1",
          hosts: [
            {
              id: "host-1",
              deviceId: "device-1",
              displayName: "Compromised host",
              platform: "linux",
              connectionMode: "relay",
              runtimeKeyId: "key-1",
              signingPublicKeyJwk: { ...PUBLIC_JWK, d: "private" },
              encryptionPublicKeyJwk: PUBLIC_JWK,
              status: "active",
              createdAt: "2026-08-22T00:00:00.000Z",
            },
          ],
        }),
      ),
    });
    await expect(client.listHosts()).rejects.toThrow("invalid signing key");
  });

  it("validates the independent six-digit pairing code and derives a TTL when omitted", async () => {
    const expiresAt = new Date(Date.now() + 300_000).toISOString();
    const client = new RemoteControlCloudClient({
      baseUrl: "https://cloud.example",
      authToken: "token",
      request: vi.fn().mockResolvedValue(
        response({
          ownerId: "owner-1",
          sessionId: "session-1",
          grantId: "grant-1",
          grantRevision: 1,
          targetRuntimeId: "host-1",
          targetKeyId: "target-key-1",
          code: "123456",
          expiresAt,
          grantExpiresAt: "2026-08-23T00:00:00.000Z",
          status: "pending",
        }),
      ),
    });
    const receipt = await client.createPairing({
      hostId: "host-1",
      controller: {
        version: 1,
        role: "controller",
        ownerId: "owner-1",
        deviceId: "device-1",
        keyId: "controller-key-1",
        displayName: "My Linux computer",
        platform: "linux",
        signingPublicKeyJwk: PUBLIC_JWK,
        encryptionPublicKeyJwk: PUBLIC_JWK,
        createdAt: 1,
      },
    });
    expect(receipt.code).toBe("123456");
    expect(receipt.ttlSeconds).toBeGreaterThanOrEqual(299);
    expect(receipt.ttlSeconds).toBeLessThanOrEqual(300);
  });
});
