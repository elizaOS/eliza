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
  steps?: Array<{ id: string; label: string }>;
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
  eventFilter?: Record<string, unknown>;
  id: string;
  kind?: string;
  runCount?: number;
  workflowId?: string;
};

function executionMessage(execution?: WorkflowExecution): string | undefined {
  const first = Array.isArray(execution?.output)
    ? execution.output[0]
    : undefined;
  if (!first || typeof first !== "object") return undefined;
  const message = (first as { message?: unknown }).message;
  return typeof message === "string" && message.trim() ? message : undefined;
}

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
    <Task id="run" output={outputs.output} agent={agent} retries={2}>
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
    const suffix = Date.now().toString(36);
    const sourceName = `Native event source ${suffix}`;
    const targetName = `Real browser digest ${suffix}`;

    await seedAppStorage(page);
    await openAppPath(page, "/automations");
    await expect(page.getByTestId("automations-shell")).toBeVisible({
      timeout: 60_000,
    });

    const createSourceResponse = await page.request.post(
      "/api/workflow/workflows",
      {
        data: {
          name: sourceName,
          source: SOURCE,
          language: "tsx",
          steps: [{ id: "run", label: "Run", kind: "task" }],
        },
      },
    );
    const createSourceText = await createSourceResponse.text();
    expect(
      createSourceResponse.status(),
      `source creation failed: ${createSourceText}`,
    ).toBe(201);
    const sourceWorkflow = JSON.parse(createSourceText) as WorkflowRecord;
    expect(sourceWorkflow.steps).toContainEqual(
      expect.objectContaining({ id: "run" }),
    );

    await page.getByRole("button", { name: "New automation" }).click();
    await page.getByRole("button", { name: "New workflow" }).click();
    await expect(page.getByTestId("workflow-studio")).toBeVisible();
    await expect(page.getByTestId("smithers-canvas")).toBeVisible();

    await page.getByLabel("Workflow name").fill(targetName);
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
      name: targetName,
      active: false,
    });
    expect(workflow.id).toBeTruthy();
    expect(workflow.source).toContain('from "smthrs/create"');
    expect(workflow.source).toContain("retries={2}");

    const addWidgetResponse = await page.request.put(
      `/api/workflow/workflows/${workflow.id}`,
      {
        data: {
          ...workflow,
          widgets: [
            {
              id: "message",
              title: "Message",
              surface: "both",
              component: "markdown",
              dataPath: "0.message",
            },
          ],
        },
      },
    );
    expect(
      addWidgetResponse.ok(),
      `widget manifest update failed: ${await addWidgetResponse.text()}`,
    ).toBe(true);

    await page.getByRole("button", { name: "Add workflow trigger" }).click();
    await page.getByRole("button", { name: "Event" }).click();
    await page.getByLabel("Event source").selectOption("step");
    await page.getByLabel("Source workflow").selectOption(sourceWorkflow.id);
    await page.getByLabel("Source step").selectOption("run");
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
      eventKind: "workflow_run_event",
      eventFilter: {
        event: {
          type: "NodeFinished",
          workflowId: sourceWorkflow.id,
          nodeId: "run",
        },
      },
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

    const activateSourceResponse = await page.request.post(
      `/api/workflow/workflows/${sourceWorkflow.id}/activate`,
    );
    const activateSourceText = await activateSourceResponse.text();
    expect(
      activateSourceResponse.ok(),
      `source activation failed: ${activateSourceResponse.status()} ${activateSourceText}`,
    ).toBe(true);

    const sourceRunResponse = await page.request.post(
      `/api/workflow/workflows/${sourceWorkflow.id}/run`,
      { data: { input: { origin: "workflow-real-local" } } },
    );
    const sourceRunText = await sourceRunResponse.text();
    expect(
      sourceRunResponse.status(),
      `source execution failed: ${sourceRunText}`,
    ).toBe(202);

    await expect
      .poll(
        async () => {
          const response = await page.request.get(
            `/api/workflow/workflows/${sourceWorkflow.id}/executions`,
          );
          const body = (await response.json()) as {
            executions: WorkflowExecution[];
          };
          return body.executions.find(
            (execution) => execution.mode === "manual",
          )?.status;
        },
        { timeout: 120_000 },
      )
      .toBe("finished");

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
        { timeout: 120_000 },
      )
      .toBe("finished");
    expect(triggeredExecution).toMatchObject({
      finished: true,
      mode: "trigger",
    });
    await expect
      .poll(async () => {
        const response = await page.request.get("/api/triggers");
        const body = (await response.json()) as { triggers: TriggerRecord[] };
        return body.triggers.find((candidate) => candidate.id === trigger?.id)
          ?.runCount;
      })
      .toBe(1);
    const triggeredMessage = executionMessage(triggeredExecution);
    expect(triggeredMessage).toEqual(expect.any(String));
    if (!triggeredMessage)
      throw new Error("triggered workflow returned no message");

    await page.getByRole("button", { name: "Runs" }).click();
    await page.getByRole("button", { name: "Refresh runs" }).click();
    await expect(
      page.getByText(triggeredMessage, { exact: false }),
    ).toBeVisible();

    await page.getByRole("button", { name: "Run", exact: true }).click();
    let manualExecution: WorkflowExecution | undefined;
    await expect
      .poll(
        async () => {
          const response = await page.request.get(
            `/api/workflow/workflows/${workflow.id}/executions`,
          );
          const body = (await response.json()) as {
            executions: WorkflowExecution[];
          };
          manualExecution = body.executions.find(
            (execution) =>
              execution.mode === "manual" && execution.status === "finished",
          );
          return manualExecution?.status;
        },
        { timeout: 120_000 },
      )
      .toBe("finished");
    const manualMessage = executionMessage(manualExecution);
    expect(manualMessage).toEqual(expect.any(String));
    if (!manualMessage) throw new Error("manual workflow returned no message");
    await expect(page.getByText(manualMessage, { exact: false })).toBeVisible();

    await page.evaluate((workflowId) => {
      window.location.hash = `#automations/${workflowId}`;
    }, workflow.id);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Source" }).click();
    await expect(page.getByTestId("smithers-source-editor")).toHaveValue(
      /Real browser digest/,
      { timeout: 60_000 },
    );
    await page.getByRole("button", { name: "Widgets" }).click();
    await expect(page.getByText("Message", { exact: true })).toBeVisible();
    await expect(page.getByText(manualMessage, { exact: true })).toBeVisible();
  });
});
