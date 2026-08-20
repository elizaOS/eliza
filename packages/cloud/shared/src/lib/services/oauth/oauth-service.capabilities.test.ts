/**
 * Exercises tenant, actor, role, and scope projection for an existing OAuth
 * connection before capability-based incremental consent begins.
 */

import { describe, expect, test } from "bun:test";
import { OAuthErrorCode } from "./errors";
import {
  resolveExistingCapabilityGrant,
  selectImplicitIncrementalOAuthConnection,
} from "./oauth-service";
import type { OAuthConnection } from "./types";

const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";

function connection(overrides: Partial<OAuthConnection> = {}): OAuthConnection {
  return {
    id: CONNECTION_ID,
    userId: "user-1",
    connectionRole: "owner",
    platform: "google",
    platformUserId: "google-user-1",
    status: "active",
    scopes: ["identity", "calendar.read", "provider:unexpected"],
    linkedAt: new Date("2026-01-01T00:00:00.000Z"),
    source: "platform_credentials",
    ...overrides,
  };
}

function resolve(candidate: OAuthConnection | null) {
  return resolveExistingCapabilityGrant(candidate, {
    connectionId: CONNECTION_ID,
    platform: "google",
    userId: "user-1",
    connectionRole: "OWNER",
    allowedScopes: ["identity", "calendar.read"],
    allowedUserScopes: ["profile.read"],
  });
}

describe("existing OAuth capability grant binding (#19879)", () => {
  test("requires explicit selection when multiple active accounts exist", () => {
    const first = connection();
    const second = {
      ...first,
      id: "22222222-2222-4222-8222-222222222222",
      platformUserId: "provider-user-2",
    };
    expect(() => selectImplicitIncrementalOAuthConnection("test", [first, second])).toThrow(
      "multiple active accounts",
    );
    expect(selectImplicitIncrementalOAuthConnection("test", [first])).toBe(first.id);
    expect(
      selectImplicitIncrementalOAuthConnection("test", [{ ...first, status: "expired" }]),
    ).toBeUndefined();
  });
  test("projects only allowlisted grants and binds the provider account", () => {
    expect(resolve(connection())).toEqual({
      grantedScopes: ["identity", "calendar.read"],
      grantedUserScopes: [],
      expectedPlatformUserId: "google-user-1",
    });
  });

  test("does not infer user-token authority from an overlapping bot scope", () => {
    const candidate = connection({ scopes: ["chat:write"] });
    const grant = resolveExistingCapabilityGrant(candidate, {
      connectionId: CONNECTION_ID,
      platform: "google",
      userId: "user-1",
      connectionRole: "OWNER",
      allowedScopes: ["chat:write"],
      allowedUserScopes: ["chat:write"],
    });

    expect(grant.grantedScopes).toEqual(["chat:write"]);
    expect(grant.grantedUserScopes).toEqual([]);
  });

  test.each([
    null,
    connection({ userId: "other-user" }),
    connection({ platform: "microsoft" }),
    connection({ status: "revoked" }),
    connection({ connectionRole: "agent", userId: undefined }),
  ])("fails closed for an inaccessible or mismatched connection %#", (candidate) => {
    try {
      resolve(candidate);
      throw new Error("expected connection binding to fail");
    } catch (error) {
      expect(error).toMatchObject({ code: OAuthErrorCode.CONNECTION_NOT_FOUND });
    }
  });

  test("accepts an organization-shared TEAM connection without fabricating user ownership", () => {
    const grant = resolveExistingCapabilityGrant(
      connection({ connectionRole: "team", userId: undefined }),
      {
        connectionId: CONNECTION_ID,
        platform: "google",
        userId: "user-1",
        connectionRole: "TEAM",
        allowedScopes: ["identity", "calendar.read"],
        allowedUserScopes: [],
      },
    );

    expect(grant.expectedPlatformUserId).toBe("google-user-1");
  });
});
