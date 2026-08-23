/** Exercises account-deletion request and isolation through the real local Worker route. */

import { seedTestUser } from "../src/fixtures/seed";
import { expect, test } from "../src/helpers/test-fixtures";

test.describe("account deletion", () => {
  test("fails closed without mutating the account or another tenant", async ({
    authenticatedPage,
    stack,
    seededUser,
  }) => {
    const other = await seedTestUser({
      slug: `account-deletion-control-${Date.now()}`,
    });
    await authenticatedPage.goto(
      `${stack.urls.frontend}/account-deletion?requested=untrusted-receipt`,
    );
    await expect(
      authenticatedPage.getByRole("heading", {
        name: "Delete your account and data",
      }),
    ).toBeVisible();
    await expect(
      authenticatedPage.getByRole("heading", { name: "Deletion scheduled" }),
    ).toHaveCount(0);
    const request = (method: "GET" | "POST", confirmation?: string) =>
      authenticatedPage.evaluate(
        async ({ method, confirmation }) => {
          const response = await fetch("/api/v1/me/account-deletion", {
            method,
            headers: { "content-type": "application/json" },
            body:
              confirmation === undefined
                ? undefined
                : JSON.stringify({ confirmation }),
          });
          return { status: response.status, body: await response.json() };
        },
        { method, confirmation },
      );

    const initial = await request("GET");
    expect(initial.status).toBe(200);
    expect(initial.body).toEqual({
      state: "lifecycle_unavailable",
      request: null,
      code: "LIFECYCLE_RESERVATION_REQUIRED",
      message:
        "Permanent account deletion is unavailable until lifecycle recovery and provider reconciliation are reserved",
    });

    const trigger = authenticatedPage.getByTestId("delete-account-trigger");
    await expect(trigger).toBeVisible();
    await expect(trigger).toBeDisabled();
    await expect(trigger).toHaveText("Deletion unavailable");

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

    const stewardStateBefore = stack.mocks.steward.users.get(
      seededUser.stewardUserId,
    );
    const userBefore = await usersRepository.findByIdForWrite(
      seededUser.userId,
    );
    const organizationBefore = await organizationsRepository.findById(
      seededUser.organizationId,
    );
    const [keyBefore] = await apiKeysRepository.listByUser(seededUser.userId);
    const [otherKeyBefore] = await apiKeysRepository.listByUser(other.userId);
    const otherStewardStateBefore = stack.mocks.steward.users.get(
      other.stewardUserId,
    );
    expect(
      await accountDeletionRequestsRepository.findOpenByUserId(
        other.userId,
        true,
      ),
    ).toBeUndefined();

    const unconfirmed = await request("POST", "delete");
    expect(unconfirmed).toEqual({
      status: 400,
      body: {
        error: "Type DELETE to confirm permanent account deletion",
        code: "confirmation_required",
      },
    });
    const refused = await request("POST", "DELETE");
    expect(refused).toEqual({
      status: 409,
      body: {
        error:
          "Permanent account deletion is unavailable until lifecycle recovery and provider reconciliation are reserved",
        code: "LIFECYCLE_RESERVATION_REQUIRED",
      },
    });

    const userAfter = await usersRepository.findByIdForWrite(seededUser.userId);
    const organizationAfter = await organizationsRepository.findById(
      seededUser.organizationId,
    );
    const [keyAfter] = await apiKeysRepository.listByUser(seededUser.userId);
    const [otherKeyAfter] = await apiKeysRepository.listByUser(other.userId);
    const otherUser = await usersRepository.findByIdForWrite(other.userId);
    const otherOrganization = await organizationsRepository.findById(
      other.organizationId,
    );

    expect(userAfter).toMatchObject({
      is_active: userBefore?.is_active,
      deleted_at: userBefore?.deleted_at,
    });
    expect(organizationAfter).toMatchObject({
      is_active: organizationBefore?.is_active,
    });
    expect(keyAfter).toMatchObject({ is_active: keyBefore?.is_active });
    expect(stack.mocks.steward.users.get(seededUser.stewardUserId)).toBe(
      stewardStateBefore,
    );
    expect(
      await accountDeletionRequestsRepository.findOpenByUserId(
        seededUser.userId,
        true,
      ),
    ).toBeUndefined();
    expect(otherUser).toMatchObject({ is_active: true });
    expect(otherOrganization).toMatchObject({ is_active: true });
    expect(otherKeyAfter).toMatchObject({
      id: otherKeyBefore?.id,
      is_active: otherKeyBefore?.is_active,
    });
    expect(stack.mocks.steward.users.get(other.stewardUserId)).toBe(
      otherStewardStateBefore,
    );
    expect(
      await accountDeletionRequestsRepository.findOpenByUserId(
        other.userId,
        true,
      ),
    ).toBeUndefined();

    const after = await request("GET");
    expect(after).toEqual(initial);
  });
});
