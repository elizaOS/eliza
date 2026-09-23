/**
 * User-facing deactivate → reactivate journey driven through the dashboard UI
 * (#15603 item D11). Playwright clicks the real product surface against the
 * full local mock stack: the agent detail page's "Deactivate Agent" button and
 * billing-transparency confirm dialog fire the real `POST /sleep` job, the
 * control-plane job processor advances the real `agent_sandboxes` row to
 * `sleeping`, the page renders the deactivated state as a designed (non-error)
 * state with an explicit $0.00/hr cost, and "Reactivate Agent" fires the real
 * `POST /wake` job that restores the agent until its container endpoint serves
 * again. Serving state is witnessed on the dedicated path (the cloud-api DTO's
 * status plus the persisted endpoint itself), never on the shared JSON-RPC bridge —
 * see the comment on the deactivated assertion.
 * A second test covers the same lifecycle from the agents list (row actions).
 */
import {
  agentLifecycleAction,
  createCloudAgent,
  getSandboxState,
  listBackups,
  pollSandboxStatus,
  startAgentProvisioning,
} from "../src/helpers/provisioning";
import { expect, test } from "../src/helpers/test-fixtures";

async function provisionRunningAgent(
  apiUrl: string,
  apiKey: string,
  name: string,
  processJobs: () => Promise<void>,
): Promise<string> {
  const api = { apiUrl };
  const sandboxId = await createCloudAgent(api, apiKey, name, {
    alwaysOn: true,
    autoProvision: false,
  });
  await startAgentProvisioning(api, apiKey, sandboxId);
  await pollSandboxStatus(api, apiKey, sandboxId, "running", {
    timeoutMs: 30_000,
    onTick: processJobs,
  });
  return sandboxId;
}

/** Keep draining the DB-backed job queue while waiting for a UI condition —
 * the browser's own 5s job poll only observes completion after the mock
 * control plane has actually advanced the job. */
async function expectUiWithJobDrain(
  processJobs: () => Promise<void>,
  assertion: () => Promise<void>,
): Promise<void> {
  await expect(async () => {
    await processJobs();
    await assertion();
  }).toPass({ timeout: 90_000, intervals: [1_000, 2_000, 5_000] });
}

