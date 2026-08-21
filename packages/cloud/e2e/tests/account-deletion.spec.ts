/** Exercises account-deletion request and isolation through the real local Worker route. */

import { seedTestUser } from "../src/fixtures/seed";
import { expect, test } from "../src/helpers/test-fixtures";

test.describe("account deletion", () => {
  test("requires confirmation, deactivates immediately, and preserves another tenant", async ({
    authenticatedPage,
    stack,
    seededUser,
  }) => {
    const other = await seedTestUser({
      slug: `account-deletion-control-${Date.now()}`,
    });
    await authenticatedPage.goto(`${stack.urls.frontend}/account-deletion`);
    await expect(
      authenticatedPage.getByRole("heading", {
        name: "Delete your account and data",
      }),
    ).toBeVisible();
    const trigger = authenticatedPage.getByTestId("delete-account-trigger");
    await expect(trigger).toBeVisible();
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
    expect(initial.body).toEqual({ request: null });

    const unconfirmed = await request("POST", "delete");
    expect(unconfirmed.status).toBe(400);
    expect(stack.mocks.steward.users.has(seededUser.stewardUserId)).toBe(false);

    await trigger.click();
    const confirm = authenticatedPage.getByTestId("delete-account-confirm");
    await expect(confirm).toBeDisabled();
    await authenticatedPage.getByLabel("Type DELETE to confirm").fill("DELETE");
    await expect(confirm).toBeEnabled();
    const scheduledResponsePromise = authenticatedPage.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/v1/me/account-deletion",
    );
    await confirm.click();
    const scheduledResponse = await scheduledResponsePromise;
    expect(scheduledResponse.status()).toBe(202);
    const payload = (await scheduledResponse.json()) as {
      request?: {
        requestId?: string;
        status?: string;
        scheduledDeletionAt?: string;
      };
    };
    expect(payload.request?.requestId).toBeTruthy();
    expect(payload.request?.status).toBe("scheduled");
    expect(
      Date.parse(payload.request?.scheduledDeletionAt ?? ""),
    ).toBeGreaterThan(Date.now());
    await expect(
      authenticatedPage.getByRole("heading", { name: "Deletion scheduled" }),
    ).toBeVisible();
    expect(stack.mocks.steward.users.get(seededUser.stewardUserId)).toBe(
      "deactivated",
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

    const deletedUser = await usersRepository.findByIdForWrite(
      seededUser.userId,
    );
    const deletedOrganization = await organizationsRepository.findById(
      seededUser.organizationId,
    );
    const [deletedKey] = await apiKeysRepository.listByUser(seededUser.userId);
    const otherUser = await usersRepository.findByIdForWrite(other.userId);
    const otherOrganization = await organizationsRepository.findById(
      other.organizationId,
    );

    expect(deletedUser).toMatchObject({ is_active: false });
    expect(deletedUser?.deleted_at).toBeInstanceOf(Date);
    expect(deletedOrganization).toMatchObject({ is_active: false });
    expect(deletedKey).toMatchObject({ is_active: false });
    expect(otherUser).toMatchObject({ is_active: true });
    expect(otherOrganization).toMatchObject({ is_active: true });

    const rejectedAfterDeactivation = await request("GET");
    expect(rejectedAfterDeactivation.status).toBe(401);
  });
});
