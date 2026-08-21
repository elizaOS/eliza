/**
 * Shared cloud-audit fixtures + Playwright helpers (extracted from
 * cloud-surfaces-aesthetic-audit.spec.ts so the focused Applications
 * dropdown contrast spec (#14232) reuses the SAME auth seeding + API stub
 * surface — a thinner stub set leaves ApplicationDetailPage stuck on its
 * session-not-ready loading spinner instead of the real analytics/earnings
 * tab. Keeping one source of truth avoids drift between the two specs.
 */
import { STEWARD_TOKEN_KEY } from "@elizaos/shared/steward-session-client";
import type { Page } from "@playwright/test";

function makeJwt(payload: Record<string, unknown>): string {
  const encode = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode(payload)}.sig`;
}

export async function seedStewardToken(page: Page): Promise<void> {
  const token = makeJwt({
    sub: "cloud-audit-smoke-user",
    email: "cloud-audit-smoke@agent.local",
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  await page.addInitScript(
    ({ key, value }) => {
      localStorage.setItem(key, value);
      localStorage.setItem("eliza:first-run-complete", "1");
      localStorage.setItem("eliza:setup:step", "activate");
      localStorage.setItem(
        "elizaos:active-server",
        JSON.stringify({
          id: "cloud:6f9619ff-8b86-4d01-b42d-00c04fc964ff",
          kind: "cloud",
          label: "Eliza Cloud",
          accessToken: "ui-smoke-agent-access-token",
        }),
      );
    },
    { key: STEWARD_TOKEN_KEY, value: token },
  );
}

// ── Cloud API stubs ──────────────────────────────────────────────────────────
// Installed per page; shapes traced from packages/ui/src/cloud/** data hooks
// (each rule cites its consumer). The goal is a real zero/populated render per
// page, not a mocked component: the page code, routing, auth gates, and design
// system all run for real. Anything unmatched falls through to the
// deterministic stub backend (501), and the page's rendered failure state is
// itself part of the audit.

const NOW_ISO = new Date().toISOString();
const FUTURE_ISO = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
/** ApplicationDetailPage requires a valid UUID id (redirects otherwise). */
export const SMOKE_APP_UUID = "6f9619ff-8b86-4d01-b42d-00c04fc964ff";

const SMOKE_APP = {
  id: SMOKE_APP_UUID,
  name: "Smoke App",
  slug: "smoke-app",
  description: "Deterministic ui-smoke application fixture",
  app_url: "https://smoke-app.example.com",
  logo_url: null,
  allowed_origins: ["https://smoke-app.example.com"],
  is_active: true,
  deployment_status: "READY",
  monetization_enabled: false,
  purchase_share_percent: null,
  metadata: {},
  total_users: 3,
  total_requests: 128,
  created_at: NOW_ISO,
  updated_at: NOW_ISO,
};

const SMOKE_USER = {
  id: "cloud-audit-smoke-user",
  email: "cloud-audit-smoke@agent.local",
  name: "Smoke Reviewer",
  role: "owner",
  organization_id: "org-smoke-1",
  wallet_address: null,
  work_function: null,
  preferences: {},
  email_notifications: true,
  response_notifications: false,
  is_active: true,
  created_at: NOW_ISO,
  updated_at: NOW_ISO,
  organization: {
    id: "org-smoke-1",
    name: "Smoke Org",
    slug: "smoke-org",
    billing_email: "billing@agent.local",
    credit_balance: "42.00",
    is_active: true,
    created_at: NOW_ISO,
    updated_at: NOW_ISO,
  },
};

const ANALYTICS_TIME_SERIES_POINT = {
  timestamp: NOW_ISO,
  totalRequests: 12,
  totalCost: 0.42,
  inputTokens: 5200,
  outputTokens: 1800,
  successRate: 1,
  successRatePercent: 100,
};

/** EnhancedAnalyticsDataDto (packages/cloud/shared/src/lib/types/cloud-api.ts). */
const ANALYTICS_BREAKDOWN = {
  filters: {
    startDate: NOW_ISO,
    endDate: NOW_ISO,
    granularity: "day",
    timeRange: "weekly",
  },
  overallStats: {
    totalRequests: 12,
    totalInputTokens: 5200,
    totalOutputTokens: 1800,
    totalCost: 0.42,
    // Fraction in [0, 1] — the stat card multiplies by 100 for display.
    successRate: 1,
  },
  timeSeriesData: [ANALYTICS_TIME_SERIES_POINT],
  userBreakdown: [],
  costTrending: {
    currentDailyBurn: 0.06,
    previousDailyBurn: 0.05,
    burnChangePercent: 20,
    projectedMonthlyBurn: 1.8,
    daysUntilBalanceZero: 700,
    monthlyBurnPercent: 4.3,
    monthlyBurnPercentClamped: 4.3,
    burnAlertThresholdExceeded: false,
  },
  organization: { creditBalance: "42.00" },
  providerBreakdown: [],
  modelBreakdown: [],
  trends: {
    requestsChange: 0,
    costChange: 0,
    tokensChange: 0,
    successRateChange: 0,
    period: "weekly",
  },
};

interface StubRule {
  /** Method to match (default GET). */
  method?: string;
  /** Pathname test, run against `new URL(request.url()).pathname`. */
  match: (pathname: string, search: URLSearchParams) => boolean;
  status?: number;
  headers?: Record<string, string>;
  body: unknown;
}

const path_ = (p: string) => (pathname: string) => pathname === p;
const prefix = (p: string) => (pathname: string) => pathname.startsWith(p);

// NOTE: table order matters — first match wins.
const STUB_RULES: StubRule[] = [
  // StewardProviderRuntime mirrors the seeded browser token into the server's
  // HttpOnly session cookie before protected Cloud routes render.
  {
    method: "POST",
    match: path_("/api/auth/steward-session"),
    body: { success: true },
  },
  // Normal app-shell hydration follows the selected managed agent's dedicated
  // origin. Keep that real request path deterministic while Cloud management
  // pages mount inside the shell.
  { match: path_("/api/conversations"), body: { conversations: [] } },
  {
    method: "POST",
    match: path_("/api/conversations"),
    body: {
      conversation: {
        id: "cloud-management-smoke-conversation",
        roomId: "cloud-management-smoke-room",
        title: "New Conversation",
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
      },
    },
  },
  {
    method: "POST",
    match: prefix(
      "/api/conversations/cloud-management-smoke-conversation/greeting",
    ),
    body: { text: "Hello from Eliza" },
  },
  {
    match: path_("/api/agent/events"),
    body: {
      events: [],
      latestEventId: null,
      totalBuffered: 0,
      replayed: true,
    },
  },
  {
    match: path_("/api/character"),
    body: {
      character: {
        name: "Eliza",
        bio: ["Cloud management smoke agent"],
        system: "You are Eliza",
        adjectives: ["helpful"],
        style: { all: [], chat: [], post: [] },
        postExamples: [],
        messageExamples: [],
      },
    },
  },
  {
    match: path_("/api/stream/settings"),
    body: { ok: true, settings: { theme: "dark", avatarIndex: 1 } },
  },
  {
    method: "POST",
    match: path_("/api/stream/settings"),
    body: { ok: true, settings: { theme: "dark", avatarIndex: 1 } },
  },
  {
    method: "POST",
    match: path_("/api/apps/overlay-presence"),
    body: { ok: true, app: null, present: false },
  },
  // instances/ — canonical agent-list DTO plus detail.
  {
    match: path_("/api/v1/eliza/agents"),
    body: {
      success: true,
      data: [
        {
          id: "agent-smoke-1",
          agentName: "Smoke Agent",
          status: "running",
          databaseStatus: "ready",
          lastBackupAt: null,
          lastHeartbeatAt: NOW_ISO,
          errorMessage: null,
          createdAt: NOW_ISO,
          updatedAt: NOW_ISO,
          token_address: null,
          token_chain: null,
          token_name: null,
          token_ticker: null,
          dockerImage: null,
          executionTier: "dedicated-lazy",
          webUiUrl: null,
        },
      ],
    },
  },
  {
    match: path_("/api/v1/eliza/agents/agent-smoke-1"),
    body: {
      success: true,
      data: {
        id: "agent-smoke-1",
        agentName: "Smoke Agent",
        status: "running",
        executionTier: "dedicated-lazy",
        databaseStatus: "ready",
        webUiUrl: null,
        bridgeUrl: null,
        errorMessage: null,
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
      },
    },
  },
  {
    match: path_("/api/v1/eliza/agents/agent-smoke-1/backups"),
    body: { success: true, data: [] },
  },
  {
    match: path_("/api/compat/agents/agent-smoke-1/logs"),
    body: { success: true, data: "" },
  },
  {
    method: "POST",
    match: path_("/api/views/cloud/elements"),
    body: { success: true },
  },
  // my-agents characters/saved lists.
  {
    match: path_("/api/my-agents/characters"),
    body: { success: true, data: { characters: [] } },
  },
  {
    match: path_("/api/my-agents/saved"),
    body: { success: true, data: { agents: [] } },
  },
  // account-security/ — user profile, sessions, MFA, audit, plugin grants.
  { match: path_("/api/v1/user"), body: { success: true, data: SMOKE_USER } },
  { match: path_("/api/v1/sessions"), body: { sessions: [] } },
  { match: path_("/api/v1/me/mfa"), body: { enrolled: false } },
  { match: path_("/api/v1/me/plugin-grants"), body: { grants: [] } },
  { match: prefix("/api/v1/security/audit"), body: { events: [] } },
  // organization/ — members/invites/credentials (owner role).
  {
    match: prefix("/api/organizations/"),
    body: { success: true, data: [] },
  },
  // analytics/ — envelopes are { success, data } (analytics-data.ts).
  {
    match: path_("/api/analytics/breakdown"),
    body: { success: true, data: ANALYTICS_BREAKDOWN },
  },
  {
    match: path_("/api/analytics/projections"),
    body: {
      success: true,
      data: {
        historicalData: [ANALYTICS_TIME_SERIES_POINT],
        projections: [],
        alerts: [],
        alertEvents: [],
        creditBalance: 42,
      },
    },
  },
  // billing/ — credits, settings, invoices, crypto (fail-soft), checkout.
  { match: path_("/api/v1/credits/balance"), body: { balance: 42 } },
  { match: path_("/api/credits/balance"), body: { balance: 42 } },
  {
    match: path_("/api/v1/billing/limits"),
    body: {
      success: true,
      data: {
        observedAt: NOW_ISO,
        cloudCharacters: {
          source: "cloud-character-quota",
          state: "available",
          used: 2,
          limit: 5,
        },
        agentSandboxes: {
          source: "agent-sandbox-quota",
          used: 3,
          nonEagerCreate: { state: "available", limit: 5 },
          eagerManagedCreate: { state: "available", limit: 100 },
          state: "available",
        },
        containers: {
          source: "container-quota",
          state: "available",
          used: 1,
          limit: 5,
        },
        apps: {
          source: "apps-service",
          state: "available",
          used: 4,
          limit: 25,
        },
        storage: {
          source: "org-storage-quota",
          state: "available",
          bytesUsed: "1073741824",
          bytesLimit: "5368709120",
        },
        inferenceRateLimits: {
          source: "org-rate-limits",
          state: "available",
          completionsRpm: 120,
          embeddingsRpm: 200,
        },
      },
    },
  },
  {
    // auto-top-up-card.tsx reads settings.autoTopUp.* + settings.limits.*;
    match: path_("/api/v1/billing/settings"),
    body: {
      settings: {
        autoTopUp: {
          enabled: false,
          amount: 10,
          threshold: 5,
          hasPaymentMethod: false,
        },
        limits: {
          minAmount: 5,
          maxAmount: 500,
          minThreshold: 1,
          maxThreshold: 100,
        },
        payAsYouGoFromEarnings: false,
      },
    },
  },
  { match: path_("/api/invoices/list"), body: { invoices: [] } },
  {
    // InvoiceDetailPage: GET /api/invoices/:id → camelCase InvoiceApiPayload
    // (billing/types.ts), adapted to the snake_case InvoiceDto by the hook.
    match: path_("/api/invoices/invoice-smoke-1"),
    body: {
      invoice: {
        id: "invoice-smoke-1",
        stripeInvoiceId: "in_smoke_1",
        stripeCustomerId: "cus_smoke_1",
        stripePaymentIntentId: null,
        amountDue: 1000,
        amountPaid: 1000,
        currency: "usd",
        status: "paid",
        invoiceType: "topup",
        invoiceNumber: "INV-0001",
        invoicePdf: null,
        hostedInvoiceUrl: null,
        creditsAdded: 10,
        metadata: {},
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        dueDate: null,
        paidAt: NOW_ISO,
      },
    },
  },
  { match: path_("/api/crypto/status"), body: { enabled: false } },
  // monetization/ — earnings balance/redemptions/status + affiliates.
  {
    match: path_("/api/v1/redemptions/balance"),
    body: {
      success: true,
      balance: {
        totalEarned: 12.5,
        availableBalance: 10,
        pendingBalance: 2.5,
        totalRedeemed: 0,
        totalPending: 0,
        totalConvertedToCredits: 0,
      },
      bySource: [{ source: "miniapp", totalEarned: 12.5, count: 3 }],
      recentEarnings: [
        {
          id: "earning-smoke-1",
          source: "miniapp",
          sourceId: SMOKE_APP_UUID,
          amount: 4.25,
          description: "Smoke App purchase share",
          createdAt: NOW_ISO,
        },
      ],
      limits: {
        minRedemptionUsd: 5,
        maxSingleRedemptionUsd: 500,
        userDailyLimitUsd: 1000,
        userHourlyLimitUsd: 250,
      },
      eligibility: { canRedeem: true, dailyLimitRemaining: 1_000 },
    },
  },
  {
    match: path_("/api/v1/redemptions/status"),
    body: {
      success: true,
      operational: true,
      canRedeem: true,
      message: "All payout networks are operational.",
      availableNetworks: ["base"],
      unavailableNetworks: [],
      networks: [
        {
          network: "base",
          available: true,
          status: "operational",
          balance: 100,
          balanceAvailable: true,
        },
      ],
      wallets: {
        evm: { configured: false },
        solana: { configured: false },
      },
      warnings: [],
      lastChecked: NOW_ISO,
    },
  },
  {
    match: path_("/api/v1/redemptions"),
    body: { success: true, redemptions: [], paused: false },
  },
  {
    match: path_("/api/v1/affiliates"),
    body: {
      code: {
        id: "aff-smoke-1",
        code: "SMOKE20",
        markup_percent: "20.00",
        is_active: true,
        created_at: NOW_ISO,
      },
    },
  },
  {
    match: path_("/api/v1/referrals"),
    body: { code: "SMOKE20", total_referrals: 0, is_active: true },
  },
  // api-explorer/
  { match: path_("/api/v1/api-keys/explorer"), body: { apiKey: null } },
  { match: path_("/api/v1/pricing/summary"), body: { pricing: {} } },
  // applications/
  { match: path_("/api/v1/apps"), body: { apps: [SMOKE_APP] } },
  {
    match: path_(`/api/v1/apps/${SMOKE_APP_UUID}`),
    body: { app: SMOKE_APP },
  },
  {
    // AuthorizeContent (app-auth/authorize) verifies the app via /public.
    match: path_("/api/v1/apps/app-smoke-1/public"),
    body: { app: { id: "app-smoke-1", name: "Smoke App", logo_url: null } },
  },
  {
    // Public payment page for an app charge (AppChargeDetails shape —
    // app-charge-page.tsx formats expiresAt/paidAt with Intl, so they must
    // be valid dates, and reads amountUsd/providers/paymentUrl).
    match: path_("/api/v1/apps/app-smoke-1/charges/charge-smoke-1"),
    body: {
      charge: {
        id: "charge-smoke-1",
        appId: "app-smoke-1",
        amountUsd: 5,
        description: "Smoke charge",
        providers: ["stripe"],
        paymentUrl: "https://example.com/pay/charge-smoke-1",
        status: "pending",
        paidAt: null,
        expiresAt: FUTURE_ISO,
        createdAt: NOW_ISO,
      },
      app: {
        id: "app-smoke-1",
        name: "Smoke App",
        description: "Deterministic ui-smoke application fixture",
        logo_url: null,
        website_url: null,
      },
    },
  },
  // approvals/ dashboard list + public approve/:id page.
  {
    match: path_("/api/v1/approval-requests/approval-smoke-1"),
    body: {
      success: true,
      approvalRequest: {
        id: "approval-smoke-1",
        organizationId: "org-smoke-1",
        agentId: "agent-smoke-1",
        userId: null,
        challengeKind: "signature",
        challengePayload: {
          message: "Approve the smoke-test sensitive action",
          signerKind: "wallet",
          walletAddress: "0x000000000000000000000000000000000000dEaD",
        },
        expectedSignerIdentityId: null,
        status: "pending",
        expiresAt: FUTURE_ISO,
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        metadata: null,
      },
    },
  },
  {
    match: prefix("/api/v1/approval-requests"),
    body: { success: true, approvalRequests: [] },
  },
  {
    match: prefix("/api/v1/ballots/ballot-smoke-1"),
    body: {
      success: true,
      ballot: {
        id: "ballot-smoke-1",
        organizationId: "org-smoke-1",
        purpose: "Rotate the smoke-test treasury key",
        threshold: 2,
        status: "open",
        participants: [
          { identityId: "identity-1", label: "Owner" },
          { identityId: "identity-2", label: "Operator" },
        ],
        expiresAt: FUTURE_ISO,
        createdAt: NOW_ISO,
      },
    },
  },
  { match: prefix("/api/v1/ballots"), body: { success: true, ballots: [] } },
  {
    match: path_("/api/v1/sensitive-requests/sensitive-smoke-1"),
    body: {
      id: "sensitive-smoke-1",
      kind: "secret",
      status: "pending",
      reason: "The agent needs an API key to finish connector setup.",
      expiresAt: FUTURE_ISO,
      form: {
        fields: [
          {
            name: "apiKey",
            label: "API key",
            input: "secret",
            required: true,
          },
        ],
        submitLabel: "Submit securely",
      },
    },
  },
  {
    match: path_("/api/v1/payment-requests/payreq-smoke-1"),
    body: {
      success: true,
      paymentRequest: {
        id: "payreq-smoke-1",
        provider: "stripe",
        amountCents: 500,
        currency: "usd",
        status: "pending",
        reason: "Smoke-test payment request",
        expiresAt: FUTURE_ISO,
        hostedUrl: "https://example.com/checkout/smoke",
      },
    },
  },
  // public-pages/ — character chat + invite validation.
  {
    match: path_("/api/characters/smoke-character/public"),
    body: {
      success: true,
      data: { id: "char-smoke-1", name: "Eliza Smoke", ref: "smoke-character" },
    },
  },
  {
    match: path_("/api/invites/validate"),
    body: {
      success: true,
      data: {
        organization_name: "Smoke Org",
        invited_email: "invitee@agent.local",
        role: "member",
        expires_at: FUTURE_ISO,
        inviter_name: "Smoke Owner",
      },
    },
  },
  // admin/ — HEAD gate + moderation views + redemptions + rpc status.
  {
    method: "HEAD",
    match: prefix("/api/v1/admin/moderation"),
    status: 204,
    headers: { "x-admin-role": "super_admin", "x-is-admin": "true" },
    body: "",
  },
  {
    match: prefix("/api/v1/admin/moderation"),
    body: {
      admins: { admins: [] },
      overview: {
        adminCount: 1,
        bannedUsers: 0,
        flaggedUsers: 0,
        totalViolations: 0,
      },
      users: { bannedUsers: [], flaggedUsers: [] },
      violations: { violations: [] },
    },
  },
  {
    match: prefix("/api/admin/redemptions"),
    body: { redemptions: [], stats: null },
  },
  {
    match: path_("/admin/rpc-status"),
    body: {
      success: true,
      data: {
        evm: [],
        solana: { rpcUrl: "", configured: false },
        allReachable: true,
        hotWalletAddress: null,
        checkedAt: NOW_ISO,
      },
    },
  },
  // mcps/
  { match: path_("/api/v1/mcps"), body: { mcps: [] } },
  {
    match: path_("/api/mcp/list"),
    body: { mcps: [], total: 0, categories: [] },
  },
  // connectors/ (dashboard/settings/connections) — hosted connector statuses.
  { match: path_("/api/v1/dashboard"), body: { agents: [] } },
  {
    match: prefix("/api/v1/oauth/connections"),
    body: { connections: [] },
  },
  { match: path_("/api/v1/discord/connections"), body: { connections: [] } },
  { match: path_("/api/v1/twilio/status"), body: { connected: false } },
  { match: path_("/api/v1/telegram/status"), body: { connected: false } },
  { match: path_("/api/v1/whatsapp/status"), body: { connected: false } },
  { match: path_("/api/v1/blooio/status"), body: { connected: false } },
];

export async function installCloudApiStubs(page: Page): Promise<void> {
  const handle = async (route: import("@playwright/test").Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const rule = STUB_RULES.find(
      (r) =>
        (r.method ?? "GET") === request.method() &&
        r.match(url.pathname, url.searchParams),
    );
    if (!rule) {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: rule.status ?? 200,
      contentType: "application/json",
      headers: rule.headers,
      body:
        typeof rule.body === "string" ? rule.body : JSON.stringify(rule.body),
    });
  };
  // Covers /api/v1/*, /api/analytics/*, /api/invoices/*, /api/credits/*,
  // /api/crypto/*, /api/mcp/*, /api/characters/*, /api/invites/*,
  // /api/admin/*, /api/my-agents/*, /api/organizations/* …
  await page.route("**/api/**", handle);
  // The admin RPC-status probe has no /api prefix (worker route /admin/rpc-status).
  await page.route("**/admin/rpc-status*", handle);
}
