/**
 * Proves a freshly provisioned dedicated agent reaches the real Billing UI as
 * non-empty active compute without a premature cron debit. The browser drives
 * the real local Worker and app; Playwright never intercepts or fulfills an API
 * request, while only external infrastructure remains mock-backed by the stack.
 */

import {
  createCloudAgent,
  getPersistedAgentSummary,
  pollSandboxStatus,
  startAgentProvisioning,
} from "../src/helpers/provisioning";
import { expect, test } from "../src/helpers/test-fixtures";

const BILLING_SNAPSHOT_PATH = "/api/v1/billing/limits";
const BILLING_PAGE_PATH = "/cloud/billing";
const CRON_SECRET = "test-cron-secret";
const RUNNING_HOURLY_RATE = "0.010000";
const RUNNING_DAILY_ESTIMATE = "0.240000";

const SHARED_RUNTIME_PATHS = [
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
] as const;

interface BillingSnapshotResponse {
  success?: boolean;
  data?: {
    schemaVersion?: number;
    v2?: {
      activeCompute?: {
        resources?: {
          status?: string;
          source?: string;
          value?: Array<{
            resourceType?: string;
            resourceId?: string;
            name?: string;
            status?: string;
            billingStatus?: string;
            billingInterval?: string;
            lastBilledAt?: string | null;
            nextBillingAt?: string | null;
            estimatedNextBillingAt?: string | null;
            rateSegment?: unknown;
            ratePerHour?: unknown;
            estimatedRecurringComputeCostPerDay?: unknown;
          }>;
        };
        estimatedRecurringComputeCostPerDay?: unknown;
      };
    };
  };
}

test.use({ stackOptions: { backendFaults: true } });

