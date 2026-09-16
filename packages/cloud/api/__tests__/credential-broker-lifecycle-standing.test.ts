/**
 * Drives the real credential-broker route through raw compatibility auth and
 * primary lifecycle authority, proving fenced wallet/mobile callers cannot
 * dispatch an upstream provider request.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const requireAuthOrApiKeyWithOrg = mock();
const resolveInferenceAuthContext = mock();
const findWithOrganizationForWrite = mock();
const shouldBlockUser = mock();
const callProvider = mock();
const warn = mock();
const error = mock();

mock.module("@/lib/auth", () => ({ requireAuthOrApiKeyWithOrg }));
mock.module("@/lib/services/inference-auth-context", () => ({
  resolveInferenceAuthContext,
}));
mock.module("@/db/repositories/users", () => ({
  usersRepository: { findWithOrganizationForWrite },
}));
mock.module("@/lib/services/admin", () => ({
  adminService: { shouldBlockUser },
}));
mock.module("@/lib/services/oauth", () => ({
  credentialBroker: { callProvider },
  internalErrorResponse: (message: string) => ({ error: message }),
  OAuthError: class OAuthError extends Error {
    httpStatus = 400;
    toResponse() {
      return { error: this.message };
    }
  },
}));
mock.module("@/lib/utils/logger", () => ({
  logger: { warn, error },
}));

const { default: brokerRoute } = await import(
  "../v1/connections/[id]/broker/route"
);

const app = new Hono().route("/connections/:id/broker", brokerRoute);

describe("credential broker raw lifecycle standing", () => {
  beforeEach(() => {
    requireAuthOrApiKeyWithOrg.mockReset();
    resolveInferenceAuthContext.mockReset();
    findWithOrganizationForWrite.mockReset();
    shouldBlockUser.mockReset();
    callProvider.mockReset();
    warn.mockReset();
    error.mockReset();
    requireAuthOrApiKeyWithOrg.mockResolvedValue({
      user: { id: "user-1", organization_id: "org-1", organization: {} },
      authMethod: "wallet_signature",
    });
    shouldBlockUser.mockResolvedValue(false);
  });

  test.each([
    [
      "wallet",
      {
        "x-wallet-address": "0x0000000000000000000000000000000000000001",
        "x-wallet-signature": "signed",
        "x-timestamp": "1",
      },
      {
        id: "user-1",
        organization_id: "org-1",
        is_active: false,
        organization: {
          id: "org-1",
          is_active: true,
          account_lifecycle_state: "active",
          account_lifecycle_revision: 1,
          account_deletion_request_id: null,
        },
      },
      "account_inactive",
    ],
    [
      "mobile key",
      { "x-api-key": "eliza_mobile_test" },
      {
        id: "user-1",
        organization_id: "org-1",
        is_active: true,
        organization: {
          id: "org-1",
          is_active: false,
          account_lifecycle_state: "active",
          account_lifecycle_revision: 1,
          account_deletion_request_id: null,
        },
      },
      "organization_inactive",
    ],
    [
      "wallet with lifecycle fence",
      {
        "x-wallet-address": "0x0000000000000000000000000000000000000001",
        "x-wallet-signature": "signed",
        "x-timestamp": "1",
      },
      {
        id: "user-1",
        organization_id: "org-1",
        is_active: true,
        organization: {
          id: "org-1",
          is_active: true,
          account_lifecycle_state: "deletion_irreversible",
          account_lifecycle_revision: 2,
          account_deletion_request_id: null,
        },
      },
      "organization_inactive",
    ],
    [
      "mobile key with deletion request",
      { "x-api-key": "eliza_mobile_test" },
      {
        id: "user-1",
        organization_id: "org-1",
        is_active: true,
        organization: {
          id: "org-1",
          is_active: true,
          account_lifecycle_state: "active",
          account_lifecycle_revision: 2,
          account_deletion_request_id: "00000000-0000-4000-8000-000000000001",
        },
      },
      "organization_inactive",
    ],
  ])(
    "fences a lifecycle-inactive %s before provider dispatch",
    async (_name, authHeaders, current, reason) => {
      findWithOrganizationForWrite.mockResolvedValueOnce(current);

      const response = await app.request("/connections/connection-1/broker", {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders },
        body: JSON.stringify({
          method: "GET",
          url: "https://provider.test/me",
        }),
      });

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        code: "access_denied",
        details: { reason },
      });
      expect(requireAuthOrApiKeyWithOrg).toHaveBeenCalledTimes(1);
      expect(resolveInferenceAuthContext).not.toHaveBeenCalled();
      expect(findWithOrganizationForWrite).toHaveBeenCalledTimes(1);
      expect(shouldBlockUser).not.toHaveBeenCalled();
      expect(callProvider).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        "[PaidRouteStanding] blocked external work",
        expect.objectContaining({ reason, providerDispatched: false }),
      );
    },
  );
});
