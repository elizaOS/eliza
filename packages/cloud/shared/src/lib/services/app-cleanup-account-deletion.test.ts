/** Ensures account erasure cannot orphan an asynchronously deleting app container. */

import { expect, mock, test } from "bun:test";

const deleteApp = mock(async () => undefined);
mock.module("./apps", () => ({
  appsService: {
    getById: mock(async () => ({ id: "app-1", organization_id: "org-1", github_repo: null })),
    delete: deleteApp,
  },
}));
mock.module("../utils/logger", () => ({
  logger: { info: mock(() => undefined), error: mock(() => undefined) },
}));

const { deleteAppWithCleanup } = await import("./app-cleanup");

test("keeps the app row discoverable while account-deletion container teardown is pending", async () => {
  const result = await deleteAppWithCleanup("app-1", {
    continueOnError: false,
    requireContainerTeardownCompletion: true,
    containerTeardown: {
      findContainers: mock(async () => [{ id: "container-1" }]),
      markStoppedForBilling: mock(async () => undefined),
      jobsWriter: { insertJob: mock(async () => ({ id: "job-1" })) },
    },
  });

  expect(result.success).toBe(false);
  expect(result.errors).toContain(
    "Container teardown was queued and must complete before app deletion",
  );
  expect(deleteApp).not.toHaveBeenCalled();
});
