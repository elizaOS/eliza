/**
 * Verifies the target's native trust boundaries: strict loopback execution,
 * streamed response limits, crash-recovery enrollment, and secure-store
 * tamper rejection. All networking and credential stores are deterministic.
 */
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
  PlatformSecureStore,
  SecureStoreDeleteResult,
  SecureStoreGetResult,
  SecureStoreSetResult,
} from "../../../src/security/platform-secure-store";
import { LoopbackRemoteTargetExecutor } from "./remote-target-executor";
import {
  HttpRemoteTargetRelayTransport,
  normalizeRemoteTargetApiBase,
  type RemoteTargetTransportError,
  remoteTargetTransportInternals,
} from "./remote-target-transport";
import { RemoteTargetVault } from "./remote-target-vault";

class MemorySecureStore implements PlatformSecureStore {
  readonly backend = "none" as const;
  readonly values = new Map<string, string>();

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async get(vaultId: string): Promise<SecureStoreGetResult> {
    const value = this.values.get(vaultId);
    return value === undefined
      ? { ok: false, reason: "not_found" }
      : { ok: true, value };
  }

  async set(
    vaultId: string,
    _kind: unknown,
    value: string,
  ): Promise<SecureStoreSetResult> {
    this.values.set(vaultId, value);
    return { ok: true };
  }

  async delete(vaultId: string): Promise<SecureStoreDeleteResult> {
    return { ok: true, deleted: this.values.delete(vaultId) };
  }
}

