import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { STEWARD_TOKEN_KEY } from "@elizaos/shared/steward-session-client";
import { expect, type Page, test } from "@playwright/test";
import {
  collectBlueColors,
  collectHoverViolations,
} from "./helpers/brand-color-scans";
import {
  analyzeScreenshot,
  type ScreenshotQuality,
  screenshotQualityIssues,
} from "./helpers/screenshot-quality";

/**
 * Cloud-surface aesthetic audit (#10725 / #11342) — the audit:app equivalent
 * for the app-hosted Eliza Cloud surfaces. `audit:app` walks the tab/view app
 * (builtin tabs + plugin views) but never enters the CloudRouterShell route
 * space, so the cloud surfaces registered in
 * `packages/ui/src/cloud/register-all.ts` shipped with no visual-audit loop.
 *
 * This walk visits EVERY registered cloud route (parametric routes get a
 * representative stubbed id) at desktop (1440×900) + mobile (390×844),
 * captures rest + primary-button-hover screenshots, scans for the #10725
 * brand rules (no blue anywhere; orange-resting buttons must not hover to
 * black/white/transparent), collects console errors, and writes a per-page
 * `manual-review/<slug>.md` verdict stub + `report.json` +
 * `contact-sheet.html` for the hand-review loop.
 *
 * Run via `bun run --cwd packages/app audit:cloud`. Requirements:
 *  - The renderer dist must be built with `VITE_PLAYWRIGHT_TEST_AUTH=true`
 *    (the audit:cloud script exports it so a stale-dist rebuild inlines it;
 *    with ELIZA_UI_SMOKE_SKIP_BUILD=1 you must have built it yourself). With
 *    the flag, normal Steward-gated routes authenticate from the persisted
 *    token this spec seeds, and app-auth/authorize uses its local test-auth
 *    adapter to render the signed-in consent state without the live Steward
 *    SDK provider.
 *  - Cloud APIs are stubbed per domain below so pages render real zero/served
 *    states instead of eternal skeletons; anything unstubbed falls through to
 *    the deterministic 501 stub backend, and the page's rendered failure
 *    state is itself audited.
 *
 * Verdict policy (subset of audit:app's — cloud pages don't mount the
 * floating chat overlay, so overlay checks don't apply): `broken` on console
 * error / blank render, `needs-work` on a blue-color or hover violation,
 * otherwise `needs-eyeball` until the committed manual review upgrades it.
 * Output dir: `aesthetic-audit-output-cloud/` (override: ELIZA_AUDIT_CLOUD_DIR).
 */

const TEST_AUTH_ENABLED =
  process.env.VITE_PLAYWRIGHT_TEST_AUTH === "true" ||
  process.env.NEXT_PUBLIC_PLAYWRIGHT_TEST_AUTH === "true";

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
] as const;

interface CloudAuditCase {
  slug: string;
  /** Concrete path (parametric segments filled with the stubbed sample ids). */
  path: string;
  /** The registered route pattern this case exercises. */
  route: string;
  /** Seed the persisted Steward token before boot (authed dashboard pages). */
  auth: boolean;
}

const AUTH = true;
const PUBLIC = false;

/**
 * Every route registered by `registerAllCloudSurfaces()` (register-all.test.ts
 * guards the wiring). Parametric routes use the sample ids the stub layer
 * below serves. The `coverage matches the registered cloud routes` test at the
 * bottom fails when this table drifts from the live registry.
 */
