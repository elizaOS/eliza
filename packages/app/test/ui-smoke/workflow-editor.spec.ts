/**
 * Exercises the workflow editor against deterministic HTTP fixtures, including
 * persistence, graph rendering, and invalid execution timestamps at desktop and
 * mobile sizes. The route fixtures are the system boundary under test here.
 */
// @eliza-live-audit allow-route-fixtures

import { writeFile } from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";

type WorkflowConnectionMap = Record<
  string,
  { main?: Array<Array<{ node: string; type: "main"; index: number }>> }
>;

type WorkflowNode = {
  id?: string;
  name: string;
  type: string;
  typeVersion: number;
  position: [number, number];
  parameters: Record<string, unknown>;
};

type WorkflowWriteRequest = {
  name: string;
  nodes: WorkflowNode[];
  connections: WorkflowConnectionMap;
  settings?: Record<string, unknown>;
};

type WorkflowDefinition = WorkflowWriteRequest & {
  id: string;
  active: boolean;
  versionId: string;
  nodeCount: number;
};

const SAVED_WORKFLOW: WorkflowDefinition = {
  ...workflowDraft(),
  id: "workflow-matrix-digest",
  active: false,
  versionId: "version-1",
  nodeCount: 2,
};

const INVALID_DATE_EXECUTION = {
  id: "execution-invalid-stop",
  workflowId: SAVED_WORKFLOW.id,
  status: "success",
  startedAt: "2026-06-23T00:00:00.000Z",
  stoppedAt: "",
  mode: "manual",
  data: {
    resultData: {
      lastNodeExecuted: "Add Summary Param",
      runData: {},
    },
  },
};

function workflowDraft(): WorkflowWriteRequest {
  return {
    name: "Matrix message digest",
    nodes: [
      {
        id: "manual",
        name: "Manual Trigger",
        type: "workflows-nodes-base.manualTrigger",
        typeVersion: 1,
        position: [0, 0],
        parameters: {},
      },
      {
        id: "set-summary",
        name: "Add Summary Param",
        type: "workflows-nodes-base.set",
        typeVersion: 1,
        position: [260, 0],
        parameters: { summary: "matrix smoke digest" },
      },
    ],
    connections: {
      "Manual Trigger": {
        main: [[{ node: "Add Summary Param", type: "main", index: 0 }]],
      },
    },
    settings: { saveDataSuccessExecution: "all" },
  };
}

async function installWorkflowApi(
  page: Page,
  initialWorkflow: WorkflowDefinition | null = null,
): Promise<{
  getSavedWorkflow: () => WorkflowDefinition | null;
  getLastSaveBody: () => WorkflowWriteRequest | null;
}> {
  let savedWorkflow: WorkflowDefinition | null = initialWorkflow;
  let lastSaveBody: WorkflowWriteRequest | null = null;

  await page.route("**/api/lifeops/scheduled-tasks**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ tasks: [] }),
    });
  });

  await page.route("**/api/workflow/workflows**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const pathname = url.pathname;

    if (method === "POST" && pathname === "/api/workflow/workflows") {
      lastSaveBody = request.postDataJSON() as WorkflowWriteRequest;
      savedWorkflow = {
        ...lastSaveBody,
        id: "workflow-matrix-digest",
        active: false,
        versionId: "version-1",
        nodeCount: lastSaveBody.nodes.length,
      };
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify(savedWorkflow),
      });
      return;
    }

    if (method === "GET" && pathname === "/api/workflow/workflows") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          workflows: savedWorkflow
            ? [{ ...savedWorkflow, nodes: undefined, connections: undefined }]
            : [],
        }),
      });
      return;
    }

    if (
      method === "GET" &&
      pathname === "/api/workflow/workflows/workflow-matrix-digest"
    ) {
      await route.fulfill({
        status: savedWorkflow ? 200 : 404,
        contentType: "application/json",
        body: JSON.stringify(
          savedWorkflow ?? { error: "workflow not saved yet" },
        ),
      });
      return;
    }

    if (
      method === "GET" &&
      pathname === "/api/workflow/workflows/workflow-matrix-digest/executions"
    ) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ executions: [INVALID_DATE_EXECUTION] }),
      });
      return;
    }

    if (
      method === "GET" &&
      pathname === "/api/workflow/workflows/workflow-matrix-digest/revisions"
    ) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ currentVersionId: "version-1", revisions: [] }),
      });
      return;
    }

    await route.fallback();
  });

  return {
    getSavedWorkflow: () => savedWorkflow,
    getLastSaveBody: () => lastSaveBody,
  };
}

test.beforeEach(async ({ page }) => {
  await seedAppStorage(page);
  await installDefaultAppRoutes(page);
});

test.use({ video: { mode: "on", size: { width: 1440, height: 900 } } });