test("fresh dedicated compute reaches Billing without an early debit", async ({
  authenticatedPage,
  seededUser,
  stack,
}) => {
  const api = { apiUrl: stack.urls.api };
  const resourceName = `active-compute-e2e-${Date.now().toString(36)}`;
  const shellAgentId = await createCloudAgent(
    api,
    seededUser.apiKey,
    `active-compute-shell-${Date.now().toString(36)}`,
  );
  const shellRuntime = await getPersistedAgentSummary(
    shellAgentId,
    seededUser.organizationId,
  );
  expect(shellRuntime.executionTier).toBe("shared");

  const processJobs = async () => {
    const result = await stack.mocks.controlPlane.processDbBackedJobs(
      stack.urls.pglite,
    );
    expect(result.failed, JSON.stringify(result.errors)).toBe(0);
  };

  const resourceId = await createCloudAgent(
    api,
    seededUser.apiKey,
    resourceName,
    { alwaysOn: true, autoProvision: false, forceCreate: true },
  );
  await startAgentProvisioning(api, seededUser.apiKey, resourceId);
  await pollSandboxStatus(api, seededUser.apiKey, resourceId, "running", {
    timeoutMs: 30_000,
    intervalMs: 250,
    onTick: processJobs,
  });

  const { agentSandboxesRepository } = await import(
    "@elizaos/cloud-shared/db/repositories/agent-sandboxes"
  );
  const { organizationsRepository } = await import(
    "@elizaos/cloud-shared/db/repositories/organizations"
  );
  const beforeAgent = await agentSandboxesRepository.findByIdAndOrg(
    resourceId,
    seededUser.organizationId,
  );
  const beforeOrganization = await organizationsRepository.findById(
    seededUser.organizationId,
  );
  expect(beforeAgent, `expected persisted agent ${resourceId}`).toMatchObject({
    status: "running",
    execution_tier: "dedicated-always",
    billing_status: "active",
  });
  expect(
    beforeAgent?.last_billed_at,
    "new dedicated compute must start with a billing cursor",
  ).toBeInstanceOf(Date);
  expect(
    beforeOrganization,
    `expected organization ${seededUser.organizationId}`,
  ).toBeTruthy();
  if (!beforeAgent?.last_billed_at || !beforeOrganization) {
    throw new Error("Expected the new compute billing authority");
  }
  const initialCursor = beforeAgent.last_billed_at.toISOString();
  const initialBalance = String(beforeOrganization.credit_balance);
  const initialTotalBilled = String(beforeAgent.total_billed);

  const cronResponse = await fetch(`${stack.urls.api}/api/cron/agent-billing`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${CRON_SECRET}`,
      "Content-Type": "application/json",
    },
  });
  expect(
    cronResponse.status,
    `agent-billing cron returned ${cronResponse.status}: ${await cronResponse.clone().text()}`,
  ).toBe(200);
  const cronBody = (await cronResponse.json()) as { success?: boolean };
  expect(cronBody.success).toBe(true);

  const afterAgent = await agentSandboxesRepository.findByIdAndOrg(
    resourceId,
    seededUser.organizationId,
  );
  const afterOrganization = await organizationsRepository.findById(
    seededUser.organizationId,
  );
  expect(
    afterAgent,
    `expected persisted agent ${resourceId} after cron`,
  ).toBeTruthy();
  expect(
    afterOrganization,
    `expected organization ${seededUser.organizationId} after cron`,
  ).toBeTruthy();
  if (!afterAgent || !afterOrganization) {
    throw new Error("Expected compute billing authority after cron");
  }
  expect(String(afterOrganization.credit_balance)).toBe(initialBalance);
  expect(afterAgent.last_billed_at?.toISOString()).toBe(initialCursor);
  expect(String(afterAgent.total_billed)).toBe(initialTotalBilled);

  const backendFaults = stack.mocks.backendFaults;
  expect(
    backendFaults,
    "stackOptions.backendFaults must expose the server-side proxy controller",
  ).toBeDefined();
  if (!backendFaults) throw new Error("backend fault controller unavailable");
  backendFaults.clearFault();

  const sharedAdapterPrefix = `/api/v1/eliza/agents/${encodeURIComponent(shellAgentId)}`;
  backendFaults.setPathRewrites(
    SHARED_RUNTIME_PATHS.map((path) => ({
      path,
      targetPath: `${sharedAdapterPrefix}${path}`,
    })),
  );

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
      agentId: shellAgentId,
      apiBase: stack.urls.frontend,
      apiKey: seededUser.apiKey,
    },
  );

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

  const snapshotResponsePromise = authenticatedPage.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === BILLING_SNAPSHOT_PATH &&
      response.status() === 200,
  );
  await authenticatedPage.goto(`${stack.urls.frontend}${BILLING_PAGE_PATH}`, {
    timeout: 60_000,
  });
  const snapshotResponse = await snapshotResponsePromise;
  const snapshotBody =
    (await snapshotResponse.json()) as BillingSnapshotResponse;
  expect(snapshotBody.success).toBe(true);
  expect(snapshotBody.data?.schemaVersion).toBe(2);
  const activeCompute = snapshotBody.data?.v2?.activeCompute;
  expect(activeCompute?.resources).toMatchObject({
    status: "available",
    source: "active-billing-service",
  });
  const resources = activeCompute?.resources?.value;
  expect(resources).toHaveLength(1);
  const resource = resources?.find(
    (candidate) =>
      candidate.resourceType === "agent_sandbox" &&
      candidate.resourceId === resourceId,
  );
  expect(resource, `expected ${resourceId} in the v2 snapshot`).toMatchObject({
    resourceType: "agent_sandbox",
    resourceId,
    name: resourceName,
    status: "running",
    billingStatus: "active",
    billingInterval: "hour",
    lastBilledAt: initialCursor,
    nextBillingAt: null,
    estimatedNextBillingAt: new Date(
      Date.parse(initialCursor) + 60 * 60 * 1000,
    ).toISOString(),
    rateSegment: {
      status: "available",
      source: "compute_billing_rate_segments",
      value: {
        workloadKind: "agent",
        billingState: "running",
        effectiveAt: expect.any(String),
      },
    },
    ratePerHour: {
      status: "available",
      source: "compute_billing_rate_segments",
      value: {
        value: RUNNING_HOURLY_RATE,
        unit: "usd_per_hour",
        currency: "USD",
      },
    },
    estimatedRecurringComputeCostPerDay: {
      status: "available",
      source: "compute_billing_rate_segments",
      value: {
        value: RUNNING_DAILY_ESTIMATE,
        unit: "usd_per_day",
        currency: "USD",
      },
    },
  });
  expect(activeCompute?.estimatedRecurringComputeCostPerDay).toMatchObject({
    status: "available",
    source: "compute_billing_rate_segments",
    value: {
      value: RUNNING_DAILY_ESTIMATE,
      unit: "usd_per_day",
      currency: "USD",
    },
  });

  await expect(authenticatedPage).toHaveURL(
    new RegExp(`${BILLING_PAGE_PATH}$`),
  );
  await expect(
    authenticatedPage.getByRole("heading", { name: "Active compute" }),
  ).toBeVisible();
  await expect(
    authenticatedPage
      .getByRole("status")
      .filter({ hasText: "Active compute snapshot ready." }),
  ).toBeVisible();

  const resourceCard = authenticatedPage
    .getByRole("listitem")
    .filter({ hasText: resourceName });
  await expect(resourceCard).toHaveCount(1);
  await expect(
    resourceCard.getByText(`Agent sandbox · ${resourceId}`, { exact: true }),
  ).toBeVisible();
  await expect(
    resourceCard.getByText("Lifecycle: running", { exact: true }),
  ).toBeVisible();
  await expect(
    resourceCard.getByText("Billing: active", { exact: true }),
  ).toBeVisible();
  await expect(
    resourceCard.locator("dd").filter({ hasText: /^\$0\.01\s*\/ hour$/ }),
  ).toBeVisible();
  await expect(
    resourceCard.locator("dd").filter({ hasText: /^\$0\.24\s*\/ day$/ }),
  ).toBeVisible();
  await expect(resourceCard.getByText("Hourly", { exact: true })).toBeVisible();
  await expect(
    resourceCard.getByText("Not scheduled", { exact: true }),
  ).toBeVisible();

  await expect(
    authenticatedPage.getByText("No active billable compute", { exact: true }),
  ).toBeHidden();
  await expect(
    authenticatedPage.getByText(
      "Active resources cannot be shown from this observation. No empty state is inferred.",
      { exact: true },
    ),
  ).toBeHidden();
  await expect(
    authenticatedPage.getByText(
      "Some cost observations are unavailable. No estimate is recalculated in the client.",
      { exact: true },
    ),
  ).toBeHidden();
  await expect(
    authenticatedPage.getByRole("heading", {
      name: "Active compute unavailable",
    }),
  ).toBeHidden();
});