const CLOUD_AUDIT_CASES: CloudAuditCase[] = [
  // instances/
  {
    slug: "dashboard-agents",
    path: "/dashboard/agents",
    route: "dashboard/agents",
    auth: AUTH,
  },
  {
    slug: "dashboard-agents-detail",
    path: "/dashboard/agents/agent-smoke-1",
    route: "dashboard/agents/:id",
    auth: AUTH,
  },
  {
    slug: "dashboard-my-agents",
    path: "/dashboard/my-agents",
    route: "dashboard/my-agents",
    auth: AUTH,
  },
  // analytics/
  {
    slug: "dashboard-analytics",
    path: "/dashboard/analytics",
    route: "dashboard/analytics",
    auth: AUTH,
  },
  // billing/
  {
    slug: "dashboard-billing-success",
    path: "/dashboard/billing/success",
    route: "dashboard/billing/success",
    auth: AUTH,
  },
  {
    slug: "dashboard-invoice-detail",
    path: "/dashboard/invoices/invoice-smoke-1",
    route: "dashboard/invoices/:id",
    auth: AUTH,
  },
  // organization/
  {
    slug: "dashboard-organization",
    path: "/dashboard/organization",
    route: "dashboard/organization",
    auth: AUTH,
  },
  // join/ — signed-out /join redirects to /login (audited separately), so
  // audit the signed-in flow; agent provisioning POSTs fall through to the
  // stub backend's 501, landing on the designed "couldn't connect" error card.
  { slug: "join", path: "/join", route: "join", auth: AUTH },
  // public-pages/ — payment + approval + governance token pages
  {
    slug: "payment-request",
    path: "/payment/payreq-smoke-1",
    route: "payment/:paymentRequestId",
    auth: PUBLIC,
  },
  {
    slug: "payment-success",
    path: "/payment/success",
    route: "payment/success",
    auth: PUBLIC,
  },
  {
    slug: "payment-app-charge",
    path: "/payment/app-charge/app-smoke-1/charge-smoke-1",
    route: "payment/app-charge/:appId/:chargeId",
    auth: PUBLIC,
  },
  {
    slug: "approve-approval",
    path: "/approve/approval-smoke-1",
    route: "approve/:approvalId",
    auth: PUBLIC,
  },
  {
    slug: "ballot",
    path: "/ballot/ballot-smoke-1",
    route: "ballot/:ballotId",
    auth: PUBLIC,
  },
  {
    slug: "sensitive-request",
    path: "/sensitive-requests/sensitive-smoke-1",
    route: "sensitive-requests/:requestId",
    auth: PUBLIC,
  },
  {
    slug: "public-character-chat",
    path: "/chat/smoke-character",
    route: "chat/:characterRef",
    auth: PUBLIC,
  },
  // public-pages/ — invitations + auth
  {
    slug: "invite-accept",
    path: "/invite/accept?token=invite-smoke-token",
    route: "invite/accept",
    auth: PUBLIC,
  },
  {
    slug: "accept-invitation",
    path: "/accept-invitation?token=invite-smoke-token",
    route: "accept-invitation",
    auth: PUBLIC,
  },
  { slug: "login", path: "/login", route: "login", auth: PUBLIC },
  {
    slug: "auth-success",
    path: "/auth/success",
    route: "auth/success",
    auth: PUBLIC,
  },
  {
    slug: "auth-error",
    path: "/auth/error",
    route: "auth/error",
    auth: PUBLIC,
  },
  {
    slug: "auth-cli-login",
    path: "/auth/cli-login",
    route: "auth/cli-login",
    auth: PUBLIC,
  },
  {
    slug: "auth-callback-email",
    path: "/auth/callback/email?token=email-smoke-token",
    route: "auth/callback/email",
    auth: PUBLIC,
  },
  {
    slug: "app-auth-authorize",
    path: "/app-auth/authorize?app_id=app-smoke-1&redirect_uri=https%3A%2F%2Fexample.com%2Fcb",
    route: "app-auth/authorize",
    auth: AUTH,
  },
  // public-pages/ — legal + bsc
  {
    slug: "terms-of-service",
    path: "/terms-of-service",
    route: "terms-of-service",
    auth: PUBLIC,
  },
  {
    slug: "privacy-policy",
    path: "/privacy-policy",
    route: "privacy-policy",
    auth: PUBLIC,
  },
  { slug: "bsc", path: "/bsc", route: "bsc", auth: PUBLIC },
  // api-explorer/
  {
    slug: "dashboard-api-explorer",
    path: "/dashboard/api-explorer",
    route: "dashboard/api-explorer",
    auth: AUTH,
  },
  // applications/
  {
    slug: "dashboard-apps",
    path: "/dashboard/apps",
    route: "dashboard/apps",
    auth: AUTH,
  },
  {
    // ApplicationDetailPage redirects unless :id is a valid UUID.
    slug: "dashboard-apps-detail",
    path: "/dashboard/apps/6f9619ff-8b86-4d01-b42d-00c04fc964ff",
    route: "dashboard/apps/:id",
    auth: AUTH,
  },
  // approvals/
  {
    slug: "dashboard-approvals",
    path: "/dashboard/approvals",
    route: "dashboard/approvals",
    auth: AUTH,
  },
  // admin/
  {
    slug: "dashboard-admin",
    path: "/dashboard/admin",
    route: "dashboard/admin",
    auth: AUTH,
  },
  {
    slug: "dashboard-admin-redemptions",
    path: "/dashboard/admin/redemptions",
    route: "dashboard/admin/redemptions",
    auth: AUTH,
  },
  {
    slug: "dashboard-admin-rpc-status",
    path: "/dashboard/admin/rpc-status",
    route: "dashboard/admin/rpc-status",
    auth: AUTH,
  },
  // mcps/
  {
    slug: "dashboard-mcps",
    path: "/dashboard/mcps",
    route: "dashboard/mcps",
    auth: AUTH,
  },
];