function keyPair(): { privateKey: JsonWebKey; publicKey: JsonWebKey } {
  const privateKey = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  }).privateKey.export({ format: "jwk" });
  const { d: _privateScalar, ...publicKey } = privateKey;
  return { privateKey, publicKey };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("remote target native boundaries", () => {
  it("allows only read-only loopback health requests and strips caller headers", async () => {
    const requests: Request[] = [];
    const executor = new LoopbackRemoteTargetExecutor({
      apiBase: "http://127.0.0.1:31337",
      apiToken: "local-api-token-123456789",
      fetchImpl: async (input, init) => {
        requests.push(new Request(input, init));
        return jsonResponse({ ready: true });
      },
    });
    await expect(
      executor.execute({
        action: "agent.request",
        payload: { path: "/api/health", method: "GET", headers: {} },
        executionId: "execution-1",
      }),
    ).resolves.toEqual({
      status: "completed",
      result: {
        status: 200,
        body: '{"ready":true}',
        headers: { "content-type": "application/json" },
      },
    });
    await expect(
      executor.execute({
        action: "agent.request",
        payload: { path: "/api/agents", method: "POST", body: {} },
        executionId: "execution-2",
      }),
    ).resolves.toEqual({
      status: "rejected",
      errorCode: "REMOTE_ACTION_NOT_ALLOWLISTED",
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("http://127.0.0.1:31337/api/health");
    expect(requests[0]?.headers.get("authorization")).toBe(
      "Bearer local-api-token-123456789",
    );
  });

  it("stops reading a chunked relay response at the byte limit", async () => {
    const chunk = new Uint8Array(600_000);
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(chunk);
          controller.enqueue(chunk);
          controller.close();
        },
      }),
    );
    await expect(
      remoteTargetTransportInternals.readBoundedJson(response),
    ).rejects.toThrow("too large");
  });

  it("normalizes dispatch failures without hiding response-processing defects", async () => {
    const request = {
      apiBaseUrl: "https://api.example.test",
      ownerAccessToken: "owner-token-123456789",
      ownerId: "owner-1",
      deviceId: "device-1",
      displayName: "Linux target",
      platform: "linux" as const,
      runtimeKeyId: "target-key-1",
      signingPublicKeyJwk: keyPair().publicKey,
      encryptionPublicKeyJwk: keyPair().publicKey,
    };
    const networkFailure = new TypeError("fetch failed");
    const offline = new HttpRemoteTargetRelayTransport(async () => {
      throw networkFailure;
    });
    await expect(offline.enroll(request)).rejects.toMatchObject({
      name: "RemoteTargetTransportError",
      code: "NETWORK_UNAVAILABLE",
      cause: networkFailure,
    } satisfies Partial<RemoteTargetTransportError>);

    const programmingFailure = new TypeError("broken response body");
    const brokenResponse = new HttpRemoteTargetRelayTransport(async () => {
      return {
        status: 200,
        headers: {
          get() {
            throw programmingFailure;
          },
        },
      } as unknown as Response;
    });
    await expect(brokenResponse.enroll(request)).rejects.toBe(
      programmingFailure,
    );
  });

  it("recovers an exact pre-existing host and verifies every immutable field", async () => {
    const signing = keyPair();
    const encryption = keyPair();
    const hostId = "11111111-1111-4111-8111-111111111111";
    const host = {
      id: hostId,
      deviceId: "device-1",
      displayName: "Linux target",
      platform: "linux",
      connectionMode: "relay",
      runtimeKeyId: "target-key-1",
      signingPublicKeyJwk: signing.publicKey,
      encryptionPublicKeyJwk: encryption.publicKey,
      status: "active",
      lastSeenAt: null,
      createdAt: new Date(2_000_000_000_000).toISOString(),
      revokedAt: null,
    };
    const posts: Record<string, unknown>[] = [];
    let call = 0;
    const transport = new HttpRemoteTargetRelayTransport(
      async (_input, init) => {
        call += 1;
        if (call === 1 || call === 3) {
          return jsonResponse({
            success: true,
            data: { ownerId: "owner-1", hosts: [host] },
          });
        }
        posts.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return jsonResponse({
          success: true,
          data: {
            hostId,
            hostToken: `rhost_v1_${"A".repeat(43)}`,
            runtimeKeyId: "target-key-1",
            status: "active",
            createdAt: host.createdAt,
            recovered: true,
          },
        });
      },
    );
    const result = await transport.enroll({
      apiBaseUrl: "https://api.example.test",
      ownerAccessToken: "owner-token-123456789",
      ownerId: "owner-1",
      deviceId: host.deviceId,
      displayName: host.displayName,
      platform: "linux",
      runtimeKeyId: host.runtimeKeyId,
      signingPublicKeyJwk: signing.publicKey,
      encryptionPublicKeyJwk: encryption.publicKey,
    });
    expect(posts[0]?.recoveryHostId).toBe(hostId);
    expect(result).toMatchObject({ hostId, recovered: true });
    expect(result).not.toHaveProperty("ownerAccessToken");
  });

  it("rejects insecure API URLs and private/public secure-store tampering", async () => {
    expect(() => normalizeRemoteTargetApiBase("http://example.com")).toThrow(
      "HTTPS",
    );
    expect(() =>
      normalizeRemoteTargetApiBase("https://user:pass@example.com"),
    ).toThrow("HTTPS");
    expect(normalizeRemoteTargetApiBase("http://localhost:8787/")).toBe(
      "http://localhost:8787",
    );

    const store = new MemorySecureStore();
    const vault = new RemoteTargetVault(store, "target-test");
    const pending = await vault.prepare({
      ownerId: "owner-1",
      displayName: "Linux target",
      platform: "linux",
      now: 2_000_000_000_000,
    });
    if (pending.status !== "pending") throw new Error("expected pending");
    await vault.commitEnrollment({
      apiBaseUrl: "https://api.example.test",
      hostId: "11111111-1111-4111-8111-111111111111",
      hostToken: `rhost_v1_${"A".repeat(43)}`,
      runtimeKeyId: pending.keyId,
      createdAt: 2_000_000_000_001,
    });
    const stored = JSON.parse(store.values.get("target-test") ?? "{}") as {
      identity: { signingPublicKeyJwk: JsonWebKey };
    };
    stored.identity.signingPublicKeyJwk = keyPair().publicKey;
    store.values.set("target-test", JSON.stringify(stored));
    await expect(vault.load()).rejects.toThrow("corrupt");
  });

  it("binds native host revocation to its stored bearer and exact response host", async () => {
    const store = new MemorySecureStore();
    const vault = new RemoteTargetVault(store, "revoke-target-test");
    const pending = await vault.prepare({
      ownerId: "owner-1",
      displayName: "Linux target",
      platform: "linux",
      now: 2_000_000_000_000,
    });
    if (pending.status !== "pending") throw new Error("expected pending");
    const enrollment = await vault.commitEnrollment({
      apiBaseUrl: "https://api.example.test",
      hostId: "11111111-1111-4111-8111-111111111111",
      hostToken: `rhost_v1_${"A".repeat(43)}`,
      runtimeKeyId: pending.keyId,
      createdAt: 2_000_000_000_001,
    });
    const requests: Request[] = [];
    const transport = new HttpRemoteTargetRelayTransport(
      async (input, init) => {
        requests.push(new Request(input, init));
        return jsonResponse({
          success: true,
          data: {
            id: enrollment.identity.runtimeId,
            status: "revoked",
            alreadyRevoked: false,
            cleanup: { sessions: 1, commands: 2, more: false },
          },
        });
      },
    );
    await expect(transport.revokeHost({ enrollment })).resolves.toMatchObject({
      hostId: enrollment.identity.runtimeId,
      status: "revoked",
      cleanup: { more: false },
    });
    expect(requests[0]?.headers.get("authorization")).toBe(
      `Bearer ${enrollment.hostToken}`,
    );
    expect(requests[0]?.headers.get("x-remote-host-id")).toBe(
      enrollment.identity.runtimeId,
    );

    const substituted = new HttpRemoteTargetRelayTransport(async () =>
      jsonResponse({
        success: true,
        data: {
          id: "22222222-2222-4222-8222-222222222222",
          status: "revoked",
          alreadyRevoked: false,
          cleanup: { sessions: 0, commands: 0, more: false },
        },
      }),
    );
    await expect(substituted.revokeHost({ enrollment })).rejects.toThrow(
      "response is invalid",
    );
  });
});