test.describe("deactivate / reactivate via dashboard UI", () => {
  test("detail page: confirm-dialog deactivate stops billing, reactivate restores service", async ({
    authenticatedPage: page,
    stack,
    seededUser,
  }) => {
    const api = { apiUrl: stack.urls.api };
    const processJobs = async () => {
      const result = await stack.mocks.controlPlane.processDbBackedJobs(
        stack.urls.pglite,
      );
      expect(result.failed, JSON.stringify(result.errors)).toBe(0);
    };

    const sandboxId = await provisionRunningAgent(
      stack.urls.api,
      seededUser.apiKey,
      "e2e-deactivate-ui-detail",
      processJobs,
    );

    await page.goto(`${stack.urls.frontend}/dashboard/agents/${sandboxId}`);
    await expect(
      page
        .getByText("running", { exact: true })
        .filter({ visible: true })
        .first(),
    ).toBeVisible({
      timeout: 30_000,
    });

    await page.screenshot({
      path: test.info().outputPath("agent-management-rest.png"),
      fullPage: true,
    });
    await page
      .getByRole("button", { name: "Deactivate Agent", exact: true })
      .hover();
    await page.screenshot({
      path: test.info().outputPath("agent-management-hover.png"),
      fullPage: true,
    });

    // ── Open the deactivate dialog and verify the billing-transparency copy ──
    await page
      .getByRole("button", { name: "Deactivate Agent", exact: true })
      .click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("stops consuming hourly credits");
    await expect(dialog).toContainText(
      "retains your agent data during deactivation",
    );
    await expect(dialog).toContainText(
      "agent stays running and billing continues",
    );
    await expect(dialog).toContainText(
      "remaining activation minimum is charged",
    );
    await expect(dialog).toContainText("requires available credits");
    await page.screenshot({
      path: test.info().outputPath("deactivate-dialog.png"),
      fullPage: true,
    });

    // ── Cancel is a real exit: nothing fired, agent still running ──
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    await pollSandboxStatus(api, seededUser.apiKey, sandboxId, "running", {
      timeoutMs: 10_000,
    });

    // ── Confirm deactivation: the UI itself must fire POST /sleep (202) ──
    await page
      .getByRole("button", { name: "Deactivate Agent", exact: true })
      .click();
    const sleepResponsePromise = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
          `/api/v1/eliza/agents/${sandboxId}/sleep` &&
        response.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: "Yes, deactivate", exact: true })
      .click();
    const sleepResponse = await sleepResponsePromise;
    expect(sleepResponse.status()).toBe(202);

    // In-between job state: the page shows deactivation progress while the
    // sleep job is pending.
    await expect(
      page.getByText(/Deactivating — retaining your agent data/),
    ).toBeVisible();

    // Drive the real job pipeline to completion; the page's 5s job poll then
    // reloads it into the deactivated state.
    await pollSandboxStatus(api, seededUser.apiKey, sandboxId, "sleeping", {
      timeoutMs: 30_000,
      onTick: processJobs,
    });
    await expectUiWithJobDrain(processJobs, async () => {
      await expect(page.getByTestId("agent-deactivated-panel")).toBeVisible({
        timeout: 2_000,
      });
    });

    // Designed deactivated state, not an error: sleeping badge, explicit
    // zero-cost display, and a Reactivate affordance.
    await expect(
      page
        .getByText("sleeping", { exact: true })
        .filter({ visible: true })
        .first(),
    ).toBeVisible();
    await expect(
      page
        .getByText("$0.00/hr", { exact: true })
        .filter({ visible: true })
        .first(),
    ).toBeVisible();
    await expect(page.getByText("Deactivated — no hourly cost")).toBeVisible();
    const reactivateButton = page.getByRole("button", {
      name: "Reactivate Agent",
      exact: true,
    });
    await expect(reactivateButton).toBeVisible();

    // Deactivation left a durable restore point and honestly stopped serving.
    const backups = await listBackups(api, seededUser.apiKey, sandboxId);
    expect(
      backups.length,
      "deactivate must leave at least one restore point",
    ).toBeGreaterThanOrEqual(1);
    // Public agent detail intentionally hides internal bridge coordinates.
    // Observe serving state through its public status plus the tenant-scoped
    // persisted endpoint and the mock container's actual HTTP response.
    const { agentSandboxesRepository } = await import(
      "@elizaos/cloud-shared/db/repositories/agent-sandboxes"
    );
    const readEndpoint = async () => {
      const row = await agentSandboxesRepository.findByIdAndOrg(
        sandboxId,
        seededUser.organizationId,
      );
      if (!row) throw new Error("Missing lifecycle sandbox");
      return row.bridge_url;
    };
    const { status: sleepingStatus, body: sleepingBody } =
      await getSandboxState(api, seededUser.apiKey, sandboxId);
    expect(sleepingStatus).toBe(200);
    const deactivated = (sleepingBody as { data?: { status?: string } }).data;
    expect(deactivated?.status).toBe("sleeping");
    expect(
      await readEndpoint(),
      "a deactivated agent must have no serving container endpoint",
    ).toBeNull();

    // ── Reactivate: the UI fires POST /wake (202) and the agent runs again ──
    const wakeResponsePromise = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
          `/api/v1/eliza/agents/${sandboxId}/wake` &&
        response.request().method() === "POST",
    );
    await reactivateButton.click();
    const startDialog = page.getByRole("alertdialog");
    await expect(startDialog).toContainText(
      "Minimum charge per successful start",
    );
    await startDialog
      .getByRole("button", { name: "Start Dedicated", exact: true })
      .click();
    const wakeResponse = await wakeResponsePromise;
    expect(wakeResponse.status()).toBe(202);

    // In-between job state: reactivation progress (it can take minutes on
    // real infra, so the copy must say so).
    await expect(
      page.getByText(/Reactivating — restoring your agent data/),
    ).toBeVisible();

    await pollSandboxStatus(api, seededUser.apiKey, sandboxId, "running", {
      timeoutMs: 30_000,
      onTick: processJobs,
    });
    await expectUiWithJobDrain(processJobs, async () => {
      await expect(
        page.getByRole("button", { name: "Deactivate Agent", exact: true }),
      ).toBeVisible({ timeout: 2_000 });
    });
    await expect(
      page
        .getByText("running", { exact: true })
        .filter({ visible: true })
        .first(),
    ).toBeVisible();

    // Wake must restore both the public running status and a serving endpoint.
    const { status: stateStatus, body: stateBody } = await getSandboxState(
      api,
      seededUser.apiKey,
      sandboxId,
    );
    expect(stateStatus).toBe(200);
    const restored = (stateBody as { data?: { status?: string } }).data;
    expect(restored?.status).toBe("running");
    const restoredEndpoint = await readEndpoint();
    expect(
      restoredEndpoint,
      "wake must restore a reachable container endpoint",
    ).toBeTruthy();
    if (!restoredEndpoint)
      throw new Error("Wake did not restore the container endpoint");
    const bridgeRoot = await fetch(restoredEndpoint);
    expect(
      bridgeRoot.status,
      "reactivated container endpoint must serve again",
    ).toBe(200);

    const chatSurface = await fetch(
      `${restoredEndpoint}/api/conversations/${encodeURIComponent(sandboxId)}/messages`,
    );
    expect(
      chatSurface.status,
      "reactivated agent chat surface must serve again",
    ).toBe(200);
    const chatBody = (await chatSurface.json()) as { messages?: unknown[] };
    expect(Array.isArray(chatBody.messages)).toBe(true);
  });

  test("agents list: sleeping row renders distinctly and row Reactivate restores it", async ({
    authenticatedPage: page,
    stack,
    seededUser,
  }) => {
    const api = { apiUrl: stack.urls.api };
    const processJobs = async () => {
      const result = await stack.mocks.controlPlane.processDbBackedJobs(
        stack.urls.pglite,
      );
      expect(result.failed, JSON.stringify(result.errors)).toBe(0);
    };

    const sandboxId = await provisionRunningAgent(
      stack.urls.api,
      seededUser.apiKey,
      "e2e-deactivate-ui-list",
      processJobs,
    );

    // Deactivate through the API (the dialog path is covered above) so this
    // test isolates the list rendering + row Reactivate affordance.
    await agentLifecycleAction(
      api,
      seededUser.apiKey,
      sandboxId,
      "sleep",
      [202],
    );
    await pollSandboxStatus(api, seededUser.apiKey, sandboxId, "sleeping", {
      timeoutMs: 30_000,
      onTick: processJobs,
    });

    await page.goto(`${stack.urls.frontend}/dashboard/agents`);

    // The sleeping state renders as a designed muted badge with the zero-cost
    // indicator — visibly not an error row.
    await expect(
      page
        .getByText("sleeping", { exact: true })
        .filter({ visible: true })
        .first(),
    ).toBeVisible({
      timeout: 30_000,
    });
    await expect(
      page
        .getByText("$0.00/hr", { exact: true })
        .filter({ visible: true })
        .first(),
    ).toBeVisible();

    // Row action: Reactivate fires the real wake job.
    const wakeResponsePromise = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
          `/api/v1/eliza/agents/${sandboxId}/wake` &&
        response.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: "Reactivate agent", exact: true })
      .first()
      .click();
    const startDialog = page.getByRole("alertdialog");
    await expect(startDialog).toContainText(
      "Minimum charge per successful start",
    );
    await startDialog
      .getByRole("button", { name: "Start Dedicated", exact: true })
      .click();
    const wakeResponse = await wakeResponsePromise;
    expect(wakeResponse.status()).toBe(202);

    await pollSandboxStatus(api, seededUser.apiKey, sandboxId, "running", {
      timeoutMs: 30_000,
      onTick: processJobs,
    });
    // The table's job poll + refresh converge on the running badge without a
    // manual reload.
    await expectUiWithJobDrain(processJobs, async () => {
      await expect(
        page
          .getByText("running", { exact: true })
          .filter({ visible: true })
          .first(),
      ).toBeVisible({
        timeout: 2_000,
      });
    });
  });
});
