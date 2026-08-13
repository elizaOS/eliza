/**
 * Exercises native Smithers authoring, persistence, execution, and run inspection
 * through the app against deterministic HTTP fixtures.
 */
// @eliza-live-audit allow-route-fixtures
import { expect, type Page, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";

type WorkflowDefinition = {
  id: string;
  name: string;
  description: string;
  source: string;
  language: "tsx";
  active: boolean;
  steps: Array<{ id: string; label: string; kind: "task"; agent: string }>;
  widgets: Array<{
    id: string;
    title: string;
    surface: "both";
    component: "status";
  }>;
  versionId: string;
  createdAt: string;
  updatedAt: string;
};

async function installWorkflowApi(page: Page) {
  let saved: WorkflowDefinition | null = null;
  let createCount = 0;
  let runCount = 0;
  let execution: Record<string, unknown> | null = null;
  await page.route("**/api/workflow/workflows**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (request.method() === "POST" && pathname === "/api/workflow/workflows") {
      const body = request.postDataJSON() as Omit<
        WorkflowDefinition,
        "id" | "versionId" | "createdAt" | "updatedAt"
      >;
      const now = new Date().toISOString();
      saved = {
        ...body,
        id: "smithers-digest",
        versionId: "v1",
        createdAt: now,
        updatedAt: now,
      };
      createCount += 1;
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify(saved),
      });
      return;
    }
    if (
      request.method() === "POST" &&
      pathname === "/api/workflow/workflows/smithers-digest/run"
    ) {
      const now = new Date().toISOString();
      execution = {
        id: "run-smithers-digest-1",
        workflowId: "smithers-digest",
        workflowVersionId: "v1",
        workflowName: "Smithers digest",
        mode: "manual",
        status: "running",
        finished: false,
        startedAt: now,
        stoppedAt: null,
        input: {},
        events: [
          {
            id: "event-started",
            sequence: 1,
            runId: "run-smithers-digest-1",
            workflowId: "smithers-digest",
            timestamp: now,
            type: "workflow.started",
            nodeId: "digest",
            payload: {},
          },
        ],
      };
      runCount += 1;
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({ execution }),
      });
      return;
    }
    if (request.method() === "GET" && pathname === "/api/workflow/workflows") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ workflows: saved ? [saved] : [] }),
      });
      return;
    }
    if (
      request.method() === "GET" &&
      pathname === "/api/workflow/workflows/smithers-digest"
    ) {
      await route.fulfill({
        status: saved ? 200 : 404,
        contentType: "application/json",
        body: JSON.stringify(saved ?? { error: "not found" }),
      });
      return;
    }
    if (request.method() === "GET" && pathname.endsWith("/executions")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ executions: execution ? [execution] : [] }),
      });
      return;
    }
    if (request.method() === "GET" && pathname.endsWith("/revisions")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ currentVersionId: "v1", revisions: [] }),
      });
      return;
    }
    await route.fallback();
  });
  await page.route("**/api/workflow/executions/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (
      request.method() === "GET" &&
      pathname === "/api/workflow/executions/run-smithers-digest-1" &&
      execution
    ) {
      const stoppedAt = new Date().toISOString();
      execution = {
        ...execution,
        status: "finished",
        finished: true,
        stoppedAt,
        output: { message: "Digest ready" },
        events: [
          ...((execution.events as unknown[]) ?? []),
          {
            id: "event-finished",
            sequence: 2,
            runId: "run-smithers-digest-1",
            workflowId: "smithers-digest",
            timestamp: stoppedAt,
            type: "workflow.finished",
            nodeId: "digest",
            payload: { message: "Digest ready" },
          },
        ],
      };
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ execution }),
      });
      return;
    }
    await route.fallback();
  });
  return {
    getSaved: () => saved,
    getCreateCount: () => createCount,
    getRunCount: () => runCount,
  };
}

test.beforeEach(async ({ page }) => {
  await seedAppStorage(page);
  await installDefaultAppRoutes(page);
});

test("workflow studio creates, executes, inspects, and reloads a Smithers workflow", async ({
  page,
}) => {
  const api = await installWorkflowApi(page);
  await openAppPath(page, "/automations");
  await expect(page.getByTestId("automations-shell")).toBeVisible({
    timeout: 60_000,
  });
  await page.evaluate(() => {
    window.location.hash = "#automations/__new__";
  });

  await expect(page.getByTestId("workflow-studio")).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByTestId("smithers-canvas")).toBeVisible();
  await expect(page.getByText("Run", { exact: true })).toBeVisible();
  await page.getByLabel("Workflow name").fill("Smithers digest");
  await page.getByRole("button", { name: "Source" }).click();
  const source = `/** @jsxImportSource smthrs */
import { createSmithers } from "smthrs/create";
import { z } from "zod";
const { Workflow, Task, smithers, outputs } = createSmithers({ result: z.object({ message: z.string() }) });
const agent = globalThis.__elizaSmithers.agent;
export default smithers(() => <Workflow name="digest"><Task id="digest" output={outputs.result} agent={agent}>Create the digest.</Task></Workflow>);`;
  await page.getByTestId("smithers-source-editor").fill(source);
  await page.locator('[data-agent-id="save-workflow"]').click();

  await expect.poll(() => api.getSaved()?.name).toBe("Smithers digest");
  expect(api.getCreateCount()).toBe(1);
  expect(api.getSaved()?.source).toContain('from "smthrs/create"');
  expect(api.getSaved()).not.toHaveProperty("nodes");
  expect(api.getSaved()).not.toHaveProperty("connections");

  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect.poll(api.getRunCount).toBe(1);
  await expect(page.getByText("run-smithers").first()).toBeVisible();
  await expect(page.getByText("Digest ready")).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByText("workflow.finished")).toBeVisible();
  await expect(page.getByText("digest", { exact: true }).first()).toBeVisible();

  await page.evaluate(() => {
    window.location.hash = "#automations/smithers-digest";
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Source" }).click();
  await expect(page.getByTestId("smithers-source-editor")).toHaveValue(
    /Create the digest/,
    { timeout: 60_000 },
  );
  await expect(page.getByRole("button", { name: "Schedule" })).toBeVisible();
  expect(api.getCreateCount()).toBe(1);
  expect(api.getRunCount()).toBe(1);
});
