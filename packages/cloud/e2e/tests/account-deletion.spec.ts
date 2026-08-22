/** Proves fail-closed account-deletion admission and zero mutation through the real local stack. */

import { createHmac } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { PLAYWRIGHT_TEST_AUTH_SECRET } from "../src/fixtures/env";
import { seedTestUser } from "../src/fixtures/seed";
import { expect, test } from "../src/helpers/test-fixtures";

test.use({ stackOptions: { frontend: false } });

test.describe("account deletion", () => {
  test("reports lifecycle unavailability and refuses deletion without mutating either tenant", async ({
    request,
    stack,
    seededUser,
  }, testInfo) => {
    const other = await seedTestUser({
      slug: `account-deletion-control-${Date.now()}`,
    });
    const { accountDeletionRequestsRepository } = await import(
      "@elizaos/cloud-shared/db/repositories/account-deletion-requests"
    );
    const { apiKeysRepository } = await import(
      "@elizaos/cloud-shared/db/repositories/api-keys"
    );
    const { organizationsRepository } = await import(
      "@elizaos/cloud-shared/db/repositories/organizations"
    );
    const { usersRepository } = await import(
      "@elizaos/cloud-shared/db/repositories/users"
    );

    const snapshot = async (userId: string, organizationId: string) => ({
      user: await usersRepository.findByIdForWrite(userId),
      organization: await organizationsRepository.findById(organizationId),
      apiKeys: await apiKeysRepository.listByUser(userId),
      receipt:
        await accountDeletionRequestsRepository.findOpenByUserAndOrganization(
          userId,
          organizationId,
        ),
    });
    const requestingBefore = await snapshot(
      seededUser.userId,
      seededUser.organizationId,
    );
    const unrelatedBefore = await snapshot(other.userId, other.organizationId);
    const stewardBefore = [...stack.mocks.steward.users.entries()].sort();

    const payload = Buffer.from(
      JSON.stringify({
        userId: seededUser.userId,
        organizationId: seededUser.organizationId,
        exp: Math.floor(Date.now() / 1000) + 60 * 60,
      }),
    ).toString("base64url");
    const signature = createHmac("sha256", PLAYWRIGHT_TEST_AUTH_SECRET)
      .update(payload)
      .digest("base64url");
    const headers = {
      cookie: `eliza-test-auth=1; eliza-test-session=${payload}.${signature}`,
    };
    const availabilityResponse = await request.get(
      `${stack.urls.api}/api/v1/me/account-deletion`,
      { headers },
    );
    expect(availabilityResponse.status()).toBe(200);
    expect(await availabilityResponse.json()).toEqual({
      status: "lifecycle_unavailable",
      request: null,
      support: {
        email: "support@eliza.cloud",
        href: "mailto:support@eliza.cloud?subject=Eliza%20account%20deletion%20request",
      },
    });

    const submit = async (confirmation: string) => {
      const response = await request.post(
        `${stack.urls.api}/api/v1/me/account-deletion`,
        {
          headers: { ...headers, origin: stack.urls.api },
          data: { confirmation },
        },
      );
      return { status: response.status(), body: await response.json() };
    };

    const unconfirmed = await submit("delete");
    expect(unconfirmed).toMatchObject({
      status: 400,
      body: { code: "confirmation_required" },
    });

    const refused = await submit("DELETE");
    expect(refused).toEqual({
      status: 409,
      body: {
        error:
          "Permanent account deletion is unavailable until lifecycle recovery and provider reconciliation are reserved",
        code: "LIFECYCLE_RESERVATION_REQUIRED",
      },
    });

    const requestingAfter = await snapshot(
      seededUser.userId,
      seededUser.organizationId,
    );
    const unrelatedAfter = await snapshot(other.userId, other.organizationId);
    const stewardAfter = [...stack.mocks.steward.users.entries()].sort();
    const requestingUnchanged = isDeepStrictEqual(
      requestingAfter,
      requestingBefore,
    );
    const unrelatedUnchanged = isDeepStrictEqual(
      unrelatedAfter,
      unrelatedBefore,
    );
    const stewardUnchanged = isDeepStrictEqual(stewardAfter, stewardBefore);
    expect(requestingUnchanged).toBe(true);
    expect(unrelatedUnchanged).toBe(true);
    expect(stewardUnchanged).toBe(true);
    expect(requestingAfter.receipt).toBeUndefined();
    expect(unrelatedAfter.receipt).toBeUndefined();

    await testInfo.attach("account-deletion-zero-mutation-proof", {
      body: Buffer.from(
        JSON.stringify(
          {
            availabilityStatus: "lifecycle_unavailable",
            lowercaseConfirmationStatus: unconfirmed.status,
            exactConfirmationStatus: refused.status,
            exactConfirmationCode: refused.body.code,
            requestingTenantUnchanged: requestingUnchanged,
            unrelatedTenantUnchanged: unrelatedUnchanged,
            stewardStateUnchanged: stewardUnchanged,
            requestingReceiptCreated: requestingAfter.receipt !== undefined,
            unrelatedReceiptCreated: unrelatedAfter.receipt !== undefined,
          },
          null,
          2,
        ),
      ),
      contentType: "application/json",
    });
  });
});
