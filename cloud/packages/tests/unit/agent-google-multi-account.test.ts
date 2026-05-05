/**
 * Agent Google multi-account resolver tests.
 *
 * Verifies that listManagedGoogleConnectorAccounts returns every linked
 * Google connection for the user (not just the primary), that disconnect
 * targets a specific connection id, and that the resolver keeps the other
 * accounts intact.
 */

import { describe, expect, it } from "bun:test";
import {
  disconnectManagedGoogleConnection,
  listManagedGoogleConnectorAccounts,
  managedGoogleConnectorDeps,
} from "@/lib/services/agent-google-connector";
import type { OAuthConnection } from "@/lib/services/oauth/types";

type DbStub = typeof managedGoogleConnectorDeps.dbRead;
type OauthStub = typeof managedGoogleConnectorDeps.oauthService;

function installStubs(overrides: {
  listConnections?: OauthStub["listConnections"];
  revokeConnection?: OauthStub["revokeConnection"];
  select?: DbStub["select"];
}) {
  const originalDbRead = managedGoogleConnectorDeps.dbRead;
  const originalService = managedGoogleConnectorDeps.oauthService;

  managedGoogleConnectorDeps.dbRead = {
    select:
      overrides.select ??
      (() => ({
        from: () => ({
          where: () => ({
            limit: async () => [],
          }),
        }),
      })),
  } as DbStub;

  managedGoogleConnectorDeps.oauthService = {
    ...originalService,
    listConnections: overrides.listConnections ?? originalService.listConnections,
    revokeConnection: overrides.revokeConnection ?? originalService.revokeConnection,
  };

  return () => {
    managedGoogleConnectorDeps.dbRead = originalDbRead;
    managedGoogleConnectorDeps.oauthService = originalService;
  };
}

function makeConnection(overrides: Partial<OAuthConnection>): OAuthConnection {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    platform: "google",
    platformUserId: overrides.platformUserId ?? "google-user-id",
    userId: overrides.userId,
    connectionRole: overrides.connectionRole ?? "owner",
    email: overrides.email,
    username: overrides.username,
    displayName: overrides.displayName,
    avatarUrl: overrides.avatarUrl,
    status: overrides.status ?? "active",
    scopes: overrides.scopes ?? [],
    linkedAt: overrides.linkedAt ?? new Date(),
    lastUsedAt: overrides.lastUsedAt,
    tokenExpired: overrides.tokenExpired ?? false,
    source: overrides.source ?? "platform_credentials",
  };
}

describe("listManagedGoogleConnectorAccounts", () => {
  it("returns every Google connection for the owner side", async () => {
    const connections: OAuthConnection[] = [
      makeConnection({
        id: "conn-personal",
        platformUserId: "gmail-personal-id",
        email: "me@gmail.com",
        connectionRole: "owner",
        userId: "user-1",
      }),
      makeConnection({
        id: "conn-work",
        platformUserId: "gmail-work-id",
        email: "me@work.com",
        connectionRole: "owner",
        userId: "user-1",
      }),
    ];

    const restore = installStubs({
      listConnections: async ({ connectionRole }) =>
        connectionRole === "owner" ? connections : [],
    });

    try {
      const accounts = await listManagedGoogleConnectorAccounts({
        organizationId: "org-1",
        userId: "user-1",
        side: "owner",
      });

      expect(accounts).toHaveLength(2);
      const ids = accounts.map((account) => account.connectionId);
      expect(ids).toContain("conn-personal");
      expect(ids).toContain("conn-work");
      for (const account of accounts) {
        expect(account.side).toBe("owner");
        expect(account.mode).toBe("cloud_managed");
      }
    } finally {
      restore();
    }
  });

  it("returns an empty array when no Google connections exist", async () => {
    const restore = installStubs({
      listConnections: async () => [],
    });
    try {
      const accounts = await listManagedGoogleConnectorAccounts({
        organizationId: "org-1",
        userId: "user-1",
        side: "owner",
      });
      expect(accounts).toEqual([]);
    } finally {
      restore();
    }
  });

  it("includes both owner and agent sides when side is not specified", async () => {
    const restore = installStubs({
      listConnections: async ({ connectionRole }) =>
        connectionRole === "owner"
          ? [makeConnection({ id: "owner-1", connectionRole: "owner" })]
          : [
              makeConnection({
                id: "agent-1",
                connectionRole: "agent",
                userId: undefined,
              }),
            ],
    });

    try {
      const accounts = await listManagedGoogleConnectorAccounts({
        organizationId: "org-1",
        userId: "user-1",
      });
      expect(accounts).toHaveLength(2);
      expect(accounts.some((account) => account.connectionId === "owner-1")).toBe(true);
      expect(accounts.some((account) => account.connectionId === "agent-1")).toBe(true);
    } finally {
      restore();
    }
  });
});

describe("disconnectManagedGoogleConnection", () => {
  it("revokes the specific connection id when provided and leaves the others intact", async () => {
    const revoked: string[] = [];
    const allConnections: OAuthConnection[] = [
      makeConnection({ id: "conn-personal", platformUserId: "gmail-personal" }),
      makeConnection({ id: "conn-work", platformUserId: "gmail-work" }),
    ];

    const restore = installStubs({
      listConnections: async () => allConnections,
      revokeConnection: async ({ connectionId }) => {
        revoked.push(connectionId);
      },
    });

    try {
      await disconnectManagedGoogleConnection({
        organizationId: "org-1",
        userId: "user-1",
        side: "owner",
        connectionId: "conn-work",
      });

      expect(revoked).toEqual(["conn-work"]);
    } finally {
      restore();
    }
  });

  it("is a no-op when there are no connections", async () => {
    const revoked: string[] = [];
    const restore = installStubs({
      listConnections: async () => [],
      revokeConnection: async ({ connectionId }) => {
        revoked.push(connectionId);
      },
    });

    try {
      await disconnectManagedGoogleConnection({
        organizationId: "org-1",
        userId: "user-1",
        side: "owner",
      });
      expect(revoked).toEqual([]);
    } finally {
      restore();
    }
  });
});
