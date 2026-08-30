import { describe, expect, mock, test } from "bun:test";
import type { HeadscaleClient } from "@/lib/services/headscale-client";
import {
  activateManagedNetwork,
  cleanupManagedNetwork,
  enrollManagedNetwork,
  type ManagedNetworkCleanupRepository,
  type ManagedNetworkRepository,
  managedNetworkConfig,
  managedNetworkInternals,
  reconcileManagedNetworkCleanup,
} from "./managed-network";

function repository(): ManagedNetworkRepository {
  return {
    recordManagedEnrollment: mock(async () => undefined),
    recordManagedCleanupPending: mock(async () => undefined),
    recordManagedCleanupFailure: mock(async () => undefined),
    completeManagedCleanup: mock(async () => undefined),
    activateManagedEnrollment: mock(async () => undefined),
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
          user: { name: "tunnel" },
          createdAt: "2026-08-22T11:59:59.000Z",
        },
        {
          id: "9",
          name: "eliza-host-one",
          user: { name: "tunnel" },
          createdAt: "2026-08-22T12:00:01.000Z",
        },
        {
          id: "10",
          name: "eliza-host-one-cafebabe",
          user: { name: "tunnel" },
          createdAt: "2026-08-22T12:00:01.000Z",
        },
        {
          id: "11",
          name: "eliza-host-one-feedface",
          user: { name: "another-tenant" },
          createdAt: "2026-08-22T12:00:02.000Z",
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
    expect(headscale.deleteNode).not.toHaveBeenCalledWith("11");
    expect(headscale.deletePreAuthKey).toHaveBeenCalledWith("123");
    expect(repo.completeManagedCleanup).toHaveBeenCalledTimes(1);
  });

  test("retains compensation state after a failed collision lookup and retries safely", async () => {
    const repo = repository();
    const lookup = mock(
      async (): Promise<
        Array<{ id: string; name: string; createdAt: string }>
      > => {
        throw new Error("Headscale unavailable");
      },
    );
    const headscale = client({ listNodesStrict: lookup });
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

    lookup.mockImplementation(async () => [
      {
        id: "10",
        name: "eliza-host-one-a1b2c3d4",
        user: { name: "tunnel" },
        createdAt: "2026-08-22T12:00:01.000Z",
      },
    ]);
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

  test("compensates the persisted collision-suffixed hostname without deleting the base node", async () => {
    const repo = repository();
    const headscale = client({
      listNodesStrict: mock(async () => [
        {
          id: "9",
          name: "eliza-host-one",
          user: { name: "tunnel" },
          createdAt: "2026-08-22T12:00:01.000Z",
        },
        {
          id: "10",
          name: "eliza-host-one-cafebabe",
          user: { name: "tunnel" },
          createdAt: "2026-08-22T12:00:02.000Z",
        },
      ]),
    });
    await cleanupManagedNetwork({
      host: {
        id: "host-1",
        created_at: new Date("2026-08-22T12:00:00.000Z"),
        headscale_hostname: "eliza-host-one-cafebabe",
        headscale_preauth_key_id: "123",
        headscale_cleanup_pending: true,
      },
      organizationId: "org-1",
      userId: "user-1",
      config,
      repository: repo,
      client: headscale,
    });
    expect(headscale.deleteNode).toHaveBeenCalledWith("10");
    expect(headscale.deleteNode).not.toHaveBeenCalledWith("9");
  });

  test("activates only the exact fresh Headscale identity and records its collision suffix", async () => {
    const repo = repository();
    const headscale = client({
      listNodesStrict: mock(async () => [
        {
          id: "8",
          name: "eliza-host-one-deadbeef",
          user: { name: "tunnel" },
          createdAt: "2026-08-22T11:59:59.000Z",
        },
        {
          id: "9",
          name: "eliza-host-one-cafebabe",
          user: { name: "tunnel" },
          createdAt: "2026-08-22T12:00:01.000Z",
        },
        {
          id: "10",
          name: "eliza-host-one-feedface",
          user: { name: "another-tenant" },
          createdAt: "2026-08-22T12:00:02.000Z",
        },
      ]),
    });
    await expect(
      activateManagedNetwork({
        host: {
          id: "host-1",
          created_at: new Date("2026-08-22T12:00:00.000Z"),
          headscale_hostname: "eliza-host-one",
          headscale_cleanup_pending: true,
        },
        organizationId: "org-1",
        userId: "user-1",
        config,
        repository: repo,
        client: headscale,
      }),
    ).resolves.toEqual({ hostname: "eliza-host-one-cafebabe" });
    expect(repo.activateManagedEnrollment).toHaveBeenCalledWith({
      hostId: "host-1",
      organizationId: "org-1",
      userId: "user-1",
      hostname: "eliza-host-one-cafebabe",
    });
  });

  test("keeps a managed host non-authoritative when no fresh node exists", async () => {
    const repo = repository();
    const headscale = client({
      listNodesStrict: mock(async () => [
        {
          id: "8",
          name: "eliza-host-one-deadbeef",
          user: { name: "tunnel" },
          createdAt: "2026-08-22T11:59:59.000Z",
        },
      ]),
    });
    await expect(
      activateManagedNetwork({
        host: {
          id: "host-1",
          created_at: new Date("2026-08-22T12:00:00.000Z"),
          headscale_hostname: "eliza-host-one",
          headscale_cleanup_pending: true,
        },
        organizationId: "org-1",
        userId: "user-1",
        config,
        repository: repo,
        client: headscale,
      }),
    ).resolves.toBeNull();
    expect(repo.activateManagedEnrollment).not.toHaveBeenCalled();
  });

  test("makes a lost successful activation response idempotent", async () => {
    const repo = repository();
    const headscale = client({
      listNodesStrict: mock(async () => [
        {
          id: "9",
          name: "eliza-host-one",
          user: { name: "tunnel" },
          createdAt: "2026-08-22T12:00:01.000Z",
        },
      ]),
    });
    await expect(
      activateManagedNetwork({
        host: {
          id: "host-1",
          status: "active",
          created_at: new Date("2026-08-22T12:00:00.000Z"),
          headscale_hostname: "eliza-host-one",
          headscale_cleanup_pending: true,
        },
        organizationId: "org-1",
        userId: "user-1",
        config,
        repository: repo,
        client: headscale,
      }),
    ).resolves.toEqual({ hostname: "eliza-host-one" });
    expect(repo.activateManagedEnrollment).not.toHaveBeenCalled();
  });

  test("background reconciliation revokes expired pending rows and continues after failures", async () => {
    const base = repository();
    const pending = {
      id: "pending-host",
      status: "pending" as const,
      organization_id: "org-1",
      user_id: "user-1",
      created_at: new Date("2026-08-22T11:00:00.000Z"),
      headscale_hostname: "eliza-host-pending",
      headscale_preauth_key_id: "123",
      headscale_cleanup_pending: true,
    };
    const failed = {
      ...pending,
      id: "failed-host",
      status: "revoked" as const,
      headscale_hostname: "eliza-host-failed",
    };
    const repo: ManagedNetworkCleanupRepository = {
      ...base,
      listManagedCleanupCandidates: mock(async () => [pending, failed]),
      revoke: mock(async () => ({
        host: { ...pending, status: "revoked" as const },
        cleanup: { sessions: 0, commands: 0, more: false },
      })),
    };
    const listNodesStrict = mock(async () => {
      if (listNodesStrict.mock.calls.length > 1) {
        throw new Error("Headscale temporarily unavailable");
      }
      return [];
    });
    const result = await reconcileManagedNetworkCleanup({
      config,
      repository: repo,
      client: client({ listNodesStrict }),
      now: Date.parse("2026-08-22T12:00:00.000Z"),
      limit: 10,
    });
    expect(repo.listManagedCleanupCandidates).toHaveBeenCalledWith({
      pendingUpdatedBefore: new Date("2026-08-22T11:45:00.000Z"),
      limit: 10,
    });
    expect(repo.revoke).toHaveBeenCalledWith("pending-host", "org-1", "user-1");
    expect(result).toEqual({
      attempted: 2,
      completed: 1,
      failed: 1,
      remaining: true,
    });
  });
});
