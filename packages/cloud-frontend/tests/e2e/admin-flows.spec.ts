// Admin-pane behavioral coverage — the side-effecting actions on the admin
// dashboard panes that previously had no e2e assertion.
//
// In local dev (vite) the admin role gate is bypassed: AdminLayout returns the
// <Outlet /> directly when import.meta.env.DEV is true, so any authenticated
// user reaches every /dashboard/admin/* pane. The e2e build runs vite dev with
// VITE_PLAYWRIGHT_TEST_AUTH=true, so the eliza-test-auth cookie is enough.
//
// Endpoints + bodies were read from the real component sources:
//   redemptions-client.tsx    GET  /api/admin/redemptions?status=...&limit=50  → { redemptions, stats }
//                             GET  /api/v1/redemptions/status                   → SystemStatus
//                             POST /api/admin/redemptions  { redemptionId, action: "approve" }
//                             POST /api/admin/redemptions  { redemptionId, action: "reject", reason }
//   infrastructure-dashboard  GET  /api/v1/admin/docker-nodes        → { success, data: { nodes } }
//                             GET  /api/v1/admin/infrastructure       → { success, data: InfraSnapshot }
//                             GET  /api/v1/admin/headscale            → { success, data: HeadscaleData }
//                             POST /api/v1/admin/docker-nodes/:id/health-check
//                             DELETE /api/v1/admin/docker-nodes/:id
//   admin/Page.tsx (moderation)  GET  /api/v1/admin/moderation?view=...
//                                POST /api/v1/admin/moderation  { action: "ban", userId, reason }
//   rpc-status/Page.tsx        GET  /admin/rpc-status  (NOTE: api() does NOT add /api prefix)
//   admin-metrics-client.tsx   GET  /api/v1/admin/metrics?view=overview&timeRange=...
//
// Runs against the local dev build; every network call is mocked.

import { expect, test } from "@playwright/test";

test.skip(
  Boolean(process.env.CLOUD_E2E_LIVE_URL),
  "Admin flows use local mocks; skipped in live-prod mode",
);
test.describe.configure({ timeout: 90_000 });

interface Mutation {
  method: string;
  path: string;
  body: unknown;
}

function capture(route: import("@playwright/test").Route, sink: Mutation[]) {
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

// ---------------------------------------------------------------------------
// Redemptions — approve + reject
// ---------------------------------------------------------------------------

const REDEMPTION_ID = "redemption_pending_1";

function pendingRedemption() {
  const now = new Date().toISOString();
  return {
    id: REDEMPTION_ID,
    user_id: "user_redeem_1",
    status: "pending",
    usd_value: "42.50",
    eliza_amount: "1234.5678",
    eliza_price_usd: "0.034400",
    network: "base",
    payout_address: "0x1111111111111111111111111111111111111111",
    created_at: now,
    updated_at: now,
  };
}

async function installRedemptionRoutes(
  page: import("@playwright/test").Page,
  sink: Mutation[],
) {
  // System status card (GET).
  await page.route("**/api/v1/redemptions/status", (route) =>
    route.fulfill({
      json: {
        operational: true,
        networks: { base: { available: true } },
        wallets: {
          evm: {
            configured: true,
            address: "0xabc0000000000000000000000000000000000abc",
          },
          solana: { configured: false },
        },
      },
    }),
  );

  // List (GET) + approve/reject (POST) share /api/admin/redemptions.
  await page.route("**/api/admin/redemptions**", (route) => {
    if (route.request().method() === "POST") {
      capture(route, sink);
      return route.fulfill({ json: { success: true } });
    }
    return route.fulfill({
      json: {
        redemptions: [pendingRedemption()],
        stats: {
          pending: 1,
          approved: 0,
          processing: 0,
          completed: 0,
          failed: 0,
          totalPendingUsd: 42.5,
        },
      },
    });
  });

  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    (route) => {
      const p = new URL(route.request().url()).pathname;
      if (
        p.startsWith("/api/admin/redemptions") ||
        p === "/api/v1/redemptions/status"
      ) {
        return route.fallback();
      }
      return route.fulfill({
        json: { success: true, data: [], items: [], balance: 100 },
      });
    },
  );
}

