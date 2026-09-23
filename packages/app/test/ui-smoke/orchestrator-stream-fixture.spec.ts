/** Verifies real browser EventSource updates and disconnect UI against a page-owned HTTP stream. */
import { expect, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";
import { installPersistentSseFixture } from "./helpers/persistent-sse";
import { seedStewardSession } from "./helpers/test-auth";

test("orchestrator consumes a persistent snapshot and reports an actual disconnect", async ({
  page,
}) => {
  await seedAppStorage(page);
  await seedStewardSession(page, { jwt: true });
  await installDefaultAppRoutes(page);
  const initial = {
    version: "orchestrator.widgets.v1",
    generatedAt: "2026-01-01T00:00:00.000Z",
    totalTaskCount: 0,
    tasks: [],
  };
  const stream = await installPersistentSseFixture(
    page,
    "**/api/orchestrator/widgets/stream?*",
    "snapshot",
    initial,
  );
  await openAppPath(page, "/orchestrator");
  await stream.connected;
  await expect(page.getByText("No tasks yet.", { exact: true })).toBeVisible();
  stream.send({
    ...initial,
    totalTaskCount: 1,
    tasks: [
      {
        taskId: "fixture-stream-task",
        label: "Stream-only progress receipt",
        status: "running",
        progressSummary: "Received through the open event stream",
        evidenceLinks: [],
        timestamps: {
          createdAt: initial.generatedAt,
          updatedAt: initial.generatedAt,
        },
        childTaskIds: [],
      },
    ],
  });
  await expect(
    page.getByText("Stream-only progress receipt", { exact: true }),
  ).toBeVisible();
  const disconnected = page.getByText("Orchestrator task stream disconnected", {
    exact: true,
  });
  await expect(disconnected).toHaveCount(0);
  stream.disconnect();
  await expect(disconnected).toBeVisible();
});
