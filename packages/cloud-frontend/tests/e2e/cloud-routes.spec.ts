import { readdirSync, statSync } from "node:fs";
import pathModule from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import {
  assertScreenshotNotBlank,
  captureScreenshotWithQualityRetry,
} from "./_helpers/screenshot-quality";

// In live-prod mode the mocked-API specs do not apply (cookies are scoped to
// 127.0.0.1, fixtures don't exist on real backends). Skip the whole file.
test.skip(
  Boolean(process.env.CLOUD_E2E_LIVE_URL),
  "cloud-routes.spec uses local mocks; live-prod runs cloud-routes-live.spec instead",
);

test.describe.configure({ mode: "serial" });

const HERE = pathModule.dirname(fileURLToPath(import.meta.url));
const CONTENT_DIR = pathModule.resolve(HERE, "../../content");

// Console messages we explicitly tolerate. Keep this list short and
// document each entry — anything that lands here is a regression candidate.
const CONSOLE_ERROR_ALLOWLIST: RegExp[] = [
  /Failed to load resource.*favicon/i,
  // Render telemetry is asserted by dedicated runtime tests; broad route smoke
  // keeps its signal on page errors, 4xx/5xx responses, not-found pages, and
  // blank renders.
  /^\[RenderTelemetry\]/,
  // Vite dev HMR ping noise when the dev server restarts during a test
  /\[vite\] connecting/i,
  /\[vite\] connected/i,
];

// Requests we don't fail on if they 4xx/5xx — e.g. optional analytics,
// third-party heartbeats. Keep this empty until proven necessary.
const NETWORK_FAILURE_ALLOWLIST: RegExp[] = [/\/__telemetry__/];

// Default <title> set by RootLayout's <Helmet>. Sub-pages that forget to
// set their own Helmet title fall back to this, which is the bug pattern we
// fix by hoisting <Helmet> above auth-loading short-circuits.
const HOMEPAGE_TITLE_FALLBACK = /Eliza Cloud - Launch Eliza/i;
const ROUTE_TITLE_RULES: Record<string, RegExp> = {
  "/": HOMEPAGE_TITLE_FALLBACK,
  "/os": HOMEPAGE_TITLE_FALLBACK,
  "/blog": HOMEPAGE_TITLE_FALLBACK,
  "/sandbox-proxy": HOMEPAGE_TITLE_FALLBACK,
};

function discoverDocsRoutes(): string[] {
  const routes: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const fullPath = pathModule.join(dir, entry);
      const stats = statSync(fullPath);
      if (stats.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (!entry.endsWith(".mdx")) continue;
      const rel = pathModule
        .relative(CONTENT_DIR, fullPath)
        .replace(/\\/g, "/")
        .replace(/\.mdx$/, "");
      if (rel === "index") {
        routes.push("/docs");
      } else if (rel.endsWith("/index")) {
        routes.push(`/docs/${rel.slice(0, -"/index".length)}`);
      } else {
        routes.push(`/docs/${rel}`);
      }
    }
  };
  walk(CONTENT_DIR);
  return [...new Set(routes)].sort();
}

const docsRoutes = discoverDocsRoutes();

interface CapturedFailures {
  pageErrors: string[];
  consoleErrors: string[];
  failedResponses: Array<{ url: string; status: number }>;
}

function attachFailureCollectors(page: Page): CapturedFailures {
  const captured: CapturedFailures = {
    pageErrors: [],
    consoleErrors: [],
    failedResponses: [],
  };

  page.on("pageerror", (err) => {
    captured.pageErrors.push(err.message ?? String(err));
  });

  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    if (CONSOLE_ERROR_ALLOWLIST.some((r) => r.test(text))) return;
    captured.consoleErrors.push(text);
  });

  page.on("response", (resp) => {
    const status = resp.status();
    if (status < 400) return;
    const url = resp.url();
    if (NETWORK_FAILURE_ALLOWLIST.some((r) => r.test(url))) return;
    captured.failedResponses.push({ url, status });
  });

  return captured;
}

