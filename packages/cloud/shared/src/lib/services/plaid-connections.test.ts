/**
 * Verifies the organization boundary, environment binding, token opacity, and
 * idempotent revoke behavior of the Cloud-owned Plaid connection use-case.
 */

import { describe, expect, mock, spyOn, test } from "bun:test";
import { buildOrgBoundAccessTokenAad } from "../../db/repositories/vendor-connections";
import type { VendorConnection } from "../../db/schemas/vendor-connections";
import { logger } from "../utils/logger";
import { AgentPlaidConnectorError } from "./agent-plaid-connector";
import { PlaidConnectionError, PlaidConnectionService } from "./plaid-connections";
import { EncryptionKeyMismatchError } from "./secrets/encryption";

const INSTITUTION = {
  institutionId: "ins_1",
  institutionName: "Test Bank",
  primaryAccountMask: "1234",
  accounts: [
    {
      accountId: "acct_1",
      name: "Checking",
      mask: "1234",
      type: "depository",
      subtype: "checking",
    },
  ],
};

function connection(overrides: Partial<VendorConnection> = {}): VendorConnection {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    organization_id: "org-a",
    vendor: "plaid",
    label: "item-1",
    access_token_encrypted: "ciphertext",
    refresh_token_encrypted: null,
    encrypted_dek: "dek",
    token_nonce: "nonce",
    token_auth_tag: "tag",
    encryption_key_id: "key",
    expires_at: null,
    scopes: ["transactions"],
    connection_metadata: {
      encryption_context: "org_bound_v1",
      plaid_environment: "sandbox",
      plaid_item_id: "item-1",
      plaid_institution: INSTITUTION,
    },
    created_at: new Date("2026-01-01T00:00:00Z"),
    updated_at: new Date("2026-01-01T00:00:00Z"),
    deleted_at: null,
    ...overrides,
  };
}

function harness(existing: VendorConnection | null = connection()) {
  const store = {
    upsertOrgBoundAccessToken: mock(async () => connection()),
    findActiveByIdForOrganization: mock(async () => existing),
    findActiveByVendorLabelForOrganization: mock(async () => null),
    getOrgBoundAccessToken: mock(async () => "plaid-secret-token"),
    deleteActiveByIdForOrganization: mock(async () => true),
  };
  const protocol = {
    createLinkToken: mock(async () => ({
      linkToken: "link-update",
      expiration: "2026-08-22T00:00:00.000Z",
      environment: "sandbox" as const,
    })),
    exchange: mock(async () => ({
      accessToken: "plaid-secret-token",
      itemId: "item-1",
    })),
    itemInfo: mock(async () => INSTITUTION),
    itemStatus: mock(async () => ({
      itemId: "item-1",
      institutionId: "ins_1",
      error: null,
      consentExpirationTime: null,
    })),
    sync: mock(async () => ({
      added: [],
      modified: [],
      removed: [],
      nextCursor: "cursor-2",
      hasMore: false,
    })),
    remove: mock(async () => undefined),
    environment: mock(() => "sandbox" as const),
  };
  return { store, protocol, service: new PlaidConnectionService(store, protocol) };
}

