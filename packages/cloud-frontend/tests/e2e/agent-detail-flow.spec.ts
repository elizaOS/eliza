// Agent-detail lifecycle — the start/stop/snapshot/delete actions on
// /dashboard/agents/:id, driven through the real <ElizaAgentActions> card.
//
// The detail page fetches GET /api/v1/eliza/agents/:id and renders the agent
// header + the "Agent Actions" card. Which buttons render is status-driven:
//   running  → Chat · Save Snapshot · Suspend Agent · Delete Agent
//   stopped  → Resume Agent · Delete Agent
// Each lifecycle button fires a distinct mutation (read from agent-actions.tsx):
//   snapshot → POST   /api/v1/eliza/agents/:id/snapshot
//   suspend  → PATCH  /api/v1/eliza/agents/:id   { action: "suspend" }
//   resume   → POST   /api/v1/eliza/agents/:id/resume
//   delete   → DELETE /api/v1/eliza/agents/:id
//
// These are the lifecycle actions left uncovered by agent-flow.spec (which only
// covers create → chat). Runs against the local dev build with
// VITE_PLAYWRIGHT_TEST_AUTH=true; every /api/** call is mocked.

import { expect, test } from "@playwright/test";

test.skip(
  Boolean(process.env.CLOUD_E2E_LIVE_URL),
  "Agent-detail lifecycle uses local mocks; skipped in live-prod mode",
);
test.describe.configure({ timeout: 90_000 });

// Detail route :id must be a valid UUID or the page can redirect.
const AGENT_ID = "55555555-5555-4555-8555-555555555555";

interface Mutation {
  method: string;
  path: string;
  body: unknown;
}

function agentDetail(status: "running" | "stopped") {
  const now = new Date().toISOString();
  return {
    id: AGENT_ID,
    agentName: "lifecycle-agent",
    status,
    databaseStatus: "ready",
    lastBackupAt: null,
    lastHeartbeatAt: now,
    errorMessage: null,
    errorCount: 0,
    createdAt: now,
    updatedAt: now,
    token_address: null,
    token_chain: null,
    token_name: null,
    token_ticker: null,
    dockerImage: null,
    // "shared" tier → no standalone "Open Web UI" button, keeps the action
    // card to the lifecycle buttons we are asserting.
    executionTier: "shared",
    webUiUrl: null,
    bridgeUrl: null,
    walletAddress: null,
    walletProvider: null,
    walletStatus: "none",
    adminDetails: null,
  };
}

/**
 * Records every mutation the detail page fires and serves a GET for the agent
 * in the requested lifecycle state. A specific :id route is registered before
 * the catch-all so the sub-paths (/snapshot, /resume) and the bare :id route
 * resolve deterministically.
 */
async function installAgentDetailRoutes(
  page: import("@playwright/test").Page,
  status: "running" | "stopped",
  sink: Mutation[],
) {
  const capture = (route: import("@playwright/test").Route) => {
    const req = route.request();
    let body: unknown = null;
    try {
      body = req.postDataJSON();
    } catch {
      body = req.postData();
    }
    sink.push({
      method: req.method(),
      path: new URL(req.url()).pathname,
      body,
    });
  };

  // POST /:id/snapshot and /:id/resume — enqueue a job (202 + jobId). We do NOT
  // return a jobId here so the action resolves on the synchronous-success path
  // (toast + reload) without the job poller hijacking the flow.
  await page.route(`**/api/v1/eliza/agents/${AGENT_ID}/snapshot`, (route) => {
    capture(route);
    return route.fulfill({ json: { success: true, data: {} } });
  });
  await page.route(`**/api/v1/eliza/agents/${AGENT_ID}/resume`, (route) => {
    capture(route);
    return route.fulfill({ json: { success: true, data: {} } });
  });

  // Bare /:id route handles the detail GET, the suspend PATCH and the delete
  // DELETE. GET returns the agent; mutations are captured + acked.
  await page.route(`**/api/v1/eliza/agents/${AGENT_ID}`, (route) => {
    const method = route.request().method();
    if (method === "GET") {
      return route.fulfill({
        json: { success: true, data: agentDetail(status) },
      });
    }
    capture(route);
    return route.fulfill({ json: { success: true, data: {} } });
  });

  // Generic success for everything else the dashboard pulls during render.
  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    (route) => {
      const p = new URL(route.request().url()).pathname;
      if (p.startsWith(`/api/v1/eliza/agents/${AGENT_ID}`)) {
        return route.fallback();
      }
      return route.fulfill({
        json: { success: true, data: [], items: [], balance: 100 },
      });
    },
  );
}

