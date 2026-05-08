import { describe, expect, it } from "vitest";
import type { LifeOpsConnectorGrant } from "../contracts/index.js";
import {
  CALENDAR_CONNECTOR_ACCOUNT_MIGRATION_NOTE,
  canEgress,
  createConnectorAccountPrivacyPolicy,
  createLifeOpsEgressContext,
  deriveConnectorAccountIdFromGrant,
  filterActionResultForEgress,
} from "./privacy-egress.js";

function grant(
  overrides: Partial<LifeOpsConnectorGrant>,
): LifeOpsConnectorGrant {
  return {
    id: "grant_secret_123",
    agentId: "agent-1",
    provider: "google",
    side: "owner",
    identity: {},
    identityEmail: null,
    grantedScopes: [],
    capabilities: [],
    tokenRef: null,
    mode: "local",
    executionTarget: "local",
    sourceOfTruth: "local_storage",
    preferredByAgent: false,
    cloudConnectionId: null,
    metadata: {},
    lastRefreshAt: null,
    createdAt: "2026-05-08T00:00:00.000Z",
    updatedAt: "2026-05-08T00:00:00.000Z",
    ...overrides,
  };
}

describe("LifeOps privacy egress", () => {
  it("defaults connector account privacy to owner_only", () => {
    const owner = createLifeOpsEgressContext({ isOwner: true });
    const nonOwner = createLifeOpsEgressContext({ isOwner: false });
    const policy = createConnectorAccountPrivacyPolicy({
      agentId: "agent-1",
      provider: "google",
      connectorAccountId: "google:owner:email:abc",
    });

    expect(policy.visibilityScope).toBe("owner_only");
    expect(canEgress(owner, "body", policy)).toBe(true);
    expect(canEgress(nonOwner, "metadata", policy)).toBe(false);
    expect(canEgress(nonOwner, "body", policy)).toBe(false);
  });

  it("filters non-owner action results by data class", () => {
    const nonOwner = createLifeOpsEgressContext({ isOwner: false });
    const policy = createConnectorAccountPrivacyPolicy({
      agentId: "agent-1",
      provider: "google",
      connectorAccountId: "google:owner:email:abc",
    });

    expect(
      filterActionResultForEgress(
        {
          success: true,
          text: "Subject: renewal receipt\nBody: card was charged",
          data: { messageId: "msg-1" },
        },
        {
          context: nonOwner,
          dataClasses: ["snippet", "payments"],
          policy,
        },
      ),
    ).toMatchInlineSnapshot(`
      {
        "data": {
          "originalSuccess": true,
          "privacyFiltered": true,
        },
        "success": true,
        "text": "Result hidden by LifeOps privacy policy.",
      }
    `);
  });

  it("allows explicit metadata-only sharing without exposing snippets", () => {
    const nonOwner = createLifeOpsEgressContext({ isOwner: false });
    const policy = createConnectorAccountPrivacyPolicy({
      agentId: "agent-1",
      provider: "google",
      connectorAccountId: "google:owner:email:abc",
      visibilityScope: "metadata_only",
    });

    expect(canEgress(nonOwner, "metadata", policy)).toBe(true);
    expect(canEgress(nonOwner, "snippet", policy)).toBe(false);
  });

  it("derives connector account ids from account identity before grant id aliases", () => {
    const connectorAccountId = deriveConnectorAccountIdFromGrant(
      grant({
        identityEmail: "Owner@Example.com",
        identity: { email: "Owner@Example.com" },
      }),
    );

    expect(connectorAccountId).toMatch(/^google:owner:email:/);
    expect(connectorAccountId).not.toContain("grant_secret_123");
  });

  it("documents ambiguous calendar cache migration requirements", () => {
    const legacyAlias = deriveConnectorAccountIdFromGrant(grant({}));

    expect(legacyAlias).toMatch(/^google:owner:legacy-grant:/);
    expect(CALENDAR_CONNECTOR_ACCOUNT_MIGRATION_NOTE).toContain("purge");
    expect(CALENDAR_CONNECTOR_ACCOUNT_MIGRATION_NOTE).toContain("resync");
  });
});