function makeJwt(payload: Record<string, unknown>): string {
  const encode = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode(payload)}.sig`;
}

async function seedStewardToken(page: Page): Promise<void> {
  const token = makeJwt({
    sub: "cloud-audit-smoke-user",
    email: "cloud-audit-smoke@agent.local",
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  await page.addInitScript(
    ({ key, value }) => {
      localStorage.setItem(key, value);
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
const SMOKE_APP_UUID = "6f9619ff-8b86-4d01-b42d-00c04fc964ff";

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
  // instances/ — sandbox agents list + detail (use-sandbox-status-poll.ts,
  // AgentsPage/AgentDetailPage read `json.data`).
  {
    match: path_("/api/v1/eliza/agents"),
    body: {
      success: true,
      data: [
        {
          id: "agent-smoke-1",
          agentName: "Smoke Agent",
          agent_name: "Smoke Agent",
          status: "running",
          executionTier: "standard",
          createdAt: NOW_ISO,
          created_at: NOW_ISO,
          updatedAt: NOW_ISO,
          lastActiveAt: NOW_ISO,
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
        agent_name: "Smoke Agent",
        status: "running",
        executionTier: "standard",
        databaseStatus: "ready",
        webUiUrl: null,
        bridgeUrl: null,
        errorMessage: null,
        createdAt: NOW_ISO,
        created_at: NOW_ISO,
        updatedAt: NOW_ISO,
        lastActiveAt: NOW_ISO,
      },
    },
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
    // auto-top-up-card.tsx reads settings.autoTopUp.* + settings.limits.*;
    // pay-as-you-go-card.tsx reads settings.payAsYouGoFromEarnings.
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
      eligibility: { canRedeem: true },
    },
  },
  {
    match: path_("/api/v1/redemptions/status"),
    body: {
      operational: true,
      networks: { base: { available: true } },
      wallets: {
        evm: { configured: false },
        solana: { configured: false },
      },
    },
  },
  { match: path_("/api/v1/redemptions"), body: { redemptions: [] } },
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
        organizationId: "org-smoke-1",
        agentId: "agent-smoke-1",
        provider: "stripe",
        amountCents: 500,
        currency: "usd",
        paymentContext: {},
        status: "pending",
        reason: "Smoke-test payment request",
        expiresAt: FUTURE_ISO,
        callbackUrl: null,
        payerIdentityId: null,
        settlementTxRef: null,
        metadata: null,
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
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

async function installCloudApiStubs(page: Page): Promise<void> {
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

// ── Findings ─────────────────────────────────────────────────────────────────

type CloudVerdict = "good" | "needs-work" | "needs-eyeball" | "broken";

interface CloudPageFinding {
  slug: string;
  viewport: string;
  path: string;
  route: string;
  consoleErrors: string[];
  blueColors: string[];
  hoverViolations: string[];
  hoverFailures: string[];
  readableChars: number;
  quality: ScreenshotQuality | null;
  qualityIssues: string[];
  verdict: CloudVerdict;
}

function computeCloudVerdict(
  finding: Omit<CloudPageFinding, "verdict">,
): CloudVerdict {
  if (
    finding.consoleErrors.length > 0 ||
    finding.qualityIssues.length > 0 ||
    finding.readableChars < 10
  ) {
    return "broken";
  }
  if (finding.blueColors.length > 0 || finding.hoverViolations.length > 0) {
    return "needs-work";
  }
  return "needs-eyeball";
}

function renderManualReviewStub(findings: CloudPageFinding[]): string {
  const [first] = findings;
  const lines = [
    `# ${first.slug}`,
    "",
    `- **route:** \`${first.route}\``,
    `- **path:** \`${first.path}\``,
    "",
  ];
  for (const f of findings) {
    lines.push(
      `## ${f.viewport}`,
      "",
      `- **verdict:** ${f.verdict}`,
      `- **console errors:** ${f.consoleErrors.length ? f.consoleErrors.join("; ") : "none"}`,
      `- **blue colors (banned):** ${f.blueColors.length ? f.blueColors.join(", ") : "none"}`,
      `- **orange hover violations:** ${f.hoverViolations.length ? f.hoverViolations.join("; ") : "none"}`,
      `- **hover probe failures:** ${f.hoverFailures.length ? f.hoverFailures.join("; ") : "none"}`,
      `- **readable content chars:** ${f.readableChars}`,
      `- **screenshot quality issues:** ${f.qualityIssues.length ? f.qualityIssues.join("; ") : "none"}`,
      "",
    );
  }
  lines.push(
    "## Hand review",
    "",
    "_Fill in: rendered state, visual issues, layout breaks, color/hover notes._",
    "_Set the per-viewport verdicts above to one of `good` · `needs-work` ·_",
    "_`needs-eyeball` · `broken` after opening the screenshots._",
    "",
  );
  return lines.join("\n");
}

