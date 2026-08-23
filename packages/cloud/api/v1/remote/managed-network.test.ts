import { describe, expect, mock, test } from "bun:test";
import type { HeadscaleClient } from "@/lib/services/headscale-client";
import {
  cleanupManagedNetwork,
  enrollManagedNetwork,
  type ManagedNetworkRepository,
  managedNetworkConfig,
  managedNetworkInternals,
} from "./managed-network";

function repository(): ManagedNetworkRepository {
  return {
    recordManagedEnrollment: mock(async () => undefined),
    recordManagedCleanupPending: mock(async () => undefined),
    recordManagedCleanupFailure: mock(async () => undefined),
    completeManagedCleanup: mock(async () => undefined),
  };
}

function client(overrides: Record<string, unknown> = {}): HeadscaleClient {
  return {
    createPreAuthKey: mock(async () => ({
      id: "123",
      key: "hskey-auth-prefix-secret",
      reusable: false,
      ephemeral: false,
      used: false,
      expiration: "2026-08-22T12:15:00.000Z",
    })),
    expirePreAuthKey: mock(async () => undefined),
    deletePreAuthKey: mock(async () => undefined),
    listNodesStrict: mock(async () => []),
    deleteNode: mock(async () => undefined),
    ...overrides,
  } as unknown as HeadscaleClient;
}

const config = {
  apiUrl: "https://headscale-staging.eliza.app",
  publicUrl: "https://headscale-staging.eliza.app",
  apiKey: "secret",
  user: "tunnel",
};

