/**
 * Proves native Smithers authoring, trigger dispatch, execution, and persistence
 * through the production browser surface and a real local elizaOS runtime.
 */

import { expect, test } from "@playwright/test";
import { openAppPath, seedAppStorage } from "./helpers";

const REAL_WORKFLOW_STACK =
  process.env.ELIZA_UI_SMOKE_REAL_LOCAL_STACK === "1" &&
  process.env.ELIZA_UI_SMOKE_WORKFLOW_JOURNEY === "1";

type WorkflowRecord = {
  active?: boolean;
  id: string;
  name?: string;
  source?: string;
};

type WorkflowExecution = {
  finished?: boolean;
  id: string;
  mode?: string;
  output?: unknown;
  status?: string;
};

type TriggerRecord = {
  eventKind?: string;
  id: string;
  kind?: string;
  runCount?: number;
  workflowId?: string;
};

const SOURCE = `/** @jsxImportSource smthrs */
import { createSmithers } from "smthrs/create";
import { z } from "zod";

const { Workflow, Task, smithers, outputs } = createSmithers(
  { output: z.object({ message: z.string() }) },
  { dbPath: process.env.ELIZA_SMTHRS_DB_PATH },
);
const agent = globalThis.__elizaSmithers.agent;

export default smithers(() => (
  <Workflow name="Real browser digest">
    <Task id="run" output={outputs.output} agent={agent}>
      Return the deterministic browser-test digest.
    </Task>
  </Workflow>
));`;

test.describe("real local workflow journey", () => {
  test.skip(
    !REAL_WORKFLOW_STACK,
    "requires real-local stack with ELIZA_UI_SMOKE_WORKFLOW_JOURNEY=1",
  );
  test.setTimeout(180_000);

  test("creates, triggers, runs, inspects, and reloads a Smithers workflow", async ({
    page,
  }) => {
    await seedAppStorage(page);
    await openAppPath(page, "/automations");
    await expect(page.getByTestId("automations-shell")).toBeVisible({
      timeout: 60_000,
    });

    await page.getByRole("button", { name: "New automation" }).click();
    await page.getByRole("button", { name: "New workflow" }).click();
    await expect(page.getByTestId("workflow-studio")).toBeVisible();
    await expect(page.getByTestId("smithers-canvas")).toBeVisible();

    await page.getByLabel("Workflow name").fill("Real browser digest");
    await page.getByRole("button", { name: "Source" }).click();
    await page.getByTestId("smithers-source-editor").fill(SOURCE);

    const createResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/workflow/workflows",
    );
    await page.getByLabel("Save workflow").click();
    const createResponse = await createResponsePromise;
    expect(createResponse.status()).toBe(201);
    const workflow = (await createResponse.json()) as WorkflowRecord;
    expect(workflow).toMatchObject({
      name: "Real browser digest",
      active: false,
    });
    expect(workflow.id).toBeTruthy();
    expect(workflow.source).toContain('from "smthrs/create"');

    await page.getByRole("button", { name: "Add workflow trigger" }).click();
    await page.getByRole("button", { name: "Event" }).click();
    const createTriggerResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/triggers",
    );
    await page.getByRole("button", { name: "Save trigger" }).click();
    const createTriggerResponse = await createTriggerResponsePromise;
    expect(createTriggerResponse.status()).toBe(201);

    const triggerListResponse = await page.request.get("/api/triggers");
    expect(triggerListResponse.ok()).toBe(true);
    const triggerList = (await triggerListResponse.json()) as {
      triggers: TriggerRecord[];
    };
    const trigger = triggerList.triggers.find(
      (candidate) => candidate.workflowId === workflow.id,
    );
    expect(trigger).toMatchObject({
      eventKind: "MESSAGE_RECEIVED",
      kind: "workflow",
      runCount: 0,
      workflowId: workflow.id,
    });

    await page.getByLabel("Enable workflow").click();
    await expect
      .poll(async () => {
        const response = await page.request.get(
          `/api/workflow/workflows/${workflow.id}`,
        );
        return ((await response.json()) as WorkflowRecord).active;
      })
      .toBe(true);

    const triggerResponse = await page.request.post(
      `/api/triggers/${trigger?.id}/execute`,
    );
    const triggerResponseText = await triggerResponse.text();
    expect(
      triggerResponse.ok(),
      `trigger execution failed: ${triggerResponse.status()} ${triggerResponseText}`,
    ).toBe(true);

    let triggeredExecution: WorkflowExecution | undefined;
    await expect
      .poll(
        async () => {
          const response = await page.request.get(
            `/api/workflow/workflows/${workflow.id}/executions`,
          );
          const body = (await response.json()) as {
            executions: WorkflowExecution[];
          };
          triggeredExecution = body.executions.find(
            (execution) => execution.mode === "trigger",
          );
          return triggeredExecution?.status;
        },
        { timeout: 60_000 },
      )
      .toBe("finished");
    expect(triggeredExecution).toMatchObject({
      finished: true,
      mode: "trigger",
      output: [{ message: "Digest ready" }],
    });

    await page.getByRole("button", { name: "Runs" }).click();
    await page.getByRole("button", { name: "Refresh runs" }).click();
    await expect(page.getByText("Digest ready")).toBeVisible();

    await page.getByRole("button", { name: "Run", exact: true }).click();
    await expect
      .poll(
        async () => {
          const response = await page.request.get(
            `/api/workflow/workflows/${workflow.id}/executions`,
          );
          const body = (await response.json()) as {
            executions: WorkflowExecution[];
          };
          return body.executions.filter(
            (execution) => execution.status === "finished",
          ).length;
        },
        { timeout: 60_000 },
      )
      .toBe(2);
    await expect(page.getByText("Digest ready")).toBeVisible();

    await page.evaluate((workflowId) => {
      window.location.hash = `#automations/${workflowId}`;
    }, workflow.id);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Source" }).click();
    await expect(page.getByTestId("smithers-source-editor")).toHaveValue(
      /Real browser digest/,
      { timeout: 60_000 },
    );
    await expect(page.getByTitle("Message")).toBeVisible();
  });
});