async function gotoRedemptions(page: import("@playwright/test").Page) {
  await page.goto("/dashboard/admin/redemptions");
  await expect(page).not.toHaveURL(/\/login/);
  await expect(page.getByText(/access denied/i)).toHaveCount(0);
  // The pending row renders the truncated user id + the $42.50 amount.
  await expect(page.getByText("$42.50").first()).toBeVisible({
    timeout: 20_000,
  });
}

test("admin/redemptions: approve confirm POSTs { action: 'approve' }", async ({
  page,
}) => {
  const calls: Mutation[] = [];
  await installRedemptionRoutes(page, calls);
  await gotoRedemptions(page);

  // Per-row action buttons are icon-only (Eye / Check / Ban). The green Check
  // is the approve trigger; scope to the row and pick it by its green class.
  const row = page.getByRole("row").filter({ hasText: "$42.50" }).first();
  await row.locator("button.text-green-400").first().click();

  // Approve confirm is a role=alertdialog with an "Approve" action.
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: /^approve$/i })
    .click();

  await expect.poll(() => calls.find((c) => c.method === "POST")).toBeTruthy();
  const post = calls.find((c) => c.method === "POST");
  expect(post?.path).toBe("/api/admin/redemptions");
  expect(post?.body).toMatchObject({
    redemptionId: REDEMPTION_ID,
    action: "approve",
  });
});

test("admin/redemptions: reject with reason POSTs { action: 'reject', reason }", async ({
  page,
}) => {
  const calls: Mutation[] = [];
  await installRedemptionRoutes(page, calls);
  await gotoRedemptions(page);

  const row = page.getByRole("row").filter({ hasText: "$42.50" }).first();
  // The red Ban icon opens the reject dialog (a plain role=dialog, not an
  // alertdialog). "Reject & Refund" stays disabled until a reason is typed.
  await row.locator("button.text-red-400").first().click();

  const dialog = page.getByRole("dialog");
  await dialog
    .getByPlaceholder(/reason for rejection/i)
    .fill("Fraudulent payout address");
  await dialog.getByRole("button", { name: /reject & refund/i }).click();

  await expect.poll(() => calls.find((c) => c.method === "POST")).toBeTruthy();
  const post = calls.find((c) => c.method === "POST");
  expect(post?.path).toBe("/api/admin/redemptions");
  expect(post?.body).toMatchObject({
    redemptionId: REDEMPTION_ID,
    action: "reject",
    reason: "Fraudulent payout address",
  });
});

// ---------------------------------------------------------------------------
// Infrastructure — node health-check (POST) + delete node (DELETE)
// ---------------------------------------------------------------------------

const NODE_ID = "node-alpha-1";

function dockerNode() {
  const now = new Date().toISOString();
  return {
    id: "dn_1",
    nodeId: NODE_ID,
    hostname: "alpha.example.com",
    sshPort: 22,
    sshUser: "root",
    capacity: 8,
    allocatedCount: 2,
    availableSlots: 6,
    enabled: true,
    status: "healthy",
    lastHealthCheck: now,
    metadata: null,
    createdAt: now,
    updatedAt: now,
  };
}

function emptyInfraSnapshot() {
  return {
    refreshedAt: new Date().toISOString(),
    summary: {
      totalNodes: 1,
      enabledNodes: 1,
      healthyNodes: 1,
      degradedNodes: 0,
      offlineNodes: 0,
      unknownNodes: 0,
      totalCapacity: 8,
      allocatedSlots: 2,
      availableSlots: 6,
      utilizationPct: 25,
      totalContainers: 0,
      runningContainers: 0,
      stoppedContainers: 0,
      errorContainers: 0,
      healthyContainers: 0,
      attentionContainers: 0,
      failedContainers: 0,
      missingContainers: 0,
      staleContainers: 0,
    },
    incidents: [],
    nodes: [],
    containers: [],
  };
}