describe("remote host managed-network lifecycle", () => {
  test("requires a complete safe origin configuration", () => {
    expect(managedNetworkConfig({})).toBeNull();
    expect(() =>
      managedNetworkConfig({ HEADSCALE_API_URL: "https://headscale.example" }),
    ).toThrow(/requires HEADSCALE/);
    expect(() =>
      managedNetworkConfig({
        HEADSCALE_API_URL: "http://attacker.example",
        HEADSCALE_PUBLIC_URL: "https://headscale.example",
        HEADSCALE_API_KEY: "secret",
      }),
    ).toThrow(/HTTPS origin/);
  });

  test("mints one short-lived tagged key and records only its public id", async () => {
    const repo = repository();
    const headscale = client();
    const result = await enrollManagedNetwork({
      hostId: "40000000-0000-4000-8000-000000000001",
      organizationId: "org-1",
      userId: "user-1",
      config,
      repository: repo,
      client: headscale,
      now: Date.parse("2026-08-22T12:00:00.000Z"),
    });
    expect(headscale.createPreAuthKey).toHaveBeenCalledWith({
      reusable: false,
      ephemeral: false,
      expiration: "2026-08-22T12:15:00.000Z",
      aclTags: ["tag:eliza-remote-host"],
    });
    expect(repo.recordManagedEnrollment).toHaveBeenCalledWith({
      hostId: "40000000-0000-4000-8000-000000000001",
      organizationId: "org-1",
      userId: "user-1",
      hostname: managedNetworkInternals.hostnameForHost(
        "40000000-0000-4000-8000-000000000001",
      ),
      preAuthKeyId: "123",
    });
    const recordedCalls = repo.recordManagedEnrollment as unknown as {
      mock: { calls: unknown[][] };
    };
    expect(JSON.stringify(recordedCalls.mock.calls)).not.toContain(
      result.authKey,
    );
  });

  test("expires and deletes the key when durable enrollment recording fails", async () => {
    const repo = repository();
    repo.recordManagedEnrollment = mock(async () => {
      throw new Error("database unavailable");
    });
    const headscale = client();
    await expect(
      enrollManagedNetwork({
        hostId: "host-1",
        organizationId: "org-1",
        userId: "user-1",
        config,
        repository: repo,
        client: headscale,
      }),
    ).rejects.toThrow("database unavailable");
    expect(headscale.expirePreAuthKey).toHaveBeenCalledWith("123");
    expect(headscale.deletePreAuthKey).toHaveBeenCalledWith("123");
  });

  test("records cleanup state without activating when key compensation also fails", async () => {
    const repo = repository();
    repo.recordManagedEnrollment = mock(async () => {
      throw new Error("database activation unavailable");
    });
    const headscale = client({
      expirePreAuthKey: mock(async () => {
        throw new Error("Headscale unavailable");
      }),
    });
    await expect(
      enrollManagedNetwork({
        hostId: "host-1",
        organizationId: "org-1",
        userId: "user-1",
        config,
        repository: repo,
        client: headscale,
      }),
    ).rejects.toThrow(/compensation is pending/);
    expect(repo.recordManagedCleanupPending).toHaveBeenCalledWith({
      hostId: "host-1",
      organizationId: "org-1",
      userId: "user-1",
      hostname: managedNetworkInternals.hostnameForHost("host-1"),
      preAuthKeyId: "123",
      message: "Managed-network enrollment compensation is pending retry.",
    });
    expect(repo.recordManagedEnrollment).toHaveBeenCalledTimes(1);
  });

  test("cleans key and node idempotently before clearing durable retry state", async () => {
    const repo = repository();
    const headscale = client({
      listNodesStrict: mock(async () => [
        {
          id: "8",
          name: "eliza-host-one-deadbeef",
          createdAt: "2026-08-22T11:59:59.000Z",
        },
        {
          id: "9",
          name: "eliza-host-one",
          createdAt: "2026-08-22T12:00:01.000Z",
        },
        {
          id: "10",
          name: "eliza-host-one-cafebabe",
          createdAt: "2026-08-22T12:00:01.000Z",
        },
      ]),
    });
    await cleanupManagedNetwork({
      host: {
        id: "host-1",
        created_at: new Date("2026-08-22T12:00:00.000Z"),
        headscale_hostname: "eliza-host-one",
        headscale_preauth_key_id: "123",
        headscale_cleanup_pending: true,
      },
      organizationId: "org-1",
      userId: "user-1",
      config,
      repository: repo,
      client: headscale,
    });
    expect(headscale.expirePreAuthKey).toHaveBeenCalledWith("123");
    expect(headscale.deleteNode).toHaveBeenCalledWith("9");
    expect(headscale.deleteNode).toHaveBeenCalledWith("10");
    expect(headscale.deleteNode).not.toHaveBeenCalledWith("8");
    expect(headscale.deletePreAuthKey).toHaveBeenCalledWith("123");
    expect(repo.completeManagedCleanup).toHaveBeenCalledTimes(1);
  });

  test("retains compensation state after a failed collision lookup and retries safely", async () => {
    const repo = repository();
    const lookup = mock(
      async (): Promise<{ id: string; name: string } | null> => {
        throw new Error("Headscale unavailable");
      },
    );
    const headscale = client({ getNodeByNameOrSuffixedStrict: lookup });
    const host = {
      id: "host-1",
      created_at: new Date("2026-08-22T12:00:00.000Z"),
      headscale_hostname: "eliza-host-one",
      headscale_preauth_key_id: "123",
      headscale_cleanup_pending: true,
    };

    await expect(
      cleanupManagedNetwork({
        host,
        organizationId: "org-1",
        userId: "user-1",
        config,
        repository: repo,
        client: headscale,
      }),
    ).rejects.toThrow("pending retry");
    expect(repo.recordManagedCleanupFailure).toHaveBeenCalledTimes(1);
    expect(repo.completeManagedCleanup).not.toHaveBeenCalled();

    lookup.mockImplementation(async () => ({
      id: "10",
      name: "eliza-host-one-a1b2c3d4",
    }));
    await cleanupManagedNetwork({
      host,
      organizationId: "org-1",
      userId: "user-1",
      config,
      repository: repo,
      client: headscale,
    });
    expect(headscale.deleteNode).toHaveBeenCalledWith("10");
    expect(repo.completeManagedCleanup).toHaveBeenCalledTimes(1);
  });
});
