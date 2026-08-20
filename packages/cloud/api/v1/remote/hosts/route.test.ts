/** Tests managed Headscale enrollment without contacting deployed services. */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "@/types/cloud-worker-env";

const create = mock();
const listOwned = mock();
const createPreAuthKey = mock();
const requireUserOrApiKeyWithOrg = mock(async () => ({
  id: "11111111-1111-4111-8111-111111111111",
  organization_id: "22222222-2222-4222-8222-222222222222",
}));
const publicKey = {
  kty: "EC",
  crv: "P-256",
  x: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  y: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
};
const enrollmentBody = {
  displayName: "Studio Mac",
  platform: "macos",
  hostIdentity: {
    keyId: "host-key-1",
    signingPublicKeyJwk: publicKey,
    encryptionPublicKeyJwk: publicKey,
  },
};

mock.module("@/db/repositories/remote-hosts", () => ({
  remoteHostsRepository: { create, listOwned },
}));
mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg,
}));
mock.module("@/lib/services/headscale-client", () => ({
  HeadscaleClient: class {
    createPreAuthKey = createPreAuthKey;
  },
}));

const { default: route } = await import("./route");
const app = new Hono<AppEnv>();
app.route("/api/v1/remote/hosts", route);

describe("remote host enrollment", () => {
  beforeEach(() => {
    create.mockReset();
    listOwned.mockReset();
    createPreAuthKey.mockReset();
    createPreAuthKey.mockResolvedValue({
      key: "one-use-enrollment-key",
      expiration: "2026-08-20T12:15:00.000Z",
    });
    create.mockImplementation(async (input) => ({
      ...input,
      created_at: new Date(),
      updated_at: new Date(),
      last_seen_at: null,
      revoked_at: null,
    }));
  });

  test("mints a non-ephemeral one-use key with the locked remote-host tag", async () => {
    const response = await app.fetch(
      new Request("https://api.example.test/api/v1/remote/hosts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(enrollmentBody),
      }),
      {
        HEADSCALE_API_URL: "http://headscale.internal",
        HEADSCALE_PUBLIC_URL: "https://headscale.example.test",
        HEADSCALE_API_KEY: "server-side-only-key",
      } as unknown as AppEnv["Bindings"],
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(createPreAuthKey).toHaveBeenCalledWith(
      expect.objectContaining({
        reusable: false,
        ephemeral: false,
        aclTags: ["tag:eliza-remote-host"],
      }),
    );
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        display_name: "Studio Mac",
        connection_mode: "cloud_relay",
        runtime_key_id: "host-key-1",
      }),
    );
    const body = (await response.json()) as { data: Record<string, unknown> };
    expect(body.data.authKey).toBe("one-use-enrollment-key");
    expect(body.data.loginServer).toBe("https://headscale.example.test");
    expect(body.data.connectionMode).toBe("cloud_relay");
    expect(body.data.managedNetworkEnrollmentAvailable).toBe(true);
    expect(body.data.hostToken).toMatch(/^eliza_host_[A-Za-z0-9_-]{43}$/);
    expect(create.mock.calls[0]?.[0]?.host_token_hash).toMatch(
      /^[0-9a-f]{64}$/,
    );
    expect(create.mock.calls[0]?.[0]?.host_token_hash).not.toBe(
      body.data.hostToken,
    );
  });

  test("falls back to the encrypted Cloud relay without Headscale configuration", async () => {
    const response = await app.fetch(
      new Request("https://api.example.test/api/v1/remote/hosts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(enrollmentBody),
      }),
      {} as AppEnv["Bindings"],
    );
    expect(response.status).toBe(200);
    expect(createPreAuthKey).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        connection_mode: "cloud_relay",
        headscale_hostname: null,
      }),
    );
    const body = (await response.json()) as { data: Record<string, unknown> };
    expect(body.data.connectionMode).toBe("cloud_relay");
    expect(body.data.authKey).toBeNull();
    expect(body.data.loginServer).toBeNull();
    expect(body.data.hostToken).toMatch(/^eliza_host_/);
  });
});