const findings: CloudPageFinding[] = [];
const findingsBySlug = new Map<string, CloudPageFinding[]>();

test.describe("cloud-surfaces aesthetic audit (#10725/#11342)", () => {
  test.skip(
    !TEST_AUTH_ENABLED,
    "set VITE_PLAYWRIGHT_TEST_AUTH=true (bake it into the renderer build) so StewardProvider renders the local test-auth shell",
  );

  const outputDir =
    process.env.ELIZA_AUDIT_CLOUD_DIR ??
    path.join(process.cwd(), "aesthetic-audit-output-cloud");

  // Coverage guard: every registered cloud route must appear in the audit
  // table, so a newly-registered surface fails the audit until it is walked.
  // The registry is read from the RUNNING production bundle (the same
  // Symbol.for-keyed global store cloud-route-registry.ts uses) — importing
  // the domain tree under node breaks on extensionless ESM subpath imports
  // (react-syntax-highlighter prism styles).
  test("coverage matches the registered cloud routes", async ({ page }) => {
    await seedStewardToken(page);
    await installCloudApiStubs(page);
    await page.goto("/login", { waitUntil: "domcontentloaded" });
    const readRegistryPaths = () =>
      page.evaluate(() => {
        const store = (globalThis as unknown as Record<symbol, unknown>)[
          Symbol.for("elizaos.ui.cloud-route-registry")
        ] as { entries: Map<string, unknown> } | undefined;
        return store ? [...store.entries.keys()] : [];
      });
    await expect
      .poll(async () => (await readRegistryPaths()).length, {
        message: "cloud-route registry populated by the running shell",
        timeout: 30_000,
      })
      .toBeGreaterThan(0);
    const registered = new Set(await readRegistryPaths());
    const audited = new Set(CLOUD_AUDIT_CASES.map((c) => c.route));
    const unaudited = [...registered].filter((p) => !audited.has(p));
    expect(
      unaudited,
      `registered cloud routes missing from the audit table: ${unaudited.join(", ")}`,
    ).toEqual([]);
    const phantom = [...audited].filter((p) => !registered.has(p));
    expect(
      phantom,
      `audit table routes that are no longer registered: ${phantom.join(", ")}`,
    ).toEqual([]);
  });

  for (const auditCase of CLOUD_AUDIT_CASES) {
    for (const vp of VIEWPORTS) {
      test(`${auditCase.slug} ${vp.name}`, async ({ page }) => {
        const reviewDir = path.join(outputDir, "manual-review");
        const shotDir = path.join(outputDir, vp.name);
        await mkdir(reviewDir, { recursive: true });
        await mkdir(shotDir, { recursive: true });

        const consoleErrors: string[] = [];
        const pageErrors: string[] = [];
        page.on("pageerror", (e) => pageErrors.push(e.message));
        page.on("console", (msg) => {
          if (msg.type() !== "error") return;
          const text = msg.text();
          // The deterministic stub backend answers unstubbed routes with
          // 501/404; those network console errors are expected in this harness
          // (same policy as all-views-aesthetic-audit) — only real,
          // non-network console errors count.
          if (
            /\b50[124]\b|\b40[134]\b|failed to (load|fetch)|net::err|networkerror|status (of )?(40|50)\d|err_/i.test(
              text,
            )
          ) {
            return;
          }
          consoleErrors.push(text);
        });

        await page.setViewportSize({ width: vp.width, height: vp.height });
        if (auditCase.auth) {
          await seedStewardToken(page);
        }
        await installCloudApiStubs(page);
        await page.goto(auditCase.path, { waitUntil: "domcontentloaded" });

        // Wait for the page to actually paint text (lazy route chunk +
        // react-query settle). Non-fatal: a page that never paints is recorded
        // as a `broken` finding, not a walk abort.
        const readPaint = async (): Promise<number> =>
          page
            .evaluate(
              () => document.body.innerText.trim().replace(/\s+/g, " ").length,
            )
            .catch(() => 0);
        let readableChars = await readPaint();
        for (
          let attempt = 0;
          attempt < 15 && readableChars < 10;
          attempt += 1
        ) {
          await page.waitForTimeout(1000);
          readableChars = await readPaint();
        }
        // Let late skeleton → content transitions settle before sampling.
        await page.waitForTimeout(750);
        readableChars = await readPaint();

        const restPath = path.join(shotDir, `${auditCase.slug}.png`);
        let buffer = await page.screenshot({ path: restPath, fullPage: false });
        let quality = await analyzeScreenshot(buffer).catch(() => null);
        for (
          let attempt = 0;
          attempt < 3 && quality && quality.colorBuckets <= 1;
          attempt += 1
        ) {
          await page.waitForTimeout(800);
          buffer = await page.screenshot({ path: restPath, fullPage: false });
          quality = await analyzeScreenshot(buffer).catch(() => null);
        }
        const qualityIssues = quality
          ? screenshotQualityIssues(`${auditCase.slug} ${vp.name}`, quality)
          : [];

        const blueColors = await collectBlueColors(page).catch(() => []);
        const { violations: hoverViolations, hoverFailures } =
          await collectHoverViolations(page).catch((error: unknown) => ({
            violations: [],
            hoverFailures: [
              `hover scan failed: ${(error instanceof Error ? error.message : String(error)).split("\n")[0].slice(0, 120)}`,
            ],
          }));

        // Primary-button hover screenshot (the #10725 hover-rule artifact):
        // hover the first visible enabled button and capture the state.
        const hoverTarget = page
          .locator("button:visible, a[role='button']:visible")
          .first();
        if (await hoverTarget.isVisible().catch(() => false)) {
          const hovered = await hoverTarget
            .hover({ timeout: 2000 })
            .then(() => true)
            .catch(() => false);
          if (hovered) {
            await page.screenshot({
              path: path.join(shotDir, `${auditCase.slug}--hover.png`),
              fullPage: false,
            });
          }
        }

        const base = {
          slug: auditCase.slug,
          viewport: vp.name,
          path: auditCase.path,
          route: auditCase.route,
          // Uncaught page errors are the hardest crash signal — surface them
          // in the finding alongside console errors.
          consoleErrors: [
            ...pageErrors.map((message) => `pageerror: ${message}`),
            ...consoleErrors,
          ],
          blueColors,
          hoverViolations,
          hoverFailures,
          readableChars,
          quality,
          qualityIssues,
        };
        const finding: CloudPageFinding = {
          ...base,
          verdict: computeCloudVerdict(base),
        };
        findings.push(finding);
        const perSlug = findingsBySlug.get(auditCase.slug) ?? [];
        perSlug.push(finding);
        findingsBySlug.set(auditCase.slug, perSlug);
        await writeFile(
          path.join(reviewDir, `${auditCase.slug}.md`),
          renderManualReviewStub(perSlug),
          "utf8",
        );

        // Only a real crash fails the walk; design findings live in the report.
        expect(
          pageErrors,
          `${auditCase.slug} ${vp.name} must not throw an uncaught page error`,
        ).toEqual([]);
      });
    }
  }

  test.afterAll(async () => {
    if (findings.length === 0) return;
    await mkdir(outputDir, { recursive: true });
    await writeFile(
      path.join(outputDir, "report.json"),
      JSON.stringify(findings, null, 2),
      "utf8",
    );
    const rows = findings
      .map(
        (f) =>
          `<tr><td>${f.slug}</td><td>${f.viewport}</td><td>${f.verdict}</td>` +
          `<td>${f.consoleErrors.length}</td><td>${f.blueColors.length}</td>` +
          `<td>${f.hoverViolations.length}${f.hoverFailures.length ? ` (+${f.hoverFailures.length} probe-failed)` : ""}</td>` +
          `<td>${f.readableChars}</td>` +
          `<td><a href="${f.viewport}/${f.slug}.png">rest</a> <a href="${f.viewport}/${f.slug}--hover.png">hover</a></td></tr>`,
      )
      .join("\n");
    await writeFile(
      path.join(outputDir, "contact-sheet.html"),
      `<!doctype html><meta charset="utf-8"><title>cloud aesthetic audit</title>` +
        `<table border="1" cellpadding="6"><tr><th>page</th><th>viewport</th>` +
        `<th>verdict</th><th>console</th><th>blue</th><th>hover</th>` +
        `<th>chars</th><th>shots</th></tr>${rows}</table>`,
      "utf8",
    );
    const broken = findings.filter((f) => f.verdict === "broken");
    const needsWork = findings.filter((f) => f.verdict === "needs-work");
    console.log(
      `[cloud-aesthetic-audit] ${findings.length} findings — ` +
        `broken=${broken.length} needs-work=${needsWork.length} ` +
        `needs-eyeball=${findings.filter((f) => f.verdict === "needs-eyeball").length} ` +
        `good=${findings.filter((f) => f.verdict === "good").length}`,
    );
  });
});