test.beforeEach(async ({ context }) => {
  await context.addCookies([
    {
      name: "eliza-test-auth",
      value: "1",
      domain: "127.0.0.1",
      path: "/",
      httpOnly: false,
      secure: false,
      sameSite: "Lax",
    },
  ]);
});

async function gotoDetail(
  page: import("@playwright/test").Page,
  status: "running" | "stopped",
  sink: Mutation[],
) {
  await installAgentDetailRoutes(page, status, sink);
  await page.goto(`/dashboard/agents/${AGENT_ID}`);
  await expect(page).not.toHaveURL(/\/login/);
  // No onboarding tour is registered for the agent-detail route, but dismiss
  // defensively in case a shared overlay appears.
  await page
    .getByRole("button", { name: /skip tour/i })
    .first()
    .click({ timeout: 4000 })
    .catch(() => {});
  // The "Agent Actions" card heading confirms <ElizaAgentActions> mounted.
  await expect(
    page.getByRole("heading", { name: /agent actions/i }).first(),
  ).toBeVisible({ timeout: 20_000 });
}

test("agent-detail: Save Snapshot POSTs /:id/snapshot", async ({ page }) => {
  const calls: Mutation[] = [];
  await gotoDetail(page, "running", calls);

  await page
    .getByRole("button", { name: /save snapshot/i })
    .first()
    .click();

  await expect
    .poll(() => calls.find((c) => c.path.endsWith("/snapshot")))
    .toBeTruthy();
  const snap = calls.find((c) => c.path.endsWith("/snapshot"));
  expect(snap?.method).toBe("POST");
  expect(snap?.path).toBe(`/api/v1/eliza/agents/${AGENT_ID}/snapshot`);
});

test("agent-detail: Suspend Agent sends PATCH { action: 'suspend' }", async ({
  page,
}) => {
  const calls: Mutation[] = [];
  await gotoDetail(page, "running", calls);

  await page
    .getByRole("button", { name: /suspend agent/i })
    .first()
    .click();

  await expect.poll(() => calls.find((c) => c.method === "PATCH")).toBeTruthy();
  const patch = calls.find((c) => c.method === "PATCH");
  expect(patch?.path).toBe(`/api/v1/eliza/agents/${AGENT_ID}`);
  expect(patch?.body).toMatchObject({ action: "suspend" });
});

test("agent-detail: Resume Agent POSTs /:id/resume when stopped", async ({
  page,
}) => {
  const calls: Mutation[] = [];
  await gotoDetail(page, "stopped", calls);

  await page
    .getByRole("button", { name: /resume agent/i })
    .first()
    .click();

  await expect
    .poll(() => calls.find((c) => c.path.endsWith("/resume")))
    .toBeTruthy();
  const resume = calls.find((c) => c.path.endsWith("/resume"));
  expect(resume?.method).toBe("POST");
  expect(resume?.path).toBe(`/api/v1/eliza/agents/${AGENT_ID}/resume`);
});

test("agent-detail: Delete Agent confirm sends DELETE for the agent id", async ({
  page,
}) => {
  const calls: Mutation[] = [];
  await gotoDetail(page, "running", calls);

  // The delete control is a two-step inline confirm (not a role=alertdialog):
  // "Delete Agent" reveals "Confirm delete?" + "Yes, delete".
  await page
    .getByRole("button", { name: /delete agent/i })
    .first()
    .click();
  await page
    .getByRole("button", { name: /yes, delete/i })
    .first()
    .click();

  await expect
    .poll(() => calls.find((c) => c.method === "DELETE"))
    .toBeTruthy();
  expect(calls.find((c) => c.method === "DELETE")?.path).toBe(
    `/api/v1/eliza/agents/${AGENT_ID}`,
  );
});