function assertNoFailures(route: string, captured: CapturedFailures) {
  const lines: string[] = [];
  if (captured.pageErrors.length) {
    lines.push(
      `Uncaught page errors on ${route}:\n` +
        captured.pageErrors.map((e) => `  - ${e}`).join("\n"),
    );
  }
  if (captured.consoleErrors.length) {
    lines.push(
      `Console errors on ${route}:\n` +
        captured.consoleErrors.map((e) => `  - ${e}`).join("\n"),
    );
  }
  if (captured.failedResponses.length) {
    lines.push(
      `Failed responses on ${route}:\n` +
        captured.failedResponses
          .map((f) => `  - ${f.status} ${f.url}`)
          .join("\n"),
    );
  }
  if (lines.length) throw new Error(lines.join("\n\n"));
}

const publicRoutes = [
  "/",
  "/os",
  "/blog",
  "/login",
  "/terms-of-service",
  "/privacy-policy",
  ...docsRoutes,
  "/sandbox-proxy",
  "/bsc",
  "/chat/agent_1",
  "/auth/success?platform=github",
  "/auth/cli-login?session=cli_session_1",
  "/auth/error?reason=auth_failed",
  "/auth/callback/email",
  "/app-auth/authorize",
  "/invite/accept",
  "/payment/pay_req_1",
  "/payment/app-charge/app_1/charge_1",
  "/payment/success?payment_request_id=pay_req_1",
  "/sensitive-requests/req_1",
  "/approve/approval_1",
  "/ballot/ballot_1?token=test-token",
];

const dashboardRoutes = [
  "/dashboard",
  "/dashboard/account",
  "/dashboard/security",
  "/dashboard/settings",
  "/dashboard/billing",
  "/dashboard/billing/success",
  "/dashboard/agents",
  "/dashboard/agents/agent_1",
  "/dashboard/agents/agent_1/chat",
  "/dashboard/apps",
  "/dashboard/apps/app_1",
  "/dashboard/my-agents",
  "/dashboard/api-keys",
  "/dashboard/mcps",
  "/dashboard/documents",
  "/dashboard/analytics",
  "/dashboard/earnings",
  "/dashboard/affiliates",
  "/dashboard/invoices/inv_1",
  "/dashboard/chat",
  "/dashboard/api-explorer",
  "/dashboard/admin",
  "/dashboard/admin/infrastructure",
  "/dashboard/admin/metrics",
  "/dashboard/admin/rpc-status",
  "/dashboard/admin/redemptions",
];

// Legacy paths kept for inbound links; the real implementation redirects them
// to the canonical dashboard surface. Tested separately from the renders list.
// /dashboard/chat is intentionally not in this list — it's a smart route
// (redirects to an existing agent's chat OR shows an empty state) rather than
// a pure redirect.
const dashboardRedirects: Array<[from: string, toPattern: RegExp]> = [
  ["/dashboard/image", /\/dashboard\/api-explorer$/],
  ["/dashboard/video", /\/dashboard\/api-explorer$/],
  ["/dashboard/gallery", /\/dashboard\/api-explorer$/],
  ["/dashboard/voices", /\/dashboard\/api-explorer$/],
  ["/dashboard/containers", /\/dashboard\/agents$/],
  ["/dashboard/containers/agent_1", /\/dashboard\/agents\/agent_1$/],
  ["/dashboard/containers/agents/agent_1", /\/dashboard\/agents\/agent_1$/],
];

const publicRedirects: Array<[from: string, to: string, bodyText: string]> = [
  [
    "/checkout?collection=elizaos-hardware",
    "https://elizaos.ai/checkout?collection=elizaos-hardware",
    "elizaOS checkout",
  ],
];