test("workflow editor saves a connected graph and reloads the persisted definition", async ({
  page,
}) => {
  const api = await installWorkflowApi(page);
  const saveStatuses: number[] = [];
  page.on("response", (response) => {
    if (
      response.request().method() === "POST" &&
      /\/api\/workflow\/workflows(?:\?|$)/.test(response.url())
    ) {
      saveStatuses.push(response.status());
    }
  });

  await openAppPath(page, "/automations");
  await expect(page.getByTestId("automations-shell")).toBeVisible({
    timeout: 60_000,
  });

  await page.evaluate(() => {
    window.location.hash = "#automations/__new__";
  });

  const editor = page.getByTestId("workflow-editor-json");
  await expect(editor).toBeVisible({ timeout: 60_000 });
  await editor.fill(JSON.stringify(workflowDraft(), null, 2));
  await expect(editor).toHaveValue(/Matrix message digest/);

  await expect(
    page.getByRole("img", {
      name: "Workflow graph with 2 nodes and 1 connections",
    }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("rf__node-manual")).toContainText(
    "Manual Trigger",
  );
  await expect(page.getByTestId("rf__node-set-summary")).toContainText(
    "Add Summary Param",
  );

  const save = page.locator('[data-agent-id="save"]');
  await expect(save).toBeEnabled({ timeout: 15_000 });
  await save.click();

  await expect
    .poll(() => saveStatuses.some((status) => status >= 200 && status < 300), {
      message: "workflow save should receive a 2xx POST",
    })
    .toBe(true);

  expect(api.getLastSaveBody()).toMatchObject({
    name: "Matrix message digest",
    connections: {
      "Manual Trigger": {
        main: [[{ node: "Add Summary Param", type: "main", index: 0 }]],
      },
    },
  });
  expect(
    api
      .getLastSaveBody()
      ?.nodes.find((node) => node.name === "Add Summary Param")?.parameters,
  ).toMatchObject({ summary: "matrix smoke digest" });

  await expect
    .poll(() => api.getSavedWorkflow()?.id)
    .toBe("workflow-matrix-digest");

  await page.evaluate(() => {
    window.location.hash = "#automations/workflow-matrix-digest";
  });
  await page.reload({ waitUntil: "domcontentloaded" });

  await expect(page.getByTestId("workflow-editor-json")).toHaveValue(
    /Matrix message digest/,
    { timeout: 60_000 },
  );
  await expect(page.getByTestId("workflow-editor-json")).toHaveValue(
    /matrix smoke digest/,
  );
  await expect(page.getByTestId("rf__node-manual")).toContainText(
    "Manual Trigger",
    {
      timeout: 15_000,
    },
  );
  await expect(page.getByTestId("rf__node-set-summary")).toContainText(
    "Add Summary Param",
    {
      timeout: 15_000,
    },
  );
});

test("workflow run renders an explicit invalid-date state on desktop and mobile", async ({
  page,
}, testInfo) => {
  await installWorkflowApi(page, SAVED_WORKFLOW);
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("requestfailed", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/")) {
      failedRequests.push(`${request.method()} ${request.url()}`);
    }
  });

  await openAppPath(page, `/automations#automations/${SAVED_WORKFLOW.id}`);
  await expect(page.getByTestId("workflow-editor-json")).toHaveValue(
    /Matrix message digest/,
    { timeout: 60_000 },
  );
  const desktopPath = testInfo.outputPath("workflow-invalid-date-desktop.jpg");
  await page.screenshot({
    path: desktopPath,
    fullPage: true,
    type: "jpeg",
    quality: 88,
  });
  await testInfo.attach("workflow-invalid-date-desktop.jpg", {
    path: desktopPath,
    contentType: "image/jpeg",
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByText("Invalid date", { exact: false })
    .first()
    .scrollIntoViewIfNeeded();
  const mobilePath = testInfo.outputPath("workflow-invalid-date-mobile.jpg");
  await page.screenshot({
    path: mobilePath,
    fullPage: true,
    type: "jpeg",
    quality: 88,
  });
  await testInfo.attach("workflow-invalid-date-mobile.jpg", {
    path: mobilePath,
    contentType: "image/jpeg",
  });
  const mobileRunsPath = testInfo.outputPath(
    "workflow-invalid-date-mobile-runs.jpg",
  );
  await page
    .getByText("Runs", { exact: true })
    .locator("../../..")
    .screenshot({ path: mobileRunsPath, type: "jpeg", quality: 88 });
  await testInfo.attach("workflow-invalid-date-mobile-runs.jpg", {
    path: mobileRunsPath,
    contentType: "image/jpeg",
  });

  const logsPath = testInfo.outputPath(
    "workflow-invalid-date-frontend-logs.json",
  );
  await writeFile(
    logsPath,
    `${JSON.stringify({ consoleErrors, failedRequests }, null, 2)}\n`,
  );
  await testInfo.attach("workflow-invalid-date-frontend-logs.json", {
    path: logsPath,
    contentType: "application/json",
  });
  await expect(page.getByText("Invalid date", { exact: false })).toHaveCount(2);
  expect(consoleErrors).toEqual([]);
  expect(failedRequests).toEqual([]);
});