async function installInfraRoutes(
  page: import("@playwright/test").Page,
  sink: Mutation[],
) {
  // Health-check POST is a more specific path than the bare :id route.
  await page.route(
    `**/api/v1/admin/docker-nodes/${NODE_ID}/health-check`,
    (route) => {
      capture(route, sink);
      return route.fulfill({
        json: { success: true, data: { status: "healthy" } },
      });
    },
  );

  // Bare /:id route handles DELETE (deregister) + PATCH (edit).
  await page.route(`**/api/v1/admin/docker-nodes/${NODE_ID}`, (route) => {
    capture(route, sink);
    return route.fulfill({ json: { success: true, data: {} } });
  });

  // Node list (GET) + add-node (POST).
  await page.route("**/api/v1/admin/docker-nodes", (route) => {
    if (route.request().method() === "POST") {
      capture(route, sink);
      return route.fulfill({ json: { success: true, data: {} } });
    }
    return route.fulfill({
      json: { success: true, data: { nodes: [dockerNode()] } },
    });
  });

  await page.route("**/api/v1/admin/infrastructure", (route) =>
    route.fulfill({ json: { success: true, data: emptyInfraSnapshot() } }),
  );

  await page.route("**/api/v1/admin/headscale", (route) =>
    route.fulfill({
      json: {
        success: true,
        data: {
          user: "eliza",
          vpnNodes: [],
          summary: { total: 0, online: 0, offline: 0 },
          queriedAt: new Date().toISOString(),
        },
      },
    }),
  );

  // The infra page also renders <WarmPoolPanel>, which fetches
  // /api/v1/admin/warm-pool and reads `data.size.ready`. The generic catch-all
  // returns `data: []`, which is truthy, so WarmPoolPanel does `[].size.ready`
  // → "Cannot read properties of undefined (reading 'ready')" → the tab error
  // boundary trips and the whole page renders "Something went wrong" (no node
  // row). Serve a valid warm-pool snapshot so the panel renders cleanly.
  await page.route("**/api/v1/admin/warm-pool", (route) =>
    route.fulfill({
      json: {
        success: true,
        data: {
          enabled: true,
          minPoolSize: 1,
          maxPoolSize: 5,
          image: "eliza/agent:latest",
          size: { ready: 2, provisioning: 0, onCurrentImage: 2, stale: 0 },
          forecast: {
            bucketsHourly: [],
            predictedRate: 0,
            targetPoolSize: 2,
          },
          policy: {
            forecastWindowHours: 6,
            emaAlpha: 0.3,
            idleScaleDownMs: 600_000,
            replenishBurstLimit: 3,
          },
        },
      },
    }),
  );

  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    (route) => {
      const p = new URL(route.request().url()).pathname;
      if (p.startsWith("/api/v1/admin/docker-nodes")) return route.fallback();
      if (p === "/api/v1/admin/infrastructure") return route.fallback();
      if (p === "/api/v1/admin/headscale") return route.fallback();
      if (p === "/api/v1/admin/warm-pool") return route.fallback();
      return route.fulfill({
        json: { success: true, data: [], items: [], balance: 100 },
      });
    },
  );
}

async function gotoInfra(page: import("@playwright/test").Page) {
  await page.goto("/dashboard/admin/infrastructure");
  await expect(page).not.toHaveURL(/\/login/);
  await expect(page.getByText(/access denied/i)).toHaveCount(0);
  // The Nodes tab table renders the node id (font-mono) once data loads.
  await expect(page.getByText(NODE_ID).first()).toBeVisible({
    timeout: 20_000,
  });
}

test("admin/infrastructure: node health-check POSTs to /:id/health-check", async ({
  page,
}) => {
  const calls: Mutation[] = [];
  await installInfraRoutes(page, calls);
  await gotoInfra(page);

  // The node-row action buttons are icon-only with title attributes:
  // "Run health check" / "Edit node" / "Delete node".
  await page
    .getByRole("button", { name: /run health check/i })
    .first()
    .click();

  await expect
    .poll(() => calls.find((c) => c.path.endsWith("/health-check")))
    .toBeTruthy();
  const hc = calls.find((c) => c.path.endsWith("/health-check"));
  expect(hc?.method).toBe("POST");
  expect(hc?.path).toBe(`/api/v1/admin/docker-nodes/${NODE_ID}/health-check`);
});

test("admin/infrastructure: delete node confirm sends DELETE for the node id", async ({
  page,
}) => {
  const calls: Mutation[] = [];
  await installInfraRoutes(page, calls);
  await gotoInfra(page);

  // "Delete node" opens a "Deregister Node" confirm Dialog (role=dialog, not
  // an alertdialog); the destructive confirm button reads "Deregister".
  await page
    .getByRole("button", { name: /delete node/i })
    .first()
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /^deregister$/i })
    .click();

  await expect
    .poll(() => calls.find((c) => c.method === "DELETE"))
    .toBeTruthy();
  expect(calls.find((c) => c.method === "DELETE")?.path).toBe(
    `/api/v1/admin/docker-nodes/${NODE_ID}`,
  );
});

