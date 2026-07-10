/**
 * "Upgrade to Dedicated" on the agent detail page (#15355) — the product
 * surface, driven through the real dashboard UI against the full local mock
 * stack. The API-level contract and the transcript-continuity handoff are
 * covered end to end by `shared-to-dedicated-upgrade.spec.ts`; this spec pins
 * the UI contract:
 *
 *   - the action exists ONLY for shared-tier agents (a dedicated agent's
 *     detail page must not offer it),
 *   - the confirm dialog carries the billing-transparency copy — the
 *     continuous hosting burn and the server-enforced runway minimum, sourced
 *     from the same AGENT_PRICING constants the gate enforces,
 *   - Cancel is a real exit (nothing fired, no target minted),
 *   - Confirm fires the real `POST /upgrade-tier` (202), shows the upgrade
 *     progress line, and the dedicated migration target exists in the DB with
 *     the identity copied and the reattach marker recorded server-side.
 */
import { AGENT_PRICING } from "@elizaos/cloud-shared/lib/constants/agent-pricing";
// Playwright spec marker: `test`/`expect` arrive via the shared fixtures
// below, but the coverage gate classifies a changed *.spec.ts by grepping for
// a DIRECT @playwright/test import — without one it would run this file under
// `bun test`. Type-only and empty, so it costs nothing at runtime.
import type {} from "@playwright/test";
import {
  createCloudAgent,
  pollSandboxStatus,
  startAgentProvisioning,
} from "../src/helpers/provisioning";
import { expect, test } from "../src/helpers/test-fixtures";

test.describe("upgrade to dedicated via dashboard UI", () => {
  test("shared agent: billing-transparency confirm → real upgrade-tier POST → progress + minted target", async ({
    authenticatedPage: page,
    stack,
    seededUser,
  }) => {
    test.setTimeout(120_000);
    const api = { apiUrl: stack.urls.api };

    // A shared-tier agent (no alwaysOn/dockerImage) — created running, no job.
    const sharedAgentId = await createCloudAgent(
      api,
      seededUser.apiKey,
      "e2e-upgrade-ui-shared",
    );

    // The console web surface resolves its cloud bearer from the steward
    // session in localStorage; the test-session cookie fixture bypasses
    // steward, so seed the API key as the stored token (the cloud API accepts
    // both) before the app boots.
    await page.addInitScript((apiKey: string) => {
      window.localStorage.setItem("steward_session_token", apiKey);
    }, seededUser.apiKey);

    await page.goto(`${stack.urls.frontend}/dashboard/agents/${sharedAgentId}`);
    const upgradeButton = page.getByTestId("agent-upgrade-tier-button");
    await expect(upgradeButton).toBeVisible({ timeout: 30_000 });

    // ── Billing-transparency dialog: burn/day + runway minimum + continuity ──
    await upgradeButton.click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(
      `$${AGENT_PRICING.DAILY_RUNNING_COST.toFixed(2)}/day`,
    );
    await expect(dialog).toContainText(
      `$${AGENT_PRICING.UPGRADE_MINIMUM_BALANCE.toFixed(2)}`,
    );
    await expect(dialog).toContainText(
      `${AGENT_PRICING.UPGRADE_MIN_HOSTING_DAYS} days of hosting`,
    );
    await expect(dialog).toContainText("Your conversation history moves");
    await page.screenshot({
      path: test.info().outputPath("upgrade-confirm-dialog.png"),
      fullPage: true,
    });

    // ── Cancel is a real exit: nothing fired, no migration target minted. ──
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    const { agentSandboxesRepository } = await import(
      "@elizaos/cloud-shared/db/repositories/agent-sandboxes"
    );
    expect(
      (
        await agentSandboxesRepository.listByOrganization(
          seededUser.organizationId,
        )
      ).length,
      "cancel minted nothing",
    ).toBe(1);

    // ── Confirm: the UI itself fires POST /upgrade-tier and gets a 202. ──
    await upgradeButton.click();
    const upgradeResponsePromise = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
          `/api/v1/eliza/agents/${sharedAgentId}/upgrade-tier` &&
        response.request().method() === "POST",
    );
    await page.getByTestId("agent-upgrade-tier-confirm").click();
    const upgradeResponse = await upgradeResponsePromise;
    expect(upgradeResponse.status()).toBe(202);
    const upgradeBody = (await upgradeResponse.json()) as {
      data?: { dedicatedAgentId?: string };
    };
    const dedicatedAgentId = upgradeBody.data?.dedicatedAgentId;
    expect(dedicatedAgentId, "the UI's POST minted a target").toBeTruthy();
    if (!dedicatedAgentId) throw new Error("no dedicated agent id");

    // The whole-span progress line is up while the provision + move runs.
    await expect(page.getByTestId("agent-upgrade-progress")).toBeVisible({
      timeout: 15_000,
    });
    await page.screenshot({
      path: test.info().outputPath("upgrade-progress.png"),
      fullPage: true,
    });

    // The migration target is real: dedicated-always, identity copied, and the
    // server-side reattach marker recorded.
    const dedicated = await agentSandboxesRepository.findByIdAndOrg(
      dedicatedAgentId,
      seededUser.organizationId,
    );
    expect(dedicated?.execution_tier).toBe("dedicated-always");
    expect(dedicated?.agent_name).toBe("e2e-upgrade-ui-shared");
    expect(
      (dedicated?.agent_config as Record<string, unknown> | null)
        ?.__agentUpgradedFrom,
    ).toBe(sharedAgentId);
  });

  test("dedicated agent: the upgrade action is absent", async ({
    authenticatedPage: page,
    stack,
    seededUser,
  }) => {
    test.setTimeout(120_000);
    const api = { apiUrl: stack.urls.api };
    const processJobs = async () => {
      const result = await stack.mocks.controlPlane.processDbBackedJobs(
        stack.urls.pglite,
      );
      expect(result.failed, JSON.stringify(result.errors)).toBe(0);
    };

    const sandboxId = await createCloudAgent(
      api,
      seededUser.apiKey,
      "e2e-upgrade-ui-dedicated",
      { alwaysOn: true, autoProvision: false },
    );
    await startAgentProvisioning(api, seededUser.apiKey, sandboxId);
    await pollSandboxStatus(api, seededUser.apiKey, sandboxId, "running", {
      timeoutMs: 30_000,
      onTick: processJobs,
    });

    await page.goto(`${stack.urls.frontend}/dashboard/agents/${sandboxId}`);
    // The actions card rendered (deactivate exists for dedicated agents)…
    await expect(
      page.getByRole("button", { name: "Deactivate Agent", exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    // …but the tier upgrade is shared-only.
    await expect(page.getByTestId("agent-upgrade-tier-button")).toHaveCount(0);
  });
});