async function installApiMocks(page: Page) {
  await page.route(
    (url) =>
      url.pathname.startsWith("/api/") || url.pathname === "/admin/rpc-status",
    async (route) => {
      const url = new URL(route.request().url());
      const path = url.pathname;

      if (path === "/admin/rpc-status") {
        return route.fulfill({
          json: {
            success: true,
            data: {
              evm: [
                {
                  network: "ethereum",
                  chainId: 1,
                  rpcUrl: "https://rpc.example.test/ethereum",
                  rpcSource: "test",
                  reachable: true,
                  latencyMs: 12,
                  latestBlock: "123",
                  hotWalletAddress:
                    "0x0000000000000000000000000000000000000001",
                  hotWalletBalance: 100,
                  error: null,
                },
                {
                  network: "base",
                  chainId: 8453,
                  rpcUrl: "https://rpc.example.test/base",
                  rpcSource: "test",
                  reachable: true,
                  latencyMs: 9,
                  latestBlock: "456",
                  hotWalletAddress:
                    "0x0000000000000000000000000000000000000001",
                  hotWalletBalance: 100,
                  error: null,
                },
                {
                  network: "bnb",
                  chainId: 56,
                  rpcUrl: "https://rpc.example.test/bnb",
                  rpcSource: "test",
                  reachable: true,
                  latencyMs: 10,
                  latestBlock: "789",
                  hotWalletAddress:
                    "0x0000000000000000000000000000000000000001",
                  hotWalletBalance: 100,
                  error: null,
                },
              ],
              solana: {
                rpcUrl: "https://rpc.example.test/solana",
                configured: true,
              },
              allReachable: true,
              hotWalletAddress: "0x0000000000000000000000000000000000000001",
              checkedAt: new Date().toISOString(),
            },
          },
        });
      }

      if (path === "/api/v1/api-keys") {
        return route.fulfill({
          json: { keys: [] },
        });
      }

      if (
        path === "/api/credits/balance" ||
        path === "/api/v1/credits/balance"
      ) {
        return route.fulfill({
          json: { balance: 100, currency: "USD" },
        });
      }

      if (path === "/api/invoices/list") {
        return route.fulfill({
          json: { invoices: [] },
        });
      }

      if (path === "/api/v1/billing/settings") {
        return route.fulfill({
          json: {
            settings: {
              payAsYouGoFromEarnings: false,
              autoTopUp: {
                enabled: false,
                amount: 25,
                threshold: 5,
                hasPaymentMethod: false,
              },
              limits: {
                minAmount: 1,
                maxAmount: 10_000,
                minThreshold: 1,
                maxThreshold: 10_000,
              },
            },
          },
        });
      }

      if (path === "/api/crypto/status") {
        return route.fulfill({
          json: {
            enabled: true,
            directWallet: { networks: [] },
          },
        });
      }

      if (path === "/api/v1/user") {
        const now = new Date().toISOString();
        return route.fulfill({
          json: {
            success: true,
            data: {
              id: "22222222-2222-4222-8222-222222222222",
              email: "test@example.com",
              email_verified: true,
              wallet_address: "0x0000000000000000000000000000000000000001",
              wallet_chain_type: "evm",
              wallet_verified: true,
              name: "Test User",
              avatar: null,
              organization_id: "org_1",
              role: "owner",
              steward_user_id: "steward_1",
              telegram_id: null,
              telegram_username: null,
              telegram_first_name: null,
              telegram_photo_url: null,
              discord_id: null,
              discord_username: null,
              discord_global_name: null,
              discord_avatar_url: null,
              whatsapp_id: null,
              whatsapp_name: null,
              phone_number: null,
              phone_verified: false,
              is_anonymous: false,
              anonymous_session_id: null,
              expires_at: null,
              nickname: "Tester",
              work_function: "engineering",
              preferences: null,
              email_notifications: true,
              response_notifications: true,
              is_active: true,
              created_at: now,
              updated_at: now,
              organization: {
                id: "org_1",
                name: "Eliza QA",
                slug: "eliza-qa",
                credit_balance: "100.00",
                billing_email: "billing@example.com",
                is_active: true,
                created_at: now,
                updated_at: now,
              },
            },
          },
        });
      }

      if (path === "/api/my-agents/characters") {
        return route.fulfill({
          json: {
            success: true,
            data: {
              characters: [],
              pagination: {
                page: 1,
                limit: 20,
                totalPages: 0,
                totalCount: 0,
                hasMore: false,
              },
            },
          },
        });
      }

      if (path === "/api/my-agents/saved") {
        return route.fulfill({
          json: { success: true, data: { agents: [] } },
        });
      }

      if (path === "/api/my-agents/claim-affiliate-characters") {
        return route.fulfill({
          json: { success: true, claimed: 0 },
        });
      }

      if (path === "/api/invoices/inv_1") {
        const now = new Date().toISOString();
        return route.fulfill({
          json: {
            invoice: {
              id: "inv_1",
              stripeInvoiceId: "stripe_inv_1",
              stripeCustomerId: "stripe_customer_1",
              stripePaymentIntentId: null,
              amountDue: 1000,
              amountPaid: 1000,
              currency: "usd",
              status: "paid",
              invoiceType: "credits",
              invoiceNumber: "INV-1",
              invoicePdf: null,
              hostedInvoiceUrl: null,
              creditsAdded: 10,
              metadata: {},
              createdAt: now,
              updatedAt: now,
              dueDate: now,
              paidAt: now,
            },
          },
        });
      }

      if (path === "/api/v1/admin/cloud-observability") {
        return route.fulfill({
          json: {
            success: true,
            data: {
              generatedAt: new Date().toISOString(),
              thresholds: {
                slowRequestMs: 1000,
                slowDbMs: 100,
                dbBurstCount: 10,
              },
              requests: [],
              slowRequests: [],
              slowDb: [],
              burstyRequests: [],
              duplicateReadRequests: [],
            },
          },
        });
      }

      if (path === "/api/v1/admin/warm-pool") {
        return route.fulfill({
          json: {
            success: true,
            data: {
              enabled: true,
              minPoolSize: 1,
              maxPoolSize: 3,
              image: "elizaos/agent:test",
              size: {
                ready: 1,
                provisioning: 0,
                onCurrentImage: 1,
                stale: 0,
              },
              forecast: {
                bucketsHourly: [0, 1, 0, 2],
                predictedRate: 0.75,
                targetPoolSize: 1,
              },
              policy: {
                forecastWindowHours: 4,
                emaAlpha: 0.5,
                idleScaleDownMs: 300_000,
                replenishBurstLimit: 2,
              },
            },
          },
        });
      }

      if (path === "/api/v1/admin/docker-nodes") {
        const now = new Date().toISOString();
        return route.fulfill({
          json: {
            success: true,
            data: {
              nodes: [
                {
                  id: "node_1",
                  nodeId: "node_1",
                  hostname: "node-1.example.test",
                  sshPort: 22,
                  sshUser: "root",
                  capacity: 4,
                  allocatedCount: 1,
                  availableSlots: 3,
                  enabled: true,
                  status: "healthy",
                  lastHealthCheck: now,
                  metadata: null,
                  createdAt: now,
                  updatedAt: now,
                },
              ],
            },
          },
        });
      }

      if (path === "/api/v1/admin/infrastructure") {
        const now = new Date().toISOString();
        const container = {
          id: "container_1",
          sandboxId: "agent_1",
          agentName: "Test Agent",
          organizationId: "org_1",
          userId: "user_1",
          nodeId: "node_1",
          containerName: "eliza-agent-1",
          dbStatus: "running",
          liveHealth: "healthy",
          liveHealthSeverity: "info",
          liveHealthReason: "ok",
          runtimeState: "running",
          runtimeStatus: "Up 5 minutes",
          runtimePresent: true,
          dockerImage: "elizaos/agent:test",
          bridgePort: 3000,
          webUiPort: 3001,
          headscaleIp: "100.64.0.10",
          bridgeUrl: "http://100.64.0.10:3000",
          healthUrl: "http://100.64.0.10:3000/health",
          lastHeartbeatAt: now,
          heartbeatAgeMinutes: 1,
          errorMessage: null,
          errorCount: 0,
          createdAt: now,
          updatedAt: now,
        };

        return route.fulfill({
          json: {
            success: true,
            data: {
              refreshedAt: now,
              summary: {
                totalNodes: 1,
                enabledNodes: 1,
                healthyNodes: 1,
                degradedNodes: 0,
                offlineNodes: 0,
                unknownNodes: 0,
                totalCapacity: 4,
                allocatedSlots: 1,
                availableSlots: 3,
                utilizationPct: 25,
                totalContainers: 1,
                runningContainers: 1,
                stoppedContainers: 0,
                errorContainers: 0,
                healthyContainers: 1,
                attentionContainers: 0,
                failedContainers: 0,
                missingContainers: 0,
                staleContainers: 0,
              },
              incidents: [],
              nodes: [
                {
                  id: "node_1",
                  nodeId: "node_1",
                  hostname: "node-1.example.test",
                  sshPort: 22,
                  sshUser: "root",
                  capacity: 4,
                  allocatedCount: 1,
                  availableSlots: 3,
                  enabled: true,
                  status: "healthy",
                  lastHealthCheck: now,
                  utilizationPct: 25,
                  runtime: {
                    reachable: true,
                    checkedAt: now,
                    sshLatencyMs: 12,
                    dockerVersion: "25.0.0",
                    diskUsedPercent: 40,
                    memoryUsedPercent: 55,
                    loadAverage: "0.10 0.20 0.30",
                    actualContainerCount: 1,
                    runningContainerCount: 1,
                    containers: [
                      {
                        name: "eliza-agent-1",
                        id: "container_1",
                        image: "elizaos/agent:test",
                        state: "running",
                        status: "Up 5 minutes",
                        runningFor: "5 minutes",
                        health: "healthy",
                      },
                    ],
                    error: null,
                  },
                  allocationDrift: 0,
                  alerts: [],
                  containers: [container],
                  ghostContainers: [],
                  metadata: null,
                  createdAt: now,
                  updatedAt: now,
                },
              ],
              containers: [container],
            },
          },
        });
      }

      if (path === "/api/v1/admin/headscale") {
        const now = new Date().toISOString();
        return route.fulfill({
          json: {
            success: true,
            data: {
              serverConfigured: true,
              user: "eliza",
              vpnNodes: [],
              summary: { total: 0, online: 0, offline: 0 },
              queriedAt: now,
            },
          },
        });
      }

      if (path === "/api/v1/admin/metrics") {
        const today = new Date().toISOString().slice(0, 10);
        return route.fulfill({
          json: {
            dau: 1,
            wau: 1,
            mau: 1,
            newSignupsToday: 1,
            newSignups7d: 1,
            avgMessagesPerUser: 1,
            platformBreakdown: { web: 1 },
            platformDistribution: [{ key: "web", count: 1, percent: 100 }],
            oauthRate: {
              total_users: 1,
              connected_users: 1,
              rate: 1,
              ratePercent: 100,
              byService: { github: 1 },
            },
            dailyTrend: [
              {
                date: today,
                platform: null,
                dau: 1,
                new_signups: 1,
                total_messages: 1,
                messages_per_user: "1",
              },
            ],
            retentionCohorts: [
              {
                cohort_date: today,
                platform: null,
                cohort_size: 1,
                d1_retained: 1,
                d7_retained: 1,
                d30_retained: 1,
              },
            ],
            retentionRates: [
              {
                cohortDate: today,
                cohortSize: 1,
                d1: 100,
                d7: 100,
                d30: 100,
              },
            ],
          },
        });
      }

      if (path.includes("/approval-requests/")) {
        return route.fulfill({
          json: {
            success: true,
            approvalRequest: {
              id: "approval_1",
              organizationId: "org_1",
              agentId: "agent_1",
              userId: "user_1",
              challengeKind: "generic",
              challengePayload: { message: "Approve this test request" },
              expectedSignerIdentityId: null,
              status: "pending",
              expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              metadata: null,
            },
          },
        });
      }

      if (path.includes("/ballots/")) {
        return route.fulfill({
          json: {
            success: true,
            ballot: {
              id: "ballot_1",
              organizationId: "org_1",
              purpose: "Choose a test option",
              threshold: 1,
              status: "open",
              participants: [{ identityId: "identity_1", label: "Tester" }],
              expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
              createdAt: new Date().toISOString(),
            },
          },
        });
      }

      if (path.includes("/characters/agent_1/public")) {
        return route.fulfill({
          json: {
            success: true,
            data: {
              id: "agent_1",
              name: "Test Agent",
              username: "test-agent",
              avatarUrl: null,
              bio: "A shared test agent.",
              creatorUsername: "tester",
            },
          },
        });
      }

      if (path === "/api/v1/eliza/agents") {
        const now = new Date().toISOString();
        return route.fulfill({
          json: {
            success: true,
            data: [
              {
                id: "agent_1",
                agentName: "Test Agent",
                name: "Test Agent",
                status: "running",
                createdAt: now,
                updatedAt: now,
                lastHeartbeatAt: now,
                adminDetails: {
                  webUiUrl: "https://agent.example.test",
                },
              },
            ],
          },
        });
      }

      if (path === "/api/v1/eliza/agents/agent_1") {
        const now = new Date().toISOString();
        return route.fulfill({
          json: {
            success: true,
            data: {
              id: "agent_1",
              agentName: "Test Agent",
              name: "Test Agent",
              status: "running",
              createdAt: now,
              updatedAt: now,
              lastHeartbeatAt: now,
              adminDetails: {
                webUiUrl: "https://agent.example.test",
              },
            },
          },
        });
      }

      if (path.includes("/api/v1/cli-login/")) {
        return route.fulfill({
          json: {
            success: true,
            apiKeyPrefix: "eliza_test",
          },
        });
      }

      if (path.includes("/sensitive-requests/")) {
        return route.fulfill({
          json: {
            success: true,
            request: {
              id: "req_1",
              kind: "secret",
              status: "pending",
              title: "Sensitive request",
              prompt: "Enter a test secret",
              fields: [{ id: "secret", label: "Secret", type: "password" }],
            },
          },
        });
      }

      if (path === "/api/v1/redemptions/balance") {
        return route.fulfill({
          json: {
            balance: {
              totalEarned: 250,
              availableBalance: 125,
              pendingBalance: 25,
              totalRedeemed: 100,
              totalPending: 25,
              totalConvertedToCredits: 0,
            },
            bySource: [
              { source: "agent", totalEarned: 150, count: 3 },
              { source: "miniapp", totalEarned: 100, count: 2 },
            ],
            recentEarnings: [
              {
                id: "earning_1",
                source: "agent",
                sourceId: "agent_1",
                amount: 25,
                description: "Test agent usage",
                createdAt: new Date().toISOString(),
              },
            ],
            limits: {
              minRedemptionUsd: 10,
              maxSingleRedemptionUsd: 1000,
              userDailyLimitUsd: 1000,
              userHourlyLimitUsd: 250,
            },
            eligibility: {
              canRedeem: true,
              dailyLimitRemaining: 1000,
            },
          },
        });
      }

      if (path === "/api/v1/redemptions/status") {
        return route.fulfill({
          json: {
            operational: true,
            networks: {
              base: { available: true },
              solana: { available: true },
              ethereum: { available: true },
              bnb: { available: true },
            },
          },
        });
      }

      if (path === "/api/v1/redemptions") {
        return route.fulfill({
          json: {
            redemptions: [],
          },
        });
      }

      if (path === "/api/v1/containers/container_1/deployments") {
        return route.fulfill({
          json: {
            success: true,
            data: {
              deployments: [
                {
                  id: "deployment_1",
                  status: "success",
                  cost: 1.25,
                  metadata: {
                    container_id: "container_1",
                    container_name: "Test Container",
                    desired_count: 1,
                    cpu: 256,
                    memory: 512,
                    port: 3000,
                    image_tag: "test",
                  },
                  deployed_at: new Date().toISOString(),
                  duration_ms: 1200,
                },
              ],
            },
          },
        });
      }

      if (path.endsWith("/models/status")) {
        return route.fulfill({
          json: {
            models: [
              { modelId: "openai/gpt-image-1", available: true },
              { modelId: "black-forest-labs/flux-pro", available: true },
              { modelId: "google/imagen-4", available: true },
            ],
            timestamp: Date.now(),
          },
        });
      }

      if (path.endsWith("/models")) {
        return route.fulfill({
          json: {
            object: "list",
            data: [
              {
                id: "gpt-4.1-mini",
                name: "GPT 4.1 Mini",
                provider: "openai",
                type: "text",
              },
            ],
          },
        });
      }

      if (path === "/api/analytics/breakdown") {
        const now = new Date();
        const startDate = new Date(now);
        startDate.setDate(now.getDate() - 7);
        return route.fulfill({
          json: {
            success: true,
            data: {
              filters: {
                startDate: startDate.toISOString(),
                endDate: now.toISOString(),
                granularity: "day",
                timeRange: "weekly",
              },
              overallStats: {
                totalRequests: 12,
                totalInputTokens: 1200,
                totalOutputTokens: 800,
                totalCost: 0.42,
                successRate: 0.98,
              },
              timeSeriesData: [
                {
                  timestamp: startDate.toISOString(),
                  totalRequests: 12,
                  totalCost: 0.42,
                  inputTokens: 1200,
                  outputTokens: 800,
                  successRate: 0.98,
                  successRatePercent: 98,
                },
              ],
              costTrending: {
                currentDailyBurn: 0.06,
                previousDailyBurn: 0.04,
                burnChangePercent: 50,
                projectedMonthlyBurn: 1.8,
                daysUntilBalanceZero: null,
                monthlyBurnPercent: 2,
                monthlyBurnPercentClamped: 2,
                burnAlertThresholdExceeded: false,
              },
              providerBreakdown: [
                {
                  provider: "openai",
                  totalRequests: 12,
                  totalCost: 0.42,
                  totalTokens: 2000,
                  successRate: 0.98,
                  percentage: 100,
                },
              ],
              modelBreakdown: [
                {
                  model: "gpt-4.1-mini",
                  provider: "openai",
                  totalRequests: 12,
                  totalCost: 0.42,
                  totalTokens: 2000,
                  avgCostPerToken: 0.00021,
                  successRate: 0.98,
                },
              ],
              trends: {
                requestsChange: 10,
                costChange: 5,
                tokensChange: 8,
                successRateChange: 1,
                period: "previous week",
              },
              organization: {
                creditBalance: "100.00",
              },
            },
          },
        });
      }

      if (path === "/api/analytics/projections") {
        const now = new Date();
        const next = new Date(now);
        next.setDate(now.getDate() + 1);
        return route.fulfill({
          json: {
            success: true,
            data: {
              historicalData: [
                {
                  timestamp: now.toISOString(),
                  totalRequests: 12,
                  totalCost: 0.42,
                  inputTokens: 1200,
                  outputTokens: 800,
                  successRate: 0.98,
                  successRatePercent: 98,
                },
              ],
              projections: [
                {
                  timestamp: next.toISOString(),
                  projectedCost: 0.5,
                  projectedRequests: 14,
                  confidenceLower: 0.35,
                  confidenceUpper: 0.7,
                },
              ],
              alerts: [],
              creditBalance: 100,
            },
          },
        });
      }

      return route.fulfill({
        json: {
          success: true,
          data: [],
          items: [],
          agents: [],
          apps: [],
          containers: [],
          balance: 100,
          user: { id: "user_1", email: "test@example.com" },
        },
      });
    },
  );
}