describe("PlaidConnectionService", () => {
  test("binds encrypted Item credentials to both organization and connection", () => {
    const aad = buildOrgBoundAccessTokenAad("org-a", "11111111-1111-4111-8111-111111111111");
    expect(aad).toBe("vendor_connections|org-a|11111111-1111-4111-8111-111111111111|access_token");
    expect(buildOrgBoundAccessTokenAad("org-b", connection().id)).not.toBe(aad);
    expect(buildOrgBoundAccessTokenAad("org-a", "22222222-2222-4222-8222-222222222222")).not.toBe(
      aad,
    );
  });

  test("returns only an opaque connection id after storing the Item token", async () => {
    const { service, store } = harness();
    const result = await service.exchange({
      organizationId: "org-a",
      publicToken: "public-token",
    });

    expect(result).toEqual({
      connectionId: "11111111-1111-4111-8111-111111111111",
      connectionCreated: true,
      institution: INSTITUTION,
      environment: "sandbox",
    });
    expect(JSON.stringify(result)).not.toContain("plaid-secret-token");
    expect(store.upsertOrgBoundAccessToken).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org-a",
        vendor: "plaid",
        accessToken: "plaid-secret-token",
      }),
    );
  });

  test("compensates by revoking an exchanged Item when Cloud storage fails", async () => {
    const { service, store, protocol } = harness();
    store.upsertOrgBoundAccessToken.mockRejectedValueOnce(new Error("storage unavailable"));

    await expect(
      service.exchange({ organizationId: "org-a", publicToken: "public-token" }),
    ).rejects.toThrow("storage unavailable");
    expect(protocol.remove).toHaveBeenCalledWith("plaid-secret-token");
  });

  test("never logs a credential echoed by compensating cleanup", async () => {
    const { service, store, protocol } = harness();
    const warn = spyOn(logger, "warn").mockImplementation(() => undefined);
    store.upsertOrgBoundAccessToken.mockRejectedValueOnce(new Error("storage unavailable"));
    protocol.remove.mockRejectedValueOnce(new Error("cleanup echoed plaid-secret-token"));

    try {
      await expect(
        service.exchange({ organizationId: "org-a", publicToken: "public-token" }),
      ).rejects.toThrow("storage unavailable");
      expect(JSON.stringify(warn.mock.calls)).not.toContain("plaid-secret-token");
    } finally {
      warn.mockRestore();
    }
  });

  test("fails cross-organization lookup without decrypting or calling Plaid", async () => {
    const { service, store, protocol } = harness(null);

    await expect(
      service.sync({
        organizationId: "org-b",
        connectionId: "11111111-1111-4111-8111-111111111111",
      }),
    ).rejects.toMatchObject({ status: 404 } satisfies Partial<PlaidConnectionError>);
    expect(store.getOrgBoundAccessToken).not.toHaveBeenCalled();
    expect(protocol.sync).not.toHaveBeenCalled();
  });

  test("rejects credentials from a different Plaid environment", async () => {
    const { service, store } = harness(
      connection({
        connection_metadata: {
          encryption_context: "org_bound_v1",
          plaid_environment: "production",
        },
      }),
    );

    await expect(
      service.sync({
        organizationId: "org-a",
        connectionId: "11111111-1111-4111-8111-111111111111",
      }),
    ).rejects.toMatchObject({ status: 409 } satisfies Partial<PlaidConnectionError>);
    expect(store.getOrgBoundAccessToken).not.toHaveBeenCalled();
  });

  test("decrypts inside Cloud and never requires a client access token for sync", async () => {
    const { service, protocol } = harness();
    await expect(
      service.sync({
        organizationId: "org-a",
        connectionId: "11111111-1111-4111-8111-111111111111",
        cursor: "cursor-1",
      }),
    ).resolves.toMatchObject({ nextCursor: "cursor-2", hasMore: false });
    expect(protocol.sync).toHaveBeenCalledWith({
      accessToken: "plaid-secret-token",
      cursor: "cursor-1",
      count: undefined,
    });
  });

  test("creates update-mode Link tokens only after organization-scoped lookup", async () => {
    const allowed = harness();
    await expect(
      allowed.service.createUpdateLinkToken({
        organizationId: "org-a",
        connectionId: connection().id,
        userId: "user-a",
        webhookUrl: "https://agent.example/plaid/webhook",
      }),
    ).resolves.toMatchObject({ linkToken: "link-update" });
    expect(allowed.protocol.createLinkToken).toHaveBeenCalledWith({
      organizationId: "org-a",
      connectionId: connection().id,
      userId: "user-a",
      webhookUrl: "https://agent.example/plaid/webhook",
      accessToken: "plaid-secret-token",
    });

    const denied = harness(null);
    await expect(
      denied.service.createUpdateLinkToken({
        organizationId: "org-b",
        connectionId: connection().id,
        userId: "user-b",
      }),
    ).rejects.toMatchObject({ status: 404 } satisfies Partial<PlaidConnectionError>);
    expect(denied.protocol.createLinkToken).not.toHaveBeenCalled();
  });

  test("resolves signed webhook Item ids inside the authenticated organization", async () => {
    const allowed = harness();
    allowed.store.findActiveByVendorLabelForOrganization.mockResolvedValueOnce(connection());
    await expect(
      allowed.service.resolveItem({ organizationId: "org-a", itemId: "item-1" }),
    ).resolves.toEqual({ connectionId: connection().id });
    expect(allowed.store.findActiveByVendorLabelForOrganization).toHaveBeenCalledWith(
      "org-a",
      "plaid",
      "item-1",
    );
    expect(allowed.store.getOrgBoundAccessToken).not.toHaveBeenCalled();
    expect(allowed.protocol.itemStatus).not.toHaveBeenCalled();

    const denied = harness(null);
    await expect(
      denied.service.resolveItem({ organizationId: "org-b", itemId: "item-1" }),
    ).rejects.toMatchObject({ status: 404 } satisfies Partial<PlaidConnectionError>);
  });

  test("reads Item status through the organization-bound Cloud credential", async () => {
    const { service, protocol } = harness();
    await expect(
      service.status({ organizationId: "org-a", connectionId: connection().id }),
    ).resolves.toEqual({
      connectionId: connection().id,
      itemId: "item-1",
      institutionId: "ins_1",
      error: null,
      consentExpirationTime: null,
    });
    expect(protocol.itemStatus).toHaveBeenCalledWith("plaid-secret-token");
  });

  test("makes revoke idempotent for absent and already-removed Items", async () => {
    const absent = harness(null);
    await expect(
      absent.service.revoke({
        organizationId: "org-a",
        connectionId: "11111111-1111-4111-8111-111111111111",
      }),
    ).resolves.toEqual({ revoked: true });
    expect(absent.protocol.remove).not.toHaveBeenCalled();

    const removed = harness();
    removed.protocol.remove.mockRejectedValueOnce(
      new AgentPlaidConnectorError(400, "Item missing", "ITEM_NOT_FOUND"),
    );
    await expect(
      removed.service.revoke({
        organizationId: "org-a",
        connectionId: "11111111-1111-4111-8111-111111111111",
      }),
    ).resolves.toEqual({ revoked: true });
    expect(removed.store.deleteActiveByIdForOrganization).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      "org-a",
      "plaid",
    );

    const invalid = harness();
    invalid.protocol.remove.mockRejectedValueOnce(
      new AgentPlaidConnectorError(400, "Token invalid", "INVALID_ACCESS_TOKEN"),
    );
    await expect(
      invalid.service.revoke({
        organizationId: "org-a",
        connectionId: "11111111-1111-4111-8111-111111111111",
      }),
    ).resolves.toEqual({ revoked: true });
    expect(invalid.store.deleteActiveByIdForOrganization).toHaveBeenCalled();
  });

  test("revokes against the stored environment even after an environment switch", async () => {
    const { service, protocol } = harness();
    protocol.environment.mockReturnValue("production");

    await expect(
      service.revoke({
        organizationId: "org-a",
        connectionId: "11111111-1111-4111-8111-111111111111",
      }),
    ).resolves.toEqual({ revoked: true });
    expect(protocol.remove).toHaveBeenCalledWith("plaid-secret-token", "sandbox");
  });

  test("rejects legacy or malformed revoke metadata before decrypting", async () => {
    const invalidMetadata = [
      { plaid_environment: "sandbox" },
      { encryption_context: "org_bound_v1", plaid_environment: "invalid" },
    ];

    for (const connectionMetadata of invalidMetadata) {
      const { service, store, protocol } = harness(
        connection({
          connection_metadata: connectionMetadata as VendorConnection["connection_metadata"],
        }),
      );

      await expect(
        service.revoke({
          organizationId: "org-a",
          connectionId: "11111111-1111-4111-8111-111111111111",
        }),
      ).rejects.toMatchObject({ status: 409 } satisfies Partial<PlaidConnectionError>);
      expect(store.getOrgBoundAccessToken).not.toHaveBeenCalled();
      expect(protocol.remove).not.toHaveBeenCalled();
      expect(store.deleteActiveByIdForOrganization).not.toHaveBeenCalled();
    }
  });

  test("requires rotation or re-linking when the active encryption key changed", async () => {
    const { service, store, protocol } = harness();
    store.getOrgBoundAccessToken.mockRejectedValueOnce(new EncryptionKeyMismatchError());

    await expect(
      service.revoke({
        organizationId: "org-a",
        connectionId: "11111111-1111-4111-8111-111111111111",
      }),
    ).rejects.toMatchObject({
      status: 409,
      message: "This Plaid connection requires credential rotation or re-linking.",
    } satisfies Partial<PlaidConnectionError>);
    expect(protocol.remove).not.toHaveBeenCalled();
    expect(store.deleteActiveByIdForOrganization).not.toHaveBeenCalled();
  });
});
