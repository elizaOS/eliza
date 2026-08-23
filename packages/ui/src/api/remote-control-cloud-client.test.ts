/** Contract validation for owner-scoped remote host and pairing responses. */
import { ElizaError } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";

import {
  RemoteCloudRequestError,
  RemoteControlAuthenticationRequiredError,
  RemoteControlCloudClient,
} from "./remote-control-cloud-client";

const PUBLIC_JWK = {
  kty: "EC",
  crv: "P-256",
  x: "A".repeat(43),
  y: "B".repeat(43),
} satisfies JsonWebKey;
const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const HOST_ID = "22222222-2222-4222-8222-222222222222";
const SESSION_ID = "33333333-3333-4333-8333-333333333333";
const GRANT_ID = "44444444-4444-4444-8444-444444444444";

function response(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ success: status < 400, data }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("RemoteControlCloudClient", () => {
  it("uses typed authentication failures for missing and rejected owner credentials", async () => {
    expect(
      () =>
        new RemoteControlCloudClient({
          baseUrl: "https://cloud.example",
          authToken: "",
        }),
    ).toThrow(RemoteControlAuthenticationRequiredError);

    const client = new RemoteControlCloudClient({
      baseUrl: "https://cloud.example",
      authToken: "expired-token",
      request: vi.fn().mockResolvedValue(response({}, 401)),
    });
    await expect(client.listHosts()).rejects.toBeInstanceOf(
      RemoteCloudRequestError,
    );
  });

  it("requires the authenticated owner bootstrap and strips no host authority fields", async () => {
    const request = vi.fn().mockResolvedValue(
      response({
        ownerId: OWNER_ID,
        hosts: [
          {
            id: HOST_ID,
            deviceId: "device-1",
            displayName: "Studio Mac",
            platform: "macos",
            connectionMode: "relay",
            runtimeKeyId: "target-key-1",
            signingPublicKeyJwk: PUBLIC_JWK,
            encryptionPublicKeyJwk: PUBLIC_JWK,
            status: "pending",
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
      ownerId: OWNER_ID,
      hosts: [{ id: HOST_ID, runtimeKeyId: "target-key-1", status: "pending" }],
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
          ownerId: OWNER_ID,
          hosts: [
            {
              id: HOST_ID,
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
          ownerId: OWNER_ID,
          sessionId: SESSION_ID,
          grantId: GRANT_ID,
          grantRevision: 1,
          targetRuntimeId: HOST_ID,
          targetKeyId: "target-key-1",
          code: "123456",
          expiresAt,
          grantExpiresAt: "2026-08-23T00:00:00.000Z",
          status: "pending",
        }),
      ),
    });
    const receipt = await client.createPairing({
      hostId: HOST_ID,
      controller: {
        version: 1,
        role: "controller",
        ownerId: OWNER_ID,
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

  it("rejects unknown host state and malformed Cloud dates", async () => {
    const client = new RemoteControlCloudClient({
      baseUrl: "https://cloud.example",
      authToken: "token",
      request: vi.fn().mockResolvedValue(
        response({
          ownerId: OWNER_ID,
          hosts: [
            {
              id: HOST_ID,
              deviceId: "device-1",
              displayName: "Hostile host",
              platform: "linux",
              connectionMode: "relay",
              runtimeKeyId: "key-1",
              signingPublicKeyJwk: PUBLIC_JWK,
              encryptionPublicKeyJwk: PUBLIC_JWK,
              status: "compromised",
              createdAt: "not-a-date",
            },
          ],
        }),
      ),
    });

    await expect(client.listHosts()).rejects.toThrow("invalid host status");
  });

  it("rejects sessions cross-bound to another host", async () => {
    const otherHostId = "55555555-5555-4555-8555-555555555555";
    const client = new RemoteControlCloudClient({
      baseUrl: "https://cloud.example",
      authToken: "token",
      request: vi.fn().mockResolvedValue(
        response({
          sessions: [
            {
              id: SESSION_ID,
              ownerId: OWNER_ID,
              grantId: GRANT_ID,
              grantRevision: 1,
              hostId: otherHostId,
              targetRuntimeId: otherHostId,
              status: "active",
              controllerDeviceId: "device-1",
              controllerKeyId: "controller-key-1",
              targetKeyId: "target-key-1",
              grantExpiresAt: "2026-08-23T00:00:00.000Z",
              createdAt: "2026-08-22T00:00:00.000Z",
              updatedAt: "2026-08-22T00:00:00.000Z",
            },
          ],
        }),
      ),
    });

    await expect(client.listSessions(HOST_ID)).rejects.toThrow(
      "different host",
    );
  });

  it("drains every host revocation cleanup page before resolving", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          id: HOST_ID,
          status: "revoked",
          cleanup: { sessions: 100, commands: 500, more: true },
        }),
      )
      .mockResolvedValueOnce(
        response({
          id: HOST_ID,
          status: "revoked",
          cleanup: { sessions: 2, commands: 7, more: false },
        }),
      );
    const client = new RemoteControlCloudClient({
      baseUrl: "https://cloud.example",
      authToken: "token",
      request,
    });

    await expect(client.revokeHost(HOST_ID)).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenNthCalledWith(
      1,
      `https://cloud.example/api/v1/remote/hosts/${HOST_ID}/revoke`,
      expect.objectContaining({ method: "POST" }),
    );
    expect(request).toHaveBeenNthCalledWith(
      2,
      `https://cloud.example/api/v1/remote/hosts/${HOST_ID}/revoke`,
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("rejects missing cleanup progress instead of finalizing locally", async () => {
    const client = new RemoteControlCloudClient({
      baseUrl: "https://cloud.example",
      authToken: "token",
      request: vi
        .fn()
        .mockResolvedValue(response({ id: HOST_ID, status: "revoked" })),
    });

    const failure = await client.revokeHost(HOST_ID).catch((cause) => cause);
    expect(failure).toBeInstanceOf(ElizaError);
    expect(failure).toMatchObject({
      code: "REMOTE_HOST_CLEANUP_PROGRESS_INVALID",
      context: { hostId: HOST_ID, reason: "malformed_response" },
    });
  });

  it("rejects a non-progressing continuation instead of looping", async () => {
    const request = vi.fn().mockResolvedValue(
      response({
        id: HOST_ID,
        status: "revoked",
        cleanup: { sessions: 0, commands: 0, more: true },
      }),
    );
    const client = new RemoteControlCloudClient({
      baseUrl: "https://cloud.example",
      authToken: "token",
      request,
    });

    const failure = await client.revokeHost(HOST_ID).catch((cause) => cause);
    expect(failure).toBeInstanceOf(ElizaError);
    expect(failure).toMatchObject({
      code: "REMOTE_HOST_CLEANUP_PROGRESS_INVALID",
      context: { hostId: HOST_ID, reason: "non_progressing_page" },
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("rejects relay envelopes that are malformed or bound to another command", async () => {
    const client = new RemoteControlCloudClient({
      baseUrl: "https://cloud.example",
      authToken: "token",
      request: vi.fn().mockResolvedValue(
        response({
          status: "completed",
          startReceipt: null,
          resultEnvelope: {
            messageKind: "result",
            sessionId: SESSION_ID,
            commandId: "different-command",
          },
        }),
      ),
    });

    await expect(
      client.readCommand({ sessionId: SESSION_ID, commandId: "command-1" }),
    ).rejects.toThrow("invalid result envelope");
  });
});
