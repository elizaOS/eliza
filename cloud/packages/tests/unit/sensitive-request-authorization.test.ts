import { describe, expect, test } from "bun:test";
import {
  authorizeSensitiveRequestActor,
  type SensitiveRequestIdentityAuthorizationAdapter,
} from "@/lib/services/sensitive-request-authorization";

describe("sensitive request authorization", () => {
  test("allows the owner cloud session for owner_or_linked_identity", async () => {
    const decision = await authorizeSensitiveRequestActor({
      actor: {
        kind: "cloud_session",
        userId: "user-owner",
        organizationId: "org-1",
        role: "member",
      },
      context: {
        policy: "owner_or_linked_identity",
        organizationId: "org-1",
        ownerUserId: "user-owner",
      },
    });

    expect(decision.allowed).toBe(true);
    expect(decision.matchedBy).toBe("owner_user");
  });

  test("denies same-organization members who are not the owner or linked identity", async () => {
    const decision = await authorizeSensitiveRequestActor({
      actor: {
        kind: "cloud_session",
        userId: "user-other",
        organizationId: "org-1",
        role: "member",
      },
      context: {
        policy: "owner_or_linked_identity",
        organizationId: "org-1",
        ownerUserId: "user-owner",
      },
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("not linked");
  });

  test("allows organization admins only for organization_admin policy", async () => {
    const allowed = await authorizeSensitiveRequestActor({
      actor: {
        kind: "cloud_session",
        userId: "user-admin",
        organizationId: "org-1",
        role: "admin",
      },
      context: {
        policy: "organization_admin",
        organizationId: "org-1",
      },
    });
    const denied = await authorizeSensitiveRequestActor({
      actor: {
        kind: "cloud_session",
        userId: "user-member",
        organizationId: "org-1",
        role: "member",
      },
      context: {
        policy: "organization_admin",
        organizationId: "org-1",
      },
    });

    expect(allowed.allowed).toBe(true);
    expect(allowed.matchedBy).toBe("organization_admin");
    expect(denied.allowed).toBe(false);
  });

  test("allows connector identities linked by an existing identity relationship", async () => {
    const adapter: SensitiveRequestIdentityAuthorizationAdapter = {
      async resolveConnectorIdentity(actor) {
        const externalId =
          actor.kind === "oauth_connection" ? actor.platformUserId : actor.externalId;
        expect(externalId).toBe("discord-user-1");
        return {
          authenticated: true,
          organizationId: "org-1",
          entityIds: ["discord-entity"],
          connector: { platform: "discord", externalId },
        };
      },
      async areEntitiesLinked(leftEntityId, rightEntityId) {
        return leftEntityId === "discord-entity" && rightEntityId === "owner-entity";
      },
    };

    const decision = await authorizeSensitiveRequestActor({
      actor: {
        kind: "connector_identity",
        platform: "discord",
        externalId: "discord-user-1",
        organizationId: "org-1",
        verified: true,
      },
      context: {
        policy: "owner_or_linked_identity",
        organizationId: "org-1",
        ownerEntityId: "owner-entity",
      },
      adapter,
    });

    expect(decision.allowed).toBe(true);
    expect(decision.matchedBy).toBe("linked_identity");
  });

  test("denies wrong organizations before owner matching", async () => {
    const decision = await authorizeSensitiveRequestActor({
      actor: {
        kind: "cloud_session",
        userId: "user-owner",
        organizationId: "org-2",
        role: "owner",
      },
      context: {
        policy: "owner_or_linked_identity",
        organizationId: "org-1",
        ownerUserId: "user-owner",
      },
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("organization");
  });

  test("does not treat anonymous/public presence as owner proof", async () => {
    const decision = await authorizeSensitiveRequestActor({
      actor: { kind: "anonymous" },
      context: {
        policy: "owner_or_linked_identity",
        organizationId: "org-1",
        ownerEntityId: "owner-entity",
      },
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("not authenticated");
  });
});
