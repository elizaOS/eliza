/** Exercises account-deletion request and isolation through the real local Worker route. */

import { seedTestUser } from "../src/fixtures/seed";
import { expect, test } from "../src/helpers/test-fixtures";

test.describe("account deletion", () => {
  test("requests, fences, reports, and cancels without crossing tenants", async ({
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
      statusCredential?: string;
      recoveryCredential?: string;
    };
    expect(payload.request?.requestId).toBeTruthy();
    const requestId = payload.request?.requestId;
    expect(payload.statusCredential).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(payload.recoveryCredential).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const statusCredential = payload.statusCredential;
    const recoveryCredential = payload.recoveryCredential;
    if (!statusCredential || !recoveryCredential) {
      throw new Error("Deletion response omitted its opaque capabilities");
    }
    expect(payload.request?.status).toBe("reserved");
    expect(
      Date.parse(payload.request?.scheduledDeletionAt ?? ""),
    ).toBeGreaterThan(Date.now());
    await expect(
      authenticatedPage.getByRole("heading", {
        name: "Deletion request reserved",
      }),
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

    expect(deletedUser).toMatchObject({
      is_active: false,
      deleted_at: null,
      account_lifecycle_state: "deletion_recovery",
      account_deletion_request_id: requestId,
    });
    expect(deletedUser?.auth_fenced_at).toBeInstanceOf(Date);
    expect(deletedOrganization).toMatchObject({
      is_active: false,
      account_lifecycle_state: "deletion_recovery",
      account_deletion_request_id: requestId,
    });
    expect(deletedKey).toMatchObject({ is_active: false });
    expect(otherUser).toMatchObject({ is_active: true });
    expect(otherOrganization).toMatchObject({ is_active: true });

    const rejectedAfterDeactivation = await request("GET");
    expect(rejectedAfterDeactivation.status).toBe(403);

    const publicStatus = await authenticatedPage.evaluate(
      async (statusCredential) => {
        const response = await fetch("/api/public/account-deletion", {
          headers: { "X-Account-Deletion-Status": statusCredential },
        });
        return { status: response.status, body: await response.json() };
      },
      statusCredential,
    );
    expect(publicStatus).toMatchObject({
      status: 200,
      body: {
        request: {
          requestId,
          status: "reserved",
          accessState: "fenced",
          canCancel: true,
        },
      },
    });

    const canceled = await authenticatedPage.evaluate(
      async (recoveryCredential) => {
        const response = await fetch("/api/public/account-deletion", {
          method: "DELETE",
          headers: {
            "content-type": "application/json",
            "X-Account-Deletion-Recovery": recoveryCredential,
          },
          body: JSON.stringify({ confirmation: "CANCEL DELETION" }),
        });
        return { status: response.status, body: await response.json() };
      },
      recoveryCredential,
    );
    expect(canceled).toMatchObject({
      status: 200,
      body: {
        request: {
          requestId,
          status: "canceling",
          accessState: "fenced",
          canCancel: false,
          nextAction: "wait_for_reconciliation",
        },
      },
    });
    expect(stack.mocks.steward.users.get(seededUser.stewardUserId)).toBe(
      "active",
    );

    const cancelingUser = await usersRepository.findByIdForWrite(
      seededUser.userId,
    );
    const cancelingOrganization = await organizationsRepository.findById(
      seededUser.organizationId,
    );
    const [stillRevokedKey] = await apiKeysRepository.listByUser(
      seededUser.userId,
    );
    expect(cancelingUser).toMatchObject({
      is_active: false,
      account_lifecycle_state: "deletion_recovery",
      account_deletion_request_id: requestId,
    });
    expect(cancelingOrganization).toMatchObject({
      is_active: false,
      account_lifecycle_state: "deletion_recovery",
      account_deletion_request_id: requestId,
    });
    expect(stillRevokedKey).toMatchObject({ is_active: false });

    const stillFenced = await request("GET");
    expect(stillFenced.status).toBe(403);
  });
});