async function setTestAuth(page: Page) {
  await page.context().addCookies([
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
}

async function captureRouteScreenshot(page: Page): Promise<Buffer> {
  let lastError: unknown;

  for (const fullPage of [true, false]) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await captureScreenshotWithQualityRetry(
          page,
          `route ${page.url()} ${fullPage ? "full-page" : "viewport"}`,
          { fullPage },
        );
      } catch (error) {
        lastError = error;
        await page.waitForTimeout(150);
      }
    }
  }

  throw lastError;
}

test.beforeEach(async ({ page }) => {
  await installApiMocks(page);
});

for (const route of publicRoutes) {
  test(`public route renders: ${route}`, async ({ page }) => {
    const captured = attachFailureCollectors(page);
    const isSandboxProxy = route === "/sandbox-proxy";
    // networkidle so lazy route chunks finish loading before title checks; the
    // proxy page has no async route title and can wait for its status text.
    await page.goto(route, {
      waitUntil: isSandboxProxy ? "domcontentloaded" : "networkidle",
    });
    if (isSandboxProxy) {
      await expect(page.getByText("Eliza Sandbox Proxy Active")).toBeVisible();
    }
    await expect(page.locator("body")).toBeVisible();
    await expect(
      page.getByRole("heading", { name: /^Page Not Found$/i }),
    ).toHaveCount(0);
    const screenshot = await captureRouteScreenshot(page);
    await assertScreenshotNotBlank(screenshot, route);

    // Title rule: each route should set a route-specific <title>; sub-pages
    // must not silently fall back to the homepage title.
    const pathKey = route.split("?")[0];
    const titleRule = ROUTE_TITLE_RULES[pathKey];
    if (pathKey !== "/" && !titleRule) {
      // Wait up to 5s for Helmet on the actual page to win over the global
      // RootLayout title. Lazy-loaded routes (Suspense + dynamic import)
      // need a beat after networkidle before their <Helmet> applies.
      await expect
        .poll(async () => page.title(), { timeout: 5_000 })
        .not.toMatch(HOMEPAGE_TITLE_FALLBACK);
    }
    const title = await page.title();
    if (titleRule) {
      expect(title, `unexpected title on ${route}: ${title}`).toMatch(
        titleRule,
      );
    }
    expect(title, `missing title on ${route}`).not.toHaveLength(0);

    assertNoFailures(route, captured);
  });
}