// ---------------------------------------------------------------------------
// Moderation admin page — ban a flagged user (POST /api/v1/admin/moderation)
// ---------------------------------------------------------------------------

const FLAGGED_USER_ID = "44444444-4444-4444-8444-444444444444";

async function installModerationRoutes(
  page: import("@playwright/test").Page,
  sink: Mutation[],
) {
  await page.route("**/api/v1/admin/moderation**", (route) => {
    const req = route.request();
    const method = req.method();
    // The admin gate issues a HEAD; reply admin-true via headers.
    if (method === "HEAD") {
      return route.fulfill({
        status: 200,
        headers: { "X-Is-Admin": "true", "X-Admin-Role": "super_admin" },
      });
    }
    if (method === "POST") {
      capture(route, sink);
      return route.fulfill({ json: { success: true } });
    }
    // GET combined / per-view: serve overview + one flagged user.
    const flaggedUser = {
      id: "mod_status_1",
      userId: FLAGGED_USER_ID,
      status: "flagged",
      totalViolations: 3,
      riskScore: 72,
      banReason: null,
    };
    return route.fulfill({
      json: {
        overview: {
          totalViolations: 3,
          flaggedUsers: 1,
          bannedUsers: 0,
          adminCount: 1,
        },
        admins: { admins: [] },
        users: { flaggedUsers: [flaggedUser], bannedUsers: [] },
        violations: { violations: [] },
        flaggedUsers: [flaggedUser],
        bannedUsers: [],
      },
    });
  });

  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    (route) => {
      if (
        new URL(route.request().url()).pathname.startsWith(
          "/api/v1/admin/moderation",
        )
      ) {
        return route.fallback();
      }
      return route.fulfill({
        json: { success: true, data: [], items: [], balance: 100 },
      });
    },
  );
}

test("admin (moderation): ban flagged user POSTs { action: 'ban', userId }", async ({
  page,
}) => {
  const calls: Mutation[] = [];
  await installModerationRoutes(page, calls);

  await page.goto("/dashboard/admin");
  await expect(page).not.toHaveURL(/\/login/);
  await expect(page.getByText(/access denied/i)).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: /admin panel/i }).first(),
  ).toBeVisible({ timeout: 20_000 });

  // Switch to the Users tab to surface the Flagged Users list + ban control.
  await page.getByRole("tab", { name: /users/i }).first().click();
  await expect(page.getByText(/flagged users/i).first()).toBeVisible();

  // The flagged-user row is a flex container showing the truncated id plus an
  // Eye (view) button and a destructive Ban button. Scope to the innermost row
  // matching the id, then click its last button (the destructive Ban trigger).
  const flaggedRow = page
    .locator("div.flex.items-center.justify-between")
    .filter({ hasText: new RegExp(FLAGGED_USER_ID.slice(0, 12)) })
    .first();
  await flaggedRow.getByRole("button").last().click();

  await expect.poll(() => calls.find((c) => c.method === "POST")).toBeTruthy();
  const post = calls.find((c) => c.method === "POST");
  expect(post?.path).toBe("/api/v1/admin/moderation");
  expect(post?.body).toMatchObject({ action: "ban", userId: FLAGGED_USER_ID });
});

// ---------------------------------------------------------------------------
// RPC status — table renders + Refresh re-fetches GET /admin/rpc-status
// ---------------------------------------------------------------------------

