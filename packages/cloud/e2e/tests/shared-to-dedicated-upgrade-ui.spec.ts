/**
 * "Upgrade to Dedicated" on the agent detail page (#15355) — the product
 * surface, driven through the real dashboard UI against the full local mock
 * stack. The API-level contract and the transcript-continuity handoff are
 * covered end to end by `shared-to-dedicated-upgrade.spec.ts`; this spec pins
 * the UI contract:
 *
 *   - the action exists ONLY for shared-tier agents (a dedicated agent's
 *     detail page must not offer it),
 *   - the confirm dialog carries the exact server-owned quote — continuous
 *     hosting burn, current balance, and the enforced runway minimum,
 *   - Cancel is a real exit (nothing fired, no target minted),
 *   - Confirm sends the explicit activation action and exact quote id to the
 *     real `POST /upgrade-tier` (202), shows the upgrade progress line, and the
 *     dedicated migration target exists in the DB with the identity copied and
 *     the reattach marker recorded server-side.
 */
// Playwright spec marker: `test`/`expect` arrive via the shared fixtures
// below, but the coverage gate classifies a changed *.spec.ts by grepping for
// a DIRECT @playwright/test import — without one it would run this file under
// `bun test`. Type-only and empty, so it costs nothing at runtime.
import { personalSharedAgentId } from "@elizaos/cloud-shared/lib/services/shared-runtime/personal-shared-agent";
import type { Page, Response } from "@playwright/test";
import {
  createCloudAgent,
  pollSandboxStatus,
  startAgentProvisioning,
} from "../src/helpers/provisioning";
import { expect, test } from "../src/helpers/test-fixtures";

async function seedManagedCloudRuntime(
  page: Page,
  apiKey: string,
  agentId: string,
  cloudApiBase: string,
): Promise<void> {
  await page.addInitScript(
    ({ token, id, apiBase }) => {
      window.localStorage.setItem("steward_session_token", token);
      window.localStorage.setItem("eliza:first-run-complete", "1");
      window.localStorage.setItem(
        "elizaos:active-server",
        JSON.stringify({
          id: `cloud:${id}`,
          kind: "cloud",
          label: "Eliza Cloud",
          apiBase,
          accessToken: token,
        }),
      );
    },
    { token: apiKey, id: agentId, apiBase: cloudApiBase },
  );
}

function isPersonalTierUpgradeResponse(
  response: Response,
  sharedAgentId: string,
  method: "GET" | "POST",
): boolean {
  return (
    decodeURIComponent(new URL(response.url()).pathname) ===
      `/api/v1/eliza/agents/${sharedAgentId}/upgrade-tier` &&
    response.request().method() === method
  );
}

test.describe("upgrade to dedicated via dashboard UI", () => {
  test("rowless personal Shared: signed-in cockpit → quote → real Dedicated target", async ({
    authenticatedPage: page,
    stack,
    seededUser,
  }) => {
    test.setTimeout(120_000);
    const sharedAgentId = personalSharedAgentId({
      userId: seededUser.userId,
      organizationId: seededUser.organizationId,
    });

    // The console web surface resolves its cloud bearer from the steward
    // session in localStorage; the test-session cookie fixture bypasses
    // steward, so seed the API key as the stored token (the cloud API accepts
    // both) before the app boots.
    await seedManagedCloudRuntime(
      page,
      seededUser.apiKey,
      sharedAgentId,
      stack.urls.api,
    );

    await page.goto(`${stack.urls.frontend}/cloud`);
    await expect(page.getByRole("heading", { name: "Eliza" })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText("Shared", { exact: true })).toBeVisible();
    const upgradeButton = page.getByTestId("agent-upgrade-tier-button");
    await expect(upgradeButton).toBeVisible({ timeout: 30_000 });
    await page.screenshot({
      path: test.info().outputPath("personal-eliza-cockpit-desktop.png"),
      fullPage: true,
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(upgradeButton).toBeVisible();
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
      "personal Eliza cockpit has no horizontal overflow on mobile",
    ).toBe(true);
    await page.screenshot({
      path: test.info().outputPath("personal-eliza-cockpit-mobile.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 1280, height: 720 });

    // ── Billing-transparency dialog: burn/day + runway minimum + continuity ──
    const quoteResponsePromise = page.waitForResponse((response) =>
      isPersonalTierUpgradeResponse(response, sharedAgentId, "GET"),
    );
    await upgradeButton.click();
    const quoteResponse = await quoteResponsePromise;
    expect(quoteResponse.status()).toBe(200);
    const quote = (await quoteResponse.json()) as {
      data?: {
        quoteId?: string;
        hourlyRateUsd?: number;
        dailyRateUsd?: number;
        minimumBalanceUsd?: number;
        minimumRunwayDays?: number;
        balanceUsd?: number;
      };
    };
    expect(quote.data?.quoteId).toMatch(/^[a-f0-9]{64}$/);
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(
      `$${quote.data?.dailyRateUsd?.toFixed(2)} per day`,
    );
    await expect(dialog).toContainText(
      `$${quote.data?.minimumBalanceUsd?.toFixed(2)}`,
    );
    await expect(dialog).toContainText(`${quote.data?.minimumRunwayDays} days`);
    await expect(dialog).toContainText(
      `Current balance: $${quote.data?.balanceUsd?.toFixed(2)}`,
    );
    await expect(dialog).toContainText("Shared keeps working");
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
    ).toBe(0);

    // ── Confirm: the UI itself fires POST /upgrade-tier and gets a 202. ──
    const refreshedQuoteResponsePromise = page.waitForResponse((response) =>
      isPersonalTierUpgradeResponse(response, sharedAgentId, "GET"),
    );
    await upgradeButton.click();
    expect((await refreshedQuoteResponsePromise).status()).toBe(200);
    await expect(dialog).toBeVisible();
    const upgradeResponsePromise = page.waitForResponse((response) =>
      isPersonalTierUpgradeResponse(response, sharedAgentId, "POST"),
    );
    await page.getByTestId("agent-upgrade-tier-confirm").click();
    const upgradeResponse = await upgradeResponsePromise;
    expect(upgradeResponse.status()).toBe(202);
    expect(upgradeResponse.request().postDataJSON()).toEqual({
      action: "activate_dedicated",
      quoteId: quote.data?.quoteId,
    });
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
    expect(dedicated?.agent_name).toBe("Eliza");
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

    await seedManagedCloudRuntime(
      page,
      seededUser.apiKey,
      sandboxId,
      stack.urls.api,
    );

    await page.goto(`${stack.urls.frontend}/cloud/agents/${sandboxId}`);
    // The actions card rendered (deactivate exists for dedicated agents)…
    await expect(
      page.getByRole("button", { name: "Deactivate Agent", exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    // …but the tier upgrade is shared-only.
    await expect(page.getByTestId("agent-upgrade-tier-button")).toHaveCount(0);
  });
});