for (const route of dashboardRoutes) {
  test(`dashboard route renders: ${route}`, async ({ page }) => {
    await setTestAuth(page);
    const captured = attachFailureCollectors(page);
    await page.goto(route, { waitUntil: "networkidle" });
    await page.waitForTimeout(250);
    await expect(page.locator("body")).toBeVisible();
    await expect(page).not.toHaveURL(/\/login/);
    await expect(
      page.getByRole("heading", { name: /^Page Not Found$/i }),
    ).toHaveCount(0);
    const screenshot = await captureScreenshotWithQualityRetry(page, route, {
      fullPage: true,
    });
    await assertScreenshotNotBlank(screenshot, route);
    assertNoFailures(route, captured);
  });
}

test("legacy dashboard routes redirect to their canonical surfaces", async ({
  page,
}) => {
  await setTestAuth(page);
  await page.goto("/dashboard/build/foo?x=1");
  await expect(page).toHaveURL(/\/dashboard\/my-agents\?x=1$/);

  await page.goto("/dashboard/apps/create");
  await expect(page).toHaveURL(/\/dashboard\/apps$/);
});

for (const [from, toPattern] of dashboardRedirects) {
  test(`legacy dashboard redirect: ${from}`, async ({ page }) => {
    await setTestAuth(page);
    await page.goto(from);
    await expect(page).toHaveURL(toPattern);
  });
}

for (const [from, to, bodyText] of publicRedirects) {
  test(`public redirect route: ${from}`, async ({ page }) => {
    await page.route("https://elizaos.ai/**", (route) =>
      route.fulfill({
        body: `<html><body>${bodyText}</body></html>`,
        contentType: "text/html",
      }),
    );

    await page.goto(from);
    await expect(page).toHaveURL(to);
    await expect(page.getByText(bodyText)).toBeVisible();
  });
}

test("anonymous protected dashboard routes redirect to login", async ({
  context,
  page,
}) => {
  await context.clearCookies();
  await page.goto("/dashboard/agents");
  await expect(page).toHaveURL(/\/login\?returnTo=/);
});
