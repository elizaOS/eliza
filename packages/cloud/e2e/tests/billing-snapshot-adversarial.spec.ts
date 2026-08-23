/**
 * Proves the Billing snapshot UI distinguishes pending, failed, recovered, and
 * designed-empty states against the real local Worker and database. The only
 * injected failure lives at the stack's server-side proxy boundary; the
 * browser transport is never intercepted or fulfilled by Playwright.
 */

import {
  createCloudAgent,
  getPersistedAgentSummary,
} from "../src/helpers/provisioning";
import { expect, test } from "../src/helpers/test-fixtures";

const BILLING_SNAPSHOT_PATH = "/api/v1/billing/limits";
const LEGACY_BILLING_PAGE_PATH = "/dashboard/billing";
const CANONICAL_BILLING_PAGE_PATH = "/cloud/billing";

test.use({ stackOptions: { backendFaults: true } });

test.describe("billing snapshot — backend failure recovery", () => {
  test.beforeEach(async ({ authenticatedPage, seededUser, stack }) => {
    const backendFaults = stack.mocks.backendFaults;
    if (!backendFaults) throw new Error("backend fault controller unavailable");
    backendFaults.clearFault();

    // The combined app expects an agent API for its startup coordinator. Create
    // a real, non-billable shared agent and route only those exact shell paths
    // to its real Worker adapter; Cloud account APIs remain at the Worker root.
    const agentId = await createCloudAgent(
      { apiUrl: stack.urls.api },
      seededUser.apiKey,
      `billing-snapshot-e2e-${Date.now().toString(36)}`,
    );
    const shellRuntime = await getPersistedAgentSummary(
      agentId,
      seededUser.organizationId,
    );
    expect(shellRuntime.executionTier).toBe("shared");
    const sharedAdapterPrefix = `/api/v1/eliza/agents/${encodeURIComponent(agentId)}`;
    backendFaults.setPathRewrites(
      [
        "/api/health",
        "/api/status",
        "/api/auth/status",
        "/api/auth/me",
        "/api/conversations",
        "/api/character",
        "/api/first-run/status",
        "/api/first-run",
        "/api/views",
        "/api/config",
        "/api/runtime/mode",
        "/api/commands",
        "/api/custom-actions",
        "/api/agent/events",
        "/api/agent/start",
        "/api/apps/overlay-presence",
        "/api/lifeops/activity-signals",
        "/api/stream/settings",
      ].map((path) => ({
        path,
        targetPath: `${sharedAdapterPrefix}${path}`,
      })),
    );

    // This suite exercises the authenticated Billing route, not the unrelated
    // device first-run overlay. Restore the real persisted runtime shape before
    // the app bootstraps so it can pass startup against that shared adapter.
    await authenticatedPage.addInitScript(
      ({ agentId, apiBase, apiKey }) => {
        window.localStorage.setItem("eliza:first-run-complete", "1");
        window.localStorage.setItem(
          "elizaos:active-server",
          JSON.stringify({
            id: `cloud:${agentId}`,
            kind: "cloud",
            label: "Billing E2E shared runtime",
            apiBase,
            accessToken: apiKey,
            cloudRuntimeAgentId: agentId,
            cloudRuntime: "shared",
          }),
        );
      },
      {
        agentId,
        apiBase: stack.urls.frontend,
        apiKey: seededUser.apiKey,
      },
    );

    // Warm the app shell once so startup and lazy private-route registration
    // settle before either test installs its Billing-specific observation.
    const runtimeReady = authenticatedPage.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/status" &&
        response.status() === 200,
    );
    await authenticatedPage.goto(stack.urls.frontend, { timeout: 60_000 });
    await runtimeReady;
    await expect(
      authenticatedPage.getByTestId("home-launcher-surface"),
    ).toBeVisible();
  });

  test("renders an unavailable server observation without inferring an empty snapshot", async ({
    authenticatedPage,
    stack,
    seededUser,
  }) => {
    const { organizationsRepository } = await import(
      "@elizaos/cloud-shared/db/repositories/organizations"
    );
    const original = await organizationsRepository.findBalanceSnapshotForWrite(
      seededUser.organizationId,
    );
    expect(original, "expected the seeded billing authority").toBeDefined();
    const originalRevision = Number(original?.balance_revision);
    expect(Number.isSafeInteger(originalRevision)).toBe(true);
    expect(originalRevision).toBeGreaterThanOrEqual(0);

    const snapshotStatuses: number[] = [];
    authenticatedPage.on("response", (response) => {
      if (new URL(response.url()).pathname === BILLING_SNAPSHOT_PATH) {
        snapshotStatuses.push(response.status());
      }
    });

    await organizationsRepository.update(seededUser.organizationId, {
      balance_revision: -1,
    });
    try {
      await authenticatedPage.goto(
        `${stack.urls.frontend}${LEGACY_BILLING_PAGE_PATH}`,
        { timeout: 60_000 },
      );
      await expect(authenticatedPage).not.toHaveURL(/\/login(?:\?|$)/);
      await expect(authenticatedPage).toHaveURL(
        new RegExp(`${CANONICAL_BILLING_PAGE_PATH}$`),
      );

      await expect(
        authenticatedPage.getByText("Balance unavailable", { exact: true }),
      ).toBeVisible();
      await expect(
        authenticatedPage.getByRole("heading", { name: "Active compute" }),
      ).toBeVisible();
      await expect(
        authenticatedPage.getByText(
          "Active resources cannot be shown from this observation. No empty state is inferred.",
          { exact: true },
        ),
      ).toBeVisible();
      await expect(
        authenticatedPage.getByText("No active billable compute", {
          exact: true,
        }),
      ).toBeHidden();
      await expect(
        authenticatedPage.getByRole("button", {
          name: "Retry balance",
        }),
      ).toBeVisible();
      await expect(
        authenticatedPage.getByRole("button", {
          name: "Retry",
          exact: true,
        }),
      ).toBeVisible();
      expect(snapshotStatuses.length).toBeGreaterThanOrEqual(1);
      expect(snapshotStatuses.every((status) => status === 200)).toBe(true);
    } finally {
      await organizationsRepository.update(seededUser.organizationId, {
        balance_revision: originalRevision,
      });
    }

    const recoveredResponse = authenticatedPage.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === BILLING_SNAPSHOT_PATH &&
        response.status() === 200,
    );
    await authenticatedPage
      .getByRole("button", { name: "Retry balance" })
      .click();
    await recoveredResponse;

    await expect(
      authenticatedPage.getByText("$1,000.00", { exact: true }),
    ).toBeVisible();
    await expect(
      authenticatedPage.getByText("No active billable compute", {
        exact: true,
      }),
    ).toBeVisible();
    expect(snapshotStatuses.length).toBeGreaterThanOrEqual(2);
    expect(snapshotStatuses.every((status) => status === 200)).toBe(true);
  });

  test("renders loading and failure honestly, then retries into the real empty snapshot", async ({
    authenticatedPage,
    stack,
  }) => {
    const backendFaults = stack.mocks.backendFaults;
    expect(
      backendFaults,
      "stackOptions.backendFaults must expose the server-side fault controller",
    ).toBeDefined();
    if (!backendFaults) throw new Error("backend fault controller unavailable");

    backendFaults.setFault({
      path: BILLING_SNAPSHOT_PATH,
      method: "GET",
      status: 503,
      body: {
        success: false,
        error: "Billing snapshot temporarily unavailable",
        code: "billing_snapshot_unavailable",
        retryable: true,
      },
      headers: { "Retry-After": "1" },
      delayMs: 10_000,
    });

    const snapshotStatuses: number[] = [];
    authenticatedPage.on("response", (response) => {
      if (new URL(response.url()).pathname === BILLING_SNAPSHOT_PATH) {
        snapshotStatuses.push(response.status());
      }
    });

    await authenticatedPage.goto(
      `${stack.urls.frontend}${LEGACY_BILLING_PAGE_PATH}`,
      {
        timeout: 60_000,
        waitUntil: "domcontentloaded",
      },
    );
    await expect(authenticatedPage).not.toHaveURL(/\/login(?:\?|$)/);
    await expect(authenticatedPage).toHaveURL(
      new RegExp(`${CANONICAL_BILLING_PAGE_PATH}$`),
    );

    await Promise.all([
      expect(
        authenticatedPage.getByRole("status", { name: "Loading balance" }),
      ).toBeVisible(),
      expect(
        authenticatedPage.getByRole("status", {
          name: "Loading active compute",
        }),
      ).toBeVisible(),
    ]);

    await expect(
      authenticatedPage.getByText("Balance unavailable", { exact: true }),
    ).toBeVisible();
    await expect(
      authenticatedPage.getByRole("heading", {
        name: "Active compute unavailable",
      }),
    ).toBeVisible();
    await expect(
      authenticatedPage.getByText("No active billable compute", {
        exact: true,
      }),
    ).toBeHidden();
    await expect(
      authenticatedPage.getByRole("button", {
        name: "Retry balance",
      }),
    ).toBeHidden();
    await expect(
      authenticatedPage.getByRole("button", { name: "Retry", exact: true }),
    ).toBeVisible();
    expect(snapshotStatuses.length).toBeGreaterThanOrEqual(1);
    expect(snapshotStatuses.every((status) => status === 503)).toBe(true);
    expect(backendFaults.faultHits).toBe(snapshotStatuses.length);

    backendFaults.clearFault();
    const recoveredResponse = authenticatedPage.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === BILLING_SNAPSHOT_PATH &&
        response.status() === 200,
    );
    await authenticatedPage
      .getByRole("button", { name: "Retry", exact: true })
      .click();
    await recoveredResponse;

    await expect(
      authenticatedPage.getByText("$1,000.00", { exact: true }),
    ).toBeVisible();
    await expect(
      authenticatedPage.getByRole("heading", { name: "Active compute" }),
    ).toBeVisible();
    await expect(
      authenticatedPage.getByText("No active billable compute", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      authenticatedPage.getByText(
        "No containers or agent sandboxes are currently reported as billable.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      authenticatedPage.getByText("Active compute unavailable", {
        exact: true,
      }),
    ).toBeHidden();
    const first503 = snapshotStatuses.indexOf(503);
    const first200AfterFailure = snapshotStatuses.findIndex(
      (status, index) => index > first503 && status === 200,
    );
    expect(first503).toBeGreaterThanOrEqual(0);
    expect(first200AfterFailure).toBeGreaterThan(first503);
  });
});