test("admin/rpc-status: renders probes and Refresh re-fetches", async ({
  page,
}) => {
  let getCount = 0;
  // NOTE: this page calls api("/admin/rpc-status") which does NOT prefix /api.
  // Match the EXACT pathname, not a `**/admin/rpc-status` glob — that glob also
  // matches the document navigation to `/dashboard/admin/rpc-status`, which
  // would fulfill the page load itself with this JSON (the browser then renders
  // raw JSON text instead of the SPA, so the "RPC Status" heading never mounts).
  await page.route(
    (url) => url.pathname === "/admin/rpc-status",
    (route) => {
      getCount += 1;
      return route.fulfill({
        json: {
          success: true,
          data: {
            evm: [
              {
                network: "base",
                chainId: 8453,
                rpcUrl: "https://base.example/rpc",
                rpcSource: "alchemy",
                reachable: true,
                latencyMs: 42,
                latestBlock: "12345678",
                hotWalletAddress: "0xfeed000000000000000000000000000000000feed",
                hotWalletBalance: 1000,
                error: null,
              },
            ],
            solana: { rpcUrl: "https://solana.example/rpc", configured: true },
            allReachable: true,
            hotWalletAddress: "0xfeed000000000000000000000000000000000feed",
            checkedAt: new Date().toISOString(),
          },
        },
      });
    },
  );

  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    (route) =>
      route.fulfill({
        json: { success: true, data: [], items: [], balance: 100 },
      }),
  );

  await page.goto("/dashboard/admin/rpc-status");
  await expect(page).not.toHaveURL(/\/login/);
  await expect(page.getByText(/access denied/i)).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: /rpc status/i }).first(),
  ).toBeVisible({ timeout: 20_000 });
  // Probe card for the base network renders.
  await expect(page.getByText(/treasury hot wallet/i).first()).toBeVisible();
  await expect(page.getByText("base").first()).toBeVisible();

  const before = getCount;
  await page
    .locator("#main")
    .getByRole("button", { name: /refresh/i })
    .first()
    .click();
  await expect.poll(() => getCount).toBeGreaterThan(before);
});

// ---------------------------------------------------------------------------
// Engagement metrics — table/stats render + Refresh re-fetches the overview
// ---------------------------------------------------------------------------

test("admin/metrics: renders KPI stats and a time-range switch re-fetches", async ({
  page,
}) => {
  let overviewCount = 0;
  await page.route("**/api/v1/admin/metrics**", (route) => {
    overviewCount += 1;
    return route.fulfill({
      json: {
        dau: 120,
        wau: 450,
        mau: 1300,
        newSignups7d: 35,
        newSignupsToday: 4,
        avgMessagesPerUser: 7,
        oauthRate: {
          ratePercent: 62.5,
          connected_users: 50,
          total_users: 80,
          byService: { telegram: 30, discord: 20 },
        },
        dailyTrend: [],
        platformBreakdown: { web: 100, telegram: 30 },
        platformDistribution: [],
        retentionCohorts: [],
        retentionRates: [],
      },
    });
  });

  // The metrics page also renders <CloudObservabilityPanel>, which fetches
  // /api/v1/admin/cloud-observability and does `data.requests.slice(0, 8)`. The
  // generic catch-all returns `data: []`, so the panel does `[].requests.slice`
  // → "Cannot read properties of undefined (reading 'slice')" → the page falls
  // into the error boundary and "Controls" never renders. Serve a valid (empty)
  // telemetry snapshot so the panel renders cleanly.
  await page.route("**/api/v1/admin/cloud-observability**", (route) =>
    route.fulfill({
      json: {
        success: true,
        data: {
          generatedAt: new Date().toISOString(),
          thresholds: { slowRequestMs: 500, slowDbMs: 100, dbBurstCount: 10 },
          requests: [],
          slowRequests: [],
          slowDb: [],
          burstyRequests: [],
          duplicateReadRequests: [],
        },
      },
    }),
  );

  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    (route) => {
      const p = new URL(route.request().url()).pathname;
      if (p.startsWith("/api/v1/admin/metrics")) return route.fallback();
      if (p.startsWith("/api/v1/admin/cloud-observability")) {
        return route.fallback();
      }
      return route.fulfill({
        json: { success: true, data: [], items: [], balance: 100 },
      });
    },
  );

  await page.goto("/dashboard/admin/metrics");
  await expect(page).not.toHaveURL(/\/login/);
  await expect(page.getByText(/access denied/i)).toHaveCount(0);
  // The Controls card + KPI cells render once the overview loads.
  await expect(page.getByText("Controls").first()).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByText("DAU").first()).toBeVisible();
  await expect(page.getByText("120").first()).toBeVisible();

  // Switching the time range re-fires fetchOverview against /api/v1/admin/metrics.
  // (The page also has a "Refresh" button, but a sibling observability panel
  // renders its own "Refresh" first — a time-range button is metrics-specific.)
  const before = overviewCount;
  await page
    .getByRole("button", { name: /^7 days$/i })
    .first()
    .click();
  await expect.poll(() => overviewCount).toBeGreaterThan(before);
});
