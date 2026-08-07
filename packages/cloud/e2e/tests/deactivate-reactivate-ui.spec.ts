/**
 * User-facing deactivate → reactivate journey driven through the dashboard UI
 * (#15603 item D11). Playwright clicks the real product surface against the
 * full local mock stack: the agent detail page's "Deactivate Agent" button and
 * billing-transparency confirm dialog fire the real `POST /sleep` job, the
 * control-plane job processor advances the real `agent_sandboxes` row to
 * `sleeping`, the page renders the deactivated state as a designed (non-error)
 * state with an explicit $0.00/hr cost, and "Reactivate Agent" fires the real
 * `POST /wake` job that restores the agent until its bridge serves again.
 * A second test covers the same lifecycle from the agents list (row actions).
 */
import {
  agentLifecycleAction,
  createCloudAgent,
  getSandboxState,
  listBackups,
  pollSandboxStatus,
  sendAgentBridgeRequest,
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
    await expect(page.getByText("running").first()).toBeVisible({
      timeout: 30_000,
    });

    // ── Open the deactivate dialog and verify the billing-transparency copy ──
    await page
      .getByRole("button", { name: "Deactivate Agent", exact: true })
      .click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("stops consuming hourly credits");
    await expect(dialog).toContainText(
      "saved in an encrypted backup — nothing is deleted",
    );
    await expect(dialog).toContainText("reactivate it anytime");

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
      page.getByText(/Deactivating — saving an encrypted backup/),
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
    await expect(page.getByText("sleeping").first()).toBeVisible();
    await expect(page.getByText("$0.00/hr").first()).toBeVisible();
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
    const sleepingHeartbeat = await sendAgentBridgeRequest(
      api,
      seededUser.apiKey,
      sandboxId,
      { jsonrpc: "2.0", id: "deactivated-heartbeat", method: "heartbeat" },
    );
    expect(
      JSON.stringify(sleepingHeartbeat.error ?? {}),
      "a deactivated agent must not serve bridge traffic",
    ).toContain("not running");

    // ── Reactivate: the UI fires POST /wake (202) and the agent runs again ──
    const wakeResponsePromise = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
          `/api/v1/eliza/agents/${sandboxId}/wake` &&
        response.request().method() === "POST",
    );
    await reactivateButton.click();
    const wakeResponse = await wakeResponsePromise;
    expect(wakeResponse.status()).toBe(202);

    // In-between job state: reactivation progress (it can take minutes on
    // real infra, so the copy must say so).
    await expect(
      page.getByText(/Reactivating — restoring your agent from its backup/),
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
    await expect(page.getByText("running").first()).toBeVisible();

    // The reactivated agent serves again. The Worker's own bridge hop routes
    // dedicated-agent traffic via the per-agent public subdomain, which does
    // not resolve in the local mock stack — so assert restoration at the two
    // boundaries the stack genuinely exercises: the cloud-api DTO (running,
    // with a re-provisioned container endpoint) and the restored container
    // endpoint itself (root + conversation/chat surface serving 200 again,
    // where during sleep there was no container at all).
    const { status: stateStatus, body: stateBody } = await getSandboxState(
      api,
      seededUser.apiKey,
      sandboxId,
    );
    expect(stateStatus).toBe(200);
    const restored = (
      stateBody as { data?: { status?: string; bridgeUrl?: string | null } }
    ).data;
    expect(restored?.status).toBe("running");
    expect(
      restored?.bridgeUrl,
      "wake must restore a reachable container endpoint",
    ).toBeTruthy();

    const bridgeRoot = await fetch(String(restored?.bridgeUrl));
    expect(
      bridgeRoot.status,
      "reactivated container endpoint must serve again",
    ).toBe(200);

    const chatSurface = await fetch(
      `${restored?.bridgeUrl}/api/conversations/${encodeURIComponent(sandboxId)}/messages`,
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
    await expect(page.getByText("sleeping").first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText("$0.00/hr").first()).toBeVisible();

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
    const wakeResponse = await wakeResponsePromise;
    expect(wakeResponse.status()).toBe(202);

    await pollSandboxStatus(api, seededUser.apiKey, sandboxId, "running", {
      timeoutMs: 30_000,
      onTick: processJobs,
    });
    // The table's job poll + refresh converge on the running badge without a
    // manual reload.
    await expectUiWithJobDrain(processJobs, async () => {
      await expect(page.getByText("running").first()).toBeVisible({
        timeout: 2_000,
      });
    });
  });
});
