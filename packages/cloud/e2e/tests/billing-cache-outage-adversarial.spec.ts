/**
 * Proves a runtime-tier cache outage remains a field-level Billing observation:
 * the real Worker still serves authoritative PGlite balance/compute data and
 * the real UI renders those available fields. The browser transport is never
 * intercepted, fulfilled, or replaced by a client-side mock.
 */

import { seedTestUser } from "../src/fixtures/seed";
import {
  createCloudAgent,
  getPersistedAgentSummary,
} from "../src/helpers/provisioning";
import {
  buildPlaywrightSessionToken,
  expect,
  test,
} from "../src/helpers/test-fixtures";

const BILLING_SNAPSHOT_PATH = "/api/v1/billing/limits";
const BILLING_PAGE_PATH = "/cloud/billing";

test.use({
  stackOptions: {
    backendFaults: true,
    env: {
      MOCK_REDIS: "0",
      CACHE_ENABLED: "true",
      CACHE_BACKEND: "redis",
      // Port 1 is a privileged loopback port and therefore cannot be claimed by
      // the unprivileged E2E stack. Connection refusal is immediate and keeps
      // the outage hermetic: no packet can leave the local machine.
      REDIS_URL: "redis://127.0.0.1:1",
    },
  },
});

test.describe("billing snapshot — runtime cache outage", () => {
  test("keeps authoritative balance and empty compute available when Redis is unreachable", async ({
    page,
    stack,
  }) => {
    // SIWE nonce persistence correctly fails closed during a Redis outage, so
    // this cache-focused spec seeds its authenticated authority directly in
    // the real PGlite database. The browser still uses the stack's signed,
    // server-validated Playwright session cookie; no client request is mocked.
    const seededUser = await seedTestUser({
      slug: `billing-cache-outage-${Date.now().toString(36)}`,
    });
    const frontendUrl = new URL(stack.urls.frontend);
    await page.context().addCookies([
      {
        name: "eliza-test-auth",
        value: "1",
        domain: frontendUrl.hostname,
        path: "/",
      },
      {
        name: "eliza-test-session",
        value: buildPlaywrightSessionToken(
          seededUser.userId,
          seededUser.organizationId,
        ),
        domain: frontendUrl.hostname,
        path: "/",
      },
    ]);

    const backendFaults = stack.mocks.backendFaults;
    if (!backendFaults) throw new Error("backend fault controller unavailable");
    backendFaults.clearFault();

    // The combined app expects an agent API for its startup coordinator. Create
    // a real, non-billable shared agent and route only those exact shell paths
    // to its real Worker adapter; Cloud account APIs remain at the Worker root.
    const agentId = await createCloudAgent(
      { apiUrl: stack.urls.api },
      seededUser.apiKey,
      `billing-cache-outage-e2e-${Date.now().toString(36)}`,
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

    await page.addInitScript(
      ({ agentId, apiBase, apiKey }) => {
        window.localStorage.setItem("eliza:first-run-complete", "1");
        window.localStorage.setItem(
          "elizaos:active-server",
          JSON.stringify({
            id: `cloud:${agentId}`,
            kind: "cloud",
            label: "Billing cache-outage E2E shared runtime",
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

    const runtimeReady = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/status" &&
        response.status() === 200,
    );
    await page.goto(stack.urls.frontend, { timeout: 60_000 });
    await runtimeReady;
    await expect(page.getByTestId("home-launcher-surface")).toBeVisible();

    const response = await fetch(`${stack.urls.api}${BILLING_SNAPSHOT_PATH}`, {
      headers: { Authorization: `Bearer ${seededUser.apiKey}` },
    });
    expect(
      response.status,
      `billing snapshot returned ${response.status}: ${await response.clone().text()}`,
    ).toBe(200);

    const body = (await response.json()) as {
      success?: boolean;
      data?: {
        schemaVersion?: number;
        v2?: {
          balance?: unknown;
          tier?: { runtimeCache?: unknown };
          activeCompute?: { resources?: unknown };
        };
      };
    };
    expect(body.success).toBe(true);
    expect(body.data?.schemaVersion).toBe(2);
    expect(body.data?.v2?.tier?.runtimeCache).toMatchObject({
      status: "unavailable",
      source: "org-rate-limit-cache",
      error: {
        code: "runtime_tier_cache_unavailable",
        retryable: true,
      },
    });
    expect(body.data?.v2?.balance).toMatchObject({
      status: "available",
      source: "organizations",
      value: {
        balance: {
          value: "1000.000000",
          unit: "usd",
          currency: "USD",
        },
      },
    });
    expect(body.data?.v2?.activeCompute?.resources).toMatchObject({
      status: "available",
      source: "active-billing-service",
      value: [],
    });

    const uiSnapshotResponse = page.waitForResponse(
      (candidate) =>
        new URL(candidate.url()).pathname === BILLING_SNAPSHOT_PATH &&
        candidate.status() === 200,
    );
    await page.goto(`${stack.urls.frontend}${BILLING_PAGE_PATH}`, {
      timeout: 60_000,
    });
    await uiSnapshotResponse;

    await expect(page.getByText("$1,000.00", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Active compute" }),
    ).toBeVisible();
    await expect(
      page.getByText("No active billable compute", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByText("Balance unavailable", { exact: true }),
    ).toBeHidden();
    await expect(
      page.getByRole("heading", {
        name: "Active compute unavailable",
      }),
    ).toBeHidden();
    await expect(
      page.getByText(
        "Active resources cannot be shown from this observation. No empty state is inferred.",
        { exact: true },
      ),
    ).toBeHidden();
  });
});
