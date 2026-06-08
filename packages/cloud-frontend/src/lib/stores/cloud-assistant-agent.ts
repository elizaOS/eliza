import type { UiSpec } from "@elizaos/shared/config/ui-spec";
import { api } from "@/lib/api-client";
import type { CanvasMessage } from "./canvas-store";

interface AgentResult {
  text: string;
  spec: UiSpec | null;
}

// ── Mist — The Cloud Ego of Eliza ─────────────────────────────────
//
// Mist is the base agent persona for Eliza Cloud. She is warm, proactive,
// technically sharp, and adapts her tone from deeply technical explanations
// to gentle hand-holding for complete beginners. She never says "I don't know"
// without offering a next step. She detects broken configs, missing API keys,
// credit exhaustion, and plugin failures — and surfaces them before the user
// even asks.

const MIST_NAME = "Mist";

const MIST_SYSTEM_PROMPT = `You are Mist, the cloud assistant for Eliza Cloud — the managed platform for deploying autonomous AI agents.

Personality:
- You are warm, precise, and proactive. You speak like a brilliant engineer friend, not a corporate chatbot.
- You adapt your language: deeply technical for developers, gentle and clear for beginners.
- You never leave the user hanging. Every response ends with a concrete next step or suggestion.
- When things are broken, you say so directly and offer the fix — no sugar-coating, no vague "try again later."
- You have a dry wit. You're charming but never condescending.
- You are the "cloud ego" of Eliza — you know the platform inside and out.

Capabilities you can help with:
- Managing agents: creating, deploying, starting, stopping, configuring characters
- API keys: generating, revoking, managing provider secrets (OpenAI, Anthropic, etc.)
- Billing & credits: checking balance, topping up, viewing transactions and invoices
- Connectors: wiring agents to Discord, Telegram, Twitter, Slack
- Containers: deploying Docker workloads alongside agents
- MCP Servers: extending agents with Model Context Protocol tool servers
- Plugins: browsing and managing hosted plugins
- Security: MFA, audit logs, sessions, privacy controls
- Analytics: usage stats, cost breakdowns, projections
- Domains: custom domains, SSL, DNS verification
- Remote pairing: syncing with mobile/desktop apps via ElectricSQL

When you detect issues (config errors, missing secrets, credit exhaustion), proactively flag them.
When users are confused or lost, assess their cloud state and give them the single most impactful next step.
Keep responses concise but complete. Use markdown formatting sparingly — bold for emphasis, code blocks for keys/commands.`;

// ── Proactive issue detection ─────────────────────────────────────

interface DiagnosticIssue {
  severity: "critical" | "warning" | "info";
  area: string;
  message: string;
  fix: string;
  action?: string;
}

function detectIssues(state: CloudAssessment): DiagnosticIssue[] {
  const issues: DiagnosticIssue[] = [];

  // Critical: No credits
  if (state.billing.balance <= 0) {
    issues.push({
      severity: "critical",
      area: "Billing",
      message:
        "Your credit balance is $0. Agents and containers cannot run without credits.",
      fix: "Add credits to your account to resume operations.",
      action: "cloud.billing.topup",
    });
  } else if (state.billing.balance < 5) {
    issues.push({
      severity: "warning",
      area: "Billing",
      message: `Your credit balance is low (${fmtCredits(state.billing.balance)}). Services may be interrupted soon.`,
      fix: "Top up your credits to avoid service disruption.",
      action: "cloud.billing.topup",
    });
  }

  // Critical: Agents in error state
  const errorAgents = state.agents.filter(
    (a) => a.status === "error" || a.errorMessage,
  );
  for (const agent of errorAgents) {
    issues.push({
      severity: "critical",
      area: "Agents",
      message: `Agent "${agent.agentName}" is in error state${agent.errorMessage ? `: ${agent.errorMessage}` : "."}`,
      fix: "Check the agent logs for details, or try redeploying.",
      action: "cloud.agent.refresh",
    });
  }

  // Warning: All agents stopped
  const stoppedAgents = state.agents.filter((a) =>
    ["stopped", "disconnected"].includes(a.status),
  );
  if (state.agents.length > 0 && stoppedAgents.length === state.agents.length) {
    issues.push({
      severity: "warning",
      area: "Agents",
      message: "All your agents are stopped. None are currently running.",
      fix: "Resume at least one agent to get back online.",
      action: "cloud.agent.refresh",
    });
  }

  // Warning: No API keys but has agents
  const activeKeys = (Array.isArray(state.apiKeys) ? state.apiKeys : []).filter(
    (k) => k.is_active,
  );
  if (state.agents.length > 0 && activeKeys.length === 0) {
    issues.push({
      severity: "warning",
      area: "API Keys",
      message:
        "You have agents deployed but no active API keys. External apps and services can't reach your agents.",
      fix: "Generate an API key to enable programmatic access.",
      action: "cloud.apikey.create",
    });
  }

  // Warning: No connectors
  const anyConnected = Object.values(state.connectorStatuses).some(
    (v) => v.connected,
  );
  if (state.agents.length > 0 && !anyConnected) {
    issues.push({
      severity: "info",
      area: "Connectors",
      message:
        "No platforms connected. Your agents are running but not reachable via Discord, Telegram, or Twitter.",
      fix: "Connect at least one platform so users can interact with your agents.",
      action: "cloud.connectors.list",
    });
  }

  // Sort: critical first, then warning, then info
  const severityOrder = { critical: 0, warning: 1, info: 2 };
  issues.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  return issues;
}

// ── Auth context ──────────────────────────────────────────────────

interface AgentContext {
  isAuthenticated: boolean;
  isAdmin: boolean;
  adminRole: string | null;
  userId?: string;
  userEmail?: string;
}

async function detectAuthContext(): Promise<AgentContext> {
  try {
    const user = await api<{ id: string; email?: string }>("/api/v1/user");
    const ctx: AgentContext = {
      isAuthenticated: true,
      isAdmin: false,
      adminRole: null,
      userId: user.id,
      userEmail: user.email,
    };
    try {
      const adminRes = await fetch("/api/v1/admin/moderation", {
        method: "HEAD",
        credentials: "include",
      });
      if (adminRes.ok) {
        ctx.isAdmin = adminRes.headers.get("X-Is-Admin") === "true";
        const role = adminRes.headers.get("X-Admin-Role");
        if (role && ["super_admin", "moderator", "viewer"].includes(role)) {
          ctx.adminRole = role;
        }
      }
    } catch {
      // non-admin is fine
    }
    return ctx;
  } catch {
    return { isAuthenticated: false, isAdmin: false, adminRole: null };
  }
}

// ── Helpers ────────────────────────────────────────────────────────

function idShort(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

function fmtCredits(n: number): string {
  return n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`;
}

function statusVariant(
  status: string,
): "success" | "warning" | "error" | "info" {
  const s = status.toLowerCase();
  if (s === "running" || s === "active" || s === "ready" || s === "deployed")
    return "success";
  if (
    s === "pending" ||
    s === "provisioning" ||
    s === "building" ||
    s === "deploying"
  )
    return "warning";
  if (s === "stopped" || s === "error" || s === "failed") return "error";
  return "info";
}

// ── Intent parsing ────────────────────────────────────────────────

type Intent =
  | { type: "listAgents" }
  | { type: "agentDetail" }
  | { type: "createAgent" }
  | { type: "provisionAgent" }
  | { type: "getBilling" }
  | { type: "transactions" }
  | { type: "topUp" }
  | { type: "invoices" }
  | { type: "listApiKeys" }
  | { type: "createApiKey" }
  | { type: "listApps" }
  | { type: "appDetail" }
  | { type: "analytics" }
  | { type: "projections" }
  | { type: "health" }
  | { type: "profile" }
  | { type: "organizations" }
  | { type: "security" }
  | { type: "auditLog" }
  | { type: "sessions" }
  | { type: "privacy" }
  | { type: "connectors" }
  | { type: "mcps" }
  | { type: "plugins" }
  | { type: "apiExplorer" }
  | { type: "adminOverview" }
  | { type: "adminUsers" }
  | { type: "adminRedemptions" }
  | { type: "adminMetrics" }
  | { type: "adminInfrastructure" }
  | { type: "adminRpc" }
  | { type: "securityPermissions" }
  | { type: "documents" }
  | { type: "giveSuggestion" }
  | { type: "containers" }
  | { type: "domains" }
  | { type: "remotePairing" }
  | { type: "earnings" }
  | { type: "redeemRewards" }
  | { type: "confused" }
  | { type: "frustrated" }
  | { type: "identity" }
  | { type: "whatNow" }
  | { type: "diagnose" }
  | { type: "unknown"; text: string };

function parseIntent(text: string): Intent {
  const lower = text.toLowerCase();

  // Agents
  if (
    /^show\s+(an?\s+)?agent\b/.test(lower) ||
    /\b(agent\s+detail|agent\s+status|check\s+(on\s+)?(my\s+)?agent)\b/.test(
      lower,
    ) ||
    /(?:show|get|view)\s+(the\s+)?agent\s+(\S+)/.test(lower)
  ) {
    return { type: "agentDetail" };
  }
  if (
    /\b(provision|deploy|start|launch)\s+(a\s+|an\s+|my\s+|the\s+)?(agent|character)\b/.test(
      lower,
    ) ||
    /\b(deploy|provision).*(agent|instance)\b/.test(lower)
  ) {
    return { type: "provisionAgent" };
  }
  if (
    /\b(create|new|make|spawn)\s+(a\s+|an\s+|my\s+)?(agent|character)\b/.test(
      lower,
    )
  ) {
    return { type: "createAgent" };
  }
  if (
    /(show|list|my|all|view).*(agent|character)s?/i.test(lower) ||
    (/(agent|character)s?/i.test(lower) &&
      /(show|list|my|all|get|view)/i.test(lower)) ||
    /^(what|which)\s+(agents|characters|bots)\s+(do|have)/i.test(lower)
  ) {
    return { type: "listAgents" };
  }

  // Billing
  if (/(invoice|receipt)s?/i.test(lower)) return { type: "invoices" };
  if (/(transaction|usage|recent activity|spend)/i.test(lower))
    return { type: "transactions" };
  if (/(add|buy|purchase|get|top.?up)\s+(credits|credit)/i.test(lower))
    return { type: "topUp" };
  if (/(billing|credits|balance|credit)/i.test(lower))
    return { type: "getBilling" };

  // API keys
  if (/\bcreate\s+(an?\s+)?(api.?key|key|token)\b/i.test(lower))
    return { type: "createApiKey" };
  if (
    /(api.?key|key|token)s?/i.test(lower) &&
    /(show|list|my|get|check|view)/i.test(lower)
  )
    return { type: "listApiKeys" };

  // Apps
  if (
    /(show|view|check|open)\s+(the\s+)?app\b\s*(\S+)?/.test(lower) ||
    /\b(app\s+detail|app\s+status)\b/.test(lower)
  )
    return { type: "appDetail" };
  if (
    /(app|application)s?/i.test(lower) &&
    /(show|list|my|all|deploy|view|created|hosted)/i.test(lower)
  )
    return { type: "listApps" };

  // Earnings & Payouts
  if (
    /(redeem\s+(my\s+)?(reward|credit|earning|proceed)s?|withdraw\s+(my\s+)?(reward|credit|earning|proceed)s?|can\s+i\s+(redeem|withdraw|cash\s*out)|cash\s*out)/i.test(
      lower,
    )
  ) {
    return { type: "redeemRewards" };
  }
  if (/(revenue|proceeds|earning|rewards)/i.test(lower)) {
    return { type: "earnings" };
  }

  // Containers
  if (
    /(container|docker|image|hetzner|node.?pool)/i.test(lower) &&
    /(show|list|my|all|deploy|view|get|quota)/i.test(lower)
  )
    return { type: "containers" };
  if (
    /\b(deploy|run|launch)\s+(a\s+|an\s+|my\s+)?(container|docker|image)\b/i.test(
      lower,
    )
  )
    return { type: "containers" };

  // Domains
  if (
    /(domain|dns|ssl|certificate|custom.?domain)/i.test(lower) &&
    /(show|list|my|all|add|view|get|register|verify)/i.test(lower)
  )
    return { type: "domains" };

  // Remote pairing / device sync
  if (
    /(pair|pairing|remote|sync|electric.?sql|connect|link)/i.test(lower) &&
    /(device|phone|mobile|desktop|session|code|my|qr|qrcode|app|agent)/i.test(
      lower,
    )
  )
    return { type: "remotePairing" };

  // Analytics + health
  if (/(health|status|monitoring|uptime|heartbeat)/i.test(lower))
    return { type: "health" };
  if (/(analytics|usage stats|cost|spending)/i.test(lower))
    return { type: "analytics" };
  if (/(projection|forecast|predict)/i.test(lower))
    return { type: "projections" };

  // Profile
  if (/(my\s+)?(profile|account|settings)\s*(info|details)?$/i.test(lower))
    return { type: "profile" };
  if (/(team|organization|org|members)\b/i.test(lower))
    return { type: "organizations" };

  // Security
  if (/(permission|grant|access.?level|revoke.?grant)/i.test(lower))
    return { type: "securityPermissions" };
  if (/(security|mfa|two.?factor|2fa|totp)/i.test(lower))
    return { type: "security" };
  if (
    /(audit|audit.?log|access.?log|history)/i.test(lower) &&
    /(show|list|view|check)/i.test(lower)
  )
    return { type: "auditLog" };
  if (/(session|active.?session|logged.?in|device)/i.test(lower))
    return { type: "sessions" };
  if (/(privacy|export|delete.?account|data|gdpr)/i.test(lower))
    return { type: "privacy" };

  // Documents / Knowledge
  if (/(document|file|knowledge|upload|vector)/i.test(lower))
    return { type: "documents" };

  // Connectors / Integrations
  if (
    /(connector|integration|telegram|discord|whatsapp|twilio|bloo\.?io)/i.test(
      lower,
    )
  )
    return { type: "connectors" };

  // MCPs
  if (/(mcp|model.?context.?protocol|server)/i.test(lower))
    return { type: "mcps" };

  // Plugins
  if (
    /(plugin|hosted.?plugin|managed.?plugin|extension)/i.test(lower) ||
    (/plugin/i.test(lower) && /(show|list|my|manage)/i.test(lower))
  )
    return { type: "plugins" };

  // API explorer
  if (
    /(api.?explorer|api.?tester|api.?view|endpoint.?test|try.?api)/i.test(
      lower,
    ) ||
    (/api/i.test(lower) && /(test|explore|try|view|check)/i.test(lower))
  )
    return { type: "apiExplorer" };

  // Admin
  if (/(admin.*)?(infrastructure|infra|warm.?pool|node.?pool)/i.test(lower))
    return { type: "adminInfrastructure" };
  if (/(admin.*)?(rpc|rpc.?status|wallet.?status)/i.test(lower))
    return { type: "adminRpc" };
  if (
    /admin.*(dashboard|overview|home|panel)/i.test(lower) ||
    /platform.*(overview|stats|status)/i.test(lower)
  )
    return { type: "adminOverview" };
  if (
    /admin.*(user|member|people|customer)s?/i.test(lower) ||
    /(manage|list|show).*(user|member|people)s?/i.test(lower)
  )
    return { type: "adminUsers" };
  if (/(admin.*)?(redemption|coupon|promo)/i.test(lower))
    return { type: "adminRedemptions" };
  if (/(admin.*)?(metric|kpi|retention|signup|growth)/i.test(lower))
    return { type: "adminMetrics" };

  // Help
  if (/(suggest|idea|feature|improve|feedback|roadmap)/i.test(lower))
    return { type: "giveSuggestion" };

  // ── Mist emotional / conversational intents ──────────────────────

  // Confused / lost user
  if (
    /(confused|lost|no idea|don'?t understand|don'?t get it|overwhelm|what is this|how does this work|wtf|wth|huh\??)/i.test(
      lower,
    ) ||
    /^(i'?m\s+(so\s+)?(confused|lost))/i.test(lower)
  ) {
    return { type: "confused" };
  }

  // Frustrated user
  if (
    /(not working|broken|nothing works|ugh|ffs|why (isn'?t|won'?t|doesn'?t|can'?t)|this (sucks|is broken)|frustrated|annoyed|angry|stuck)/i.test(
      lower,
    )
  ) {
    return { type: "frustrated" };
  }

  // Identity — "who are you", "what's your name", "are you eliza"
  if (
    /(who are you|what('?s| is) your name|are you (an? )?(ai|bot|agent|eliza|mist)|tell me about yourself|what are you)/i.test(
      lower,
    )
  ) {
    return { type: "identity" };
  }

  // "What do I do now" / "what's next" / "now what"
  if (
    /(what (do|should|can) i do( now)?|what('?s| is) next|now what|where do i start|what next|next step)/i.test(
      lower,
    )
  ) {
    return { type: "whatNow" };
  }

  // Explicit diagnostic request
  if (
    /(diagnos|check.*(config|setup|everything)|what('?s| is) wrong|any (issue|problem|error)|fix.*(config|setup)|troubleshoot)/i.test(
      lower,
    )
  ) {
    return { type: "diagnose" };
  }

  return { type: "unknown", text };
}

// ── API calls ──────────────────────────────────────────────────────

async function fetchAgents() {
  const res = await api<{
    data: Array<{
      id: string;
      agentName: string;
      status: string;
      databaseStatus?: string;
      lastHeartbeatAt?: string;
      errorMessage?: string;
      webUiUrl?: string;
      executionTier?: string;
      createdAt?: string;
    }>;
  }>("/api/v1/eliza/agents");
  return res.data ?? [];
}

async function fetchAgentDetail(agentId: string) {
  const res = await api<{
    data: {
      id: string;
      agentName: string;
      status: string;
      databaseStatus?: string;
      lastHeartbeatAt?: string;
      errorMessage?: string;
      webUiUrl?: string;
      walletAddress?: string;
      walletProvider?: string;
      walletStatus?: string;
      executionTier?: string;
      createdAt?: string;
      dockerImage?: string;
      bridgeUrl?: string;
      errorCount?: number;
    };
  }>(`/api/v1/eliza/agents/${agentId}`);
  return res.data;
}

async function provisionAgent(agentId: string) {
  const res = await fetch(`/api/v1/eliza/agents/${agentId}/provision`, {
    method: "POST",
    credentials: "include",
  });
  const data = await res.json().catch(() => ({}));
  const jobId = (data as { data?: { jobId?: string } }).data?.jobId;
  if (!res.ok && !jobId) {
    throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return {
    jobId: jobId ?? null,
    queued: res.status === 202,
    alreadyInProgress: res.status === 409,
  };
}

async function resumeAgent(agentId: string) {
  const res = await fetch(`/api/v1/eliza/agents/${agentId}/resume`, {
    method: "POST",
    credentials: "include",
  });
  const data = await res.json().catch(() => ({}));
  const jobId = (data as { data?: { jobId?: string } }).data?.jobId;
  if (!res.ok && !jobId) {
    throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return { jobId: jobId ?? null, queued: res.status === 202 };
}

async function snapshotAgent(agentId: string) {
  const res = await fetch(`/api/v1/eliza/agents/${agentId}/snapshot`, {
    method: "POST",
    credentials: "include",
  });
  const data = await res.json().catch(() => ({}));
  const jobId = (data as { data?: { jobId?: string } }).data?.jobId;
  if (!res.ok && !jobId) {
    throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return { jobId: jobId ?? null };
}

async function deleteAgent(agentId: string) {
  const res = await fetch(`/api/v1/eliza/agents/${agentId}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  }
}

async function fetchBilling() {
  const res = await api<{ balance: number }>("/api/credits/balance");
  return res;
}

async function fetchTransactions() {
  const res = await api<
    Array<{
      id: string;
      amount: number;
      type: string;
      description?: string;
      created_at: string;
    }>
  >("/api/credits/transactions?hours=72");
  return res ?? [];
}

async function fetchInvoices() {
  const res =
    await api<
      Array<{
        id: string;
        amount: number;
        status: string;
        description?: string;
        createdAt?: string;
      }>
    >("/api/invoices/list");
  return res ?? [];
}

async function fetchApiKeys() {
  const res =
    await api<
      Array<{
        id: string;
        name: string;
        key_prefix?: string;
        is_active: boolean;
        last_used_at?: string;
        created_at?: string;
        usage_count?: number;
      }>
    >("/api/v1/api-keys");
  return res ?? [];
}

async function revokeApiKey(keyId: string) {
  const res = await fetch(`/api/v1/api-keys/${keyId}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  }
}

async function fetchApps() {
  const res =
    await api<
      Array<{
        id: string;
        name: string;
        deployment_status: string;
        description?: string;
        createdAt?: string;
      }>
    >("/api/v1/apps");
  return res ?? [];
}

async function _fetchAppDetail(appId: string) {
  const res = await api<{
    id: string;
    name: string;
    deployment_status: string;
    description?: string;
    createdAt?: string;
    userDatabaseStatus?: string;
    monetization?: { pricingModel?: string; amount?: number };
  }>(`/api/v1/apps/${appId}`);
  return res;
}

async function fetchAnalytics() {
  const res = await api<{
    overallStats?: {
      totalCost?: number;
      totalTokens?: number;
      totalRequests?: number;
      periodDays?: number;
    };
    timeSeriesData?: Array<{
      date: string;
      cost?: number;
      tokens?: number;
      requests?: number;
    }>;
    providerBreakdown?: Array<{
      provider: string;
      cost?: number;
      percentage?: number;
    }>;
    modelBreakdown?: Array<{
      model: string;
      cost?: number;
      percentage?: number;
    }>;
  }>("/api/analytics/breakdown?timeRange=7d");
  return res;
}

async function fetchProjections() {
  try {
    const res = await api<{
      historicalData?: Array<{ date: string; cost?: number }>;
      projections?: Array<{ date: string; projectedCost?: number }>;
      alerts?: Array<{ message: string; severity?: string }>;
      creditBalance?: number;
    }>("/api/analytics/projections?periods=4");
    return res;
  } catch {
    return {
      historicalData: [],
      projections: [],
      alerts: [],
      creditBalance: 0,
    };
  }
}

async function fetchUserProfile() {
  const res = await api<{
    id: string;
    email?: string | null;
    email_verified?: boolean | null;
    wallet_address?: string | null;
    wallet_chain_type?: string | null;
    wallet_verified?: boolean;
    name?: string | null;
    avatar?: string | null;
    displayName?: string;
    username?: string;
    avatarUrl?: string;
    bio?: string;
    createdAt?: string;
    updated_at?: string;
    role?: string;
    nickname?: string | null;
    work_function?: string | null;
    preferences?: string | null;
    email_notifications?: boolean | null;
    response_notifications?: boolean | null;
    is_active?: boolean;
    organization?: {
      id: string;
      name: string;
      slug: string;
      credit_balance?: number;
      billing_email?: string | null;
      is_active?: boolean;
      created_at?: string;
      updated_at?: string;
    };
  }>("/api/v1/user");
  return res;
}

async function fetchOrgMembers() {
  const res = await api<
    Array<{ id: string; email?: string; role?: string; joinedAt?: string }>
  >("/api/organizations/members");
  return res ?? [];
}

async function fetchMfaStatus() {
  try {
    const res = await api<{ enabled: boolean; method?: string }>(
      "/api/v1/me/mfa",
    );
    return res;
  } catch {
    return { enabled: false };
  }
}

async function fetchAuditEvents() {
  try {
    const res = await api<
      Array<{
        id: string;
        action: string;
        resource?: string;
        createdAt: string;
        ip?: string;
      }>
    >("/api/v1/me/audit-events?limit=50");
    return res ?? [];
  } catch {
    return [];
  }
}

async function fetchConnectorStatus(type: string) {
  try {
    const res = await api<{ connected: boolean; status?: string }>(
      `/api/v1/${type}/status`,
    );
    return res;
  } catch {
    return { connected: false };
  }
}

async function fetchMcps() {
  try {
    const res =
      await api<
        Array<{
          id: string;
          name: string;
          status?: string;
          description?: string;
        }>
      >("/api/mcp");
    return res ?? [];
  } catch {
    return [];
  }
}

async function _fetchJobStatus(jobId: string) {
  try {
    const res = await api<{
      jobId: string;
      status: string;
      error?: string;
    }>(`/api/v1/jobs/${jobId}`);
    return res;
  } catch {
    return null;
  }
}

async function fetchAdminOverview() {
  const res = await api<{
    overview?: {
      totalUsers?: number;
      totalAgents?: number;
      flaggedUsers?: number;
      pendingViolations?: number;
    };
  }>("/api/v1/admin/moderation?view=overview&limit=1");
  return res;
}

async function fetchAdminRedemptions() {
  const res = await api<
    Array<{
      id: string;
      code?: string;
      amount?: number;
      uses?: number;
      maxUses?: number;
      expiresAt?: string;
      isActive?: boolean;
    }>
  >("/api/admin/redemptions");
  return res ?? [];
}

async function _createApiKeyCall(name: string) {
  const res = await api<{ id: string; key: string; name: string }>(
    "/api/v1/api-keys",
    { method: "POST", json: { name } },
  );
  return res;
}

// ── Action API calls ──────────────────────────────────────────────

const AGENT_ACTIONS = [
  { id: "provision", label: "Deploy", endpoint: "provision", method: "POST" },
  { id: "resume", label: "Resume", endpoint: "resume", method: "POST" },
  { id: "snapshot", label: "Snapshot", endpoint: "snapshot", method: "POST" },
];

// ── Spec builders ──────────────────────────────────────────────────

function buildAgentsSpec(
  agents: Array<{
    id: string;
    agentName: string;
    status: string;
    lastHeartbeatAt?: string;
    webUiUrl?: string;
    errorMessage?: string;
  }>,
): UiSpec {
  return {
    root: "root",
    elements: {
      root: {
        type: "Stack",
        props: { gap: "lg" },
        children: [
          "header",
          "actionRow",
          agents.length > 0 ? "table" : "empty",
        ],
      },
      header: { type: "Stack", props: { gap: "sm" }, children: ["heading"] },
      heading: {
        type: "Heading",
        props: { text: `Agents (${agents.length})` },
        children: [],
      },
      actionRow: {
        type: "Stack",
        props: { gap: "sm", direction: "row" },
        children: ["createBtn", "refreshBtn"],
      },
      createBtn: {
        type: "Button",
        props: { label: "Create Agent", action: "cloud.agent.showCreateForm" },
        children: [],
        on: {
          click: {
            action: "cloud.agent.showCreateForm",
          },
        },
      },
      refreshBtn: {
        type: "Button",
        props: {
          label: "Refresh",
          action: "cloud.agent.refresh",
          variant: "outline",
        },
        children: [],
        on: {
          click: {
            action: "cloud.agent.refresh",
          },
        },
      },
      table: {
        type: "Table",
        props: {
          columns: [
            { header: "Name", accessor: "name" },
            { header: "Status", accessor: "status" },
            { header: "ID", accessor: "id" },
            { header: "Last Heartbeat", accessor: "lastHeartbeat" },
          ],
          rows: agents.map((a) => ({
            name: a.agentName,
            status: a.status,
            id: idShort(a.id),
            lastHeartbeat: a.lastHeartbeatAt
              ? new Date(a.lastHeartbeatAt).toLocaleDateString()
              : "—",
          })),
        },
        children: [],
      },
      empty: {
        type: "Text",
        props: {
          text: 'No agents yet. Create one by clicking "Create Agent" above.',
        },
        children: [],
      },
    },
    state: {},
  };
}

function buildAgentDetailSpec(agent: {
  id: string;
  agentName: string;
  status: string;
  databaseStatus?: string;
  lastHeartbeatAt?: string;
  errorMessage?: string;
  webUiUrl?: string;
  walletAddress?: string;
  walletProvider?: string;
  walletStatus?: string;
  executionTier?: string;
  createdAt?: string;
  dockerImage?: string;
  bridgeUrl?: string;
  errorCount?: number;
}): UiSpec {
  const running = agent.status === "running";
  const stopped = ["stopped", "error", "pending", "disconnected"].includes(
    agent.status,
  );
  const busy = agent.status === "provisioning";

  return {
    root: "root",
    elements: {
      root: {
        type: "Stack",
        props: { gap: "lg" },
        children: [
          "header",
          "actions",
          "statusCards",
          "walletCard",
          "infoStack",
        ],
      },
      header: {
        type: "Stack",
        props: { gap: "sm", direction: "row", align: "center" },
        children: ["heading", "statusBadge"],
      },
      heading: {
        type: "Heading",
        props: { text: agent.agentName },
        children: [],
      },
      statusBadge: {
        type: "Badge",
        props: {
          label: agent.status,
          variant: statusVariant(agent.status),
        },
        children: [],
      },
      actions: {
        type: "Stack",
        props: { gap: "sm", direction: "row", wrap: true },
        children: [
          ...(stopped && !busy ? ["resumeBtn"] : []),
          ...(running && !busy ? ["snapshotBtn"] : []),
          ...(!busy ? ["provisionBtn"] : []),
        ],
      },
      resumeBtn: {
        type: "Button",
        props: { label: "Resume Agent", action: "cloud.agent.resume" },
        children: [],
        on: {
          click: { action: "cloud.agent.resume", params: { id: agent.id } },
        },
      },
      snapshotBtn: {
        type: "Button",
        props: {
          label: "Save Snapshot",
          action: "cloud.agent.snapshot",
          variant: "outline",
        },
        children: [],
        on: {
          click: { action: "cloud.agent.snapshot", params: { id: agent.id } },
        },
      },
      provisionBtn: {
        type: "Button",
        props: { label: "Deploy", action: "cloud.agent.provision" },
        children: [],
        on: {
          click: { action: "cloud.agent.provision", params: { id: agent.id } },
        },
      },
      statusCards: {
        type: "Grid",
        props: { columns: 3, gap: "md" },
        children: ["agentStatusCard", "databaseCard", "heartbeatCard"],
      },
      agentStatusCard: {
        type: "Card",
        props: { title: "Agent Status" },
        children: ["agentStatusMetric"],
      },
      agentStatusMetric: {
        type: "Metric",
        props: { label: "Status", value: agent.status },
        children: [],
      },
      databaseCard: {
        type: "Card",
        props: { title: "Database" },
        children: ["databaseMetric"],
      },
      databaseMetric: {
        type: "Metric",
        props: { label: "DB Status", value: agent.databaseStatus ?? "unknown" },
        children: [],
      },
      heartbeatCard: {
        type: "Card",
        props: { title: "Last Heartbeat" },
        children: ["heartbeatMetric"],
      },
      heartbeatMetric: {
        type: "Metric",
        props: {
          label: "Heard",
          value: agent.lastHeartbeatAt
            ? new Date(agent.lastHeartbeatAt).toLocaleString()
            : "Never",
        },
        children: [],
      },
      walletCard: {
        type: "Card",
        props: { title: "Wallet" },
        children: [agent.walletAddress ? "walletAddr" : "noWallet"],
      },
      walletAddr: {
        type: "Text",
        props: {
          text: agent.walletAddress
            ? `${agent.walletAddress.slice(0, 6)}...${agent.walletAddress.slice(-4)}`
            : "No wallet",
        },
        children: [],
      },
      noWallet: {
        type: "Text",
        props: { text: "No wallet configured" },
        children: [],
      },
      infoStack: {
        type: "Stack",
        props: { gap: "sm" },
        children: [
          ...(agent.executionTier ? ["tierInfo"] : []),
          ...(agent.createdAt ? ["createdInfo"] : []),
          ...(agent.errorMessage ? ["errorInfo"] : []),
          ...(agent.errorCount != null && agent.errorCount > 0
            ? ["errorCountInfo"]
            : []),
        ],
      },
      ...(agent.executionTier
        ? {
            tierInfo: {
              type: "Text",
              props: { text: `Tier: ${agent.executionTier}` },
              children: [],
            },
          }
        : {}),
      ...(agent.createdAt
        ? {
            createdInfo: {
              type: "Text",
              props: {
                text: `Created: ${new Date(agent.createdAt).toLocaleDateString()}`,
              },
              children: [],
            },
          }
        : {}),
      ...(agent.errorMessage
        ? {
            errorInfo: {
              type: "Alert",
              props: {
                variant: "error",
                title: "Error",
                message: agent.errorMessage,
              },
              children: [],
            },
          }
        : {}),
      ...(agent.errorCount != null && agent.errorCount > 0
        ? {
            errorCountInfo: {
              type: "Text",
              props: { text: `Error count: ${agent.errorCount}` },
              children: [],
            },
          }
        : {}),
    },
    state: {},
  };
}

function buildAgentFormSpec(): UiSpec {
  return {
    root: "root",
    elements: {
      root: {
        type: "Stack",
        props: { gap: "lg" },
        children: ["heading", "form"],
      },
      heading: {
        type: "Heading",
        props: { text: "Create a New Agent" },
        children: [],
      },
      form: {
        type: "Stack",
        props: { gap: "md" },
        children: [
          "nameField",
          "flavorField",
          "tierField",
          "descriptionField",
          "submitBtn",
          "cancelBtn",
        ],
      },
      nameField: {
        type: "Input",
        props: {
          label: "Agent Name",
          placeholder: "my-awesome-agent",
          statePath: "agentName",
        },
        children: [],
      },
      flavorField: {
        type: "Select",
        props: {
          label: "Character / Flavor",
          statePath: "flavor",
          options: [
            { label: "Eliza (default)", value: "eliza" },
            { label: "Dobby", value: "dobby" },
            { label: "Trading Agent", value: "trader" },
            { label: "Customer Support", value: "support" },
            { label: "Custom Docker", value: "custom" },
          ],
          placeholder: "Select a character flavor...",
        },
        children: [],
      },
      tierField: {
        type: "Select",
        props: {
          label: "Execution Tier",
          statePath: "executionTier",
          options: [
            { label: "Shared (cheapest)", value: "shared" },
            {
              label: "Dedicated (custom image, always-on)",
              value: "dedicated",
            },
          ],
          placeholder: "Select tier...",
        },
        children: [],
      },
      descriptionField: {
        type: "Textarea",
        props: {
          label: "Description (optional)",
          placeholder: "What should this agent do?",
          statePath: "description",
        },
        children: [],
      },
      submitBtn: {
        type: "Button",
        props: {
          label: "Create & Deploy Agent",
          action: "cloud.agent.submitCreate",
        },
        children: [],
        on: {
          click: {
            action: "cloud.agent.submitCreate",
            params: {
              name: { $path: "agentName" },
              flavor: { $path: "flavor" },
              executionTier: { $path: "executionTier" },
              description: { $path: "description" },
            },
          },
        },
      },
      cancelBtn: {
        type: "Button",
        props: {
          label: "Cancel",
          action: "cloud.agent.cancel",
          variant: "outline",
        },
        children: [],
        on: { click: { action: "cloud.agent.cancel" } },
      },
    },
    state: {
      agentName: "",
      flavor: "eliza",
      executionTier: "shared",
      description: "",
    },
  };
}

function buildDeployProgressSpec(
  agentId: string,
  agentName: string,
  _jobId: string | null,
  status: string,
  _actions: Array<{ id: string; label: string }>,
): UiSpec {
  const isRunning = status === "running";
  const isError = status === "error" || status === "failed";
  const isProvisioning = status === "provisioning" || status === "pending";

  return {
    root: "root",
    elements: {
      root: {
        type: "Stack",
        props: { gap: "lg", align: "center" },
        children: [
          "heading",
          "progressCard",
          "statusText",
          ...(isRunning || isError ? ["actionsRow"] : []),
          "viewBtn",
        ],
      },
      heading: {
        type: "Heading",
        props: { text: `Deploying ${agentName}` },
        children: [],
      },
      progressCard: {
        type: "Card",
        props: {
          title: "Deployment Progress",
          style: { width: "100%", maxWidth: 500 },
        },
        children: ["progressBar", "stepsStack"],
      },
      progressBar: {
        type: "Progress",
        props: {
          value: isRunning ? 100 : isError ? 66 : isProvisioning ? 33 : 50,
          label: isRunning ? "Complete" : isError ? "Failed" : "In Progress",
        },
        children: [],
      },
      stepsStack: {
        type: "Stack",
        props: { gap: "sm" },
        children: ["step1", "step2", "step3", "step4"],
      },
      step1: {
        type: "Text",
        props: {
          text:
            isRunning || status !== "pending"
              ? "✓ Agent created"
              : "⟳ Creating agent...",
        },
        children: [],
      },
      step2: {
        type: "Text",
        props: {
          text:
            isProvisioning || isRunning || isError
              ? "⟳ Provisioning infrastructure..."
              : "Waiting...",
        },
        children: [],
      },
      step3: {
        type: "Text",
        props: {
          text:
            isRunning || status === "running" || status === "error"
              ? isRunning
                ? "✓ Starting agent runtime"
                : "✗ Failed to start"
              : "Waiting...",
        },
        children: [],
      },
      step4: {
        type: "Text",
        props: {
          text: isRunning
            ? "✓ Ready"
            : isError
              ? "✗ Deployment failed"
              : "Waiting...",
        },
        children: [],
      },
      statusText: {
        type: "Alert",
        props: {
          variant: isError ? "error" : "info",
          title: isError
            ? "Deployment Failed"
            : isRunning
              ? "Agent Running"
              : "Provisioning",
          message: isError
            ? "The agent could not be deployed. Try again or check the logs."
            : isRunning
              ? "Your agent is now running and ready."
              : "Your agent is being deployed. This usually takes 2-5 minutes.",
        },
        children: [],
      },
      actionsRow: {
        type: "Stack",
        props: { gap: "sm", direction: "row" },
        children: [
          ...(isRunning ? ["openChatBtn", "managePluginsBtn"] : []),
          ...(isError ? ["retryBtn"] : []),
        ],
      },
      openChatBtn: {
        type: "Button",
        props: { label: "Open Chat", action: "cloud.navigate" },
        children: [],
        on: {
          click: {
            action: "cloud.navigate",
            params: { to: `/dashboard/agents/${agentId}/chat` },
          },
        },
      },
      managePluginsBtn: {
        type: "Button",
        props: {
          label: "Manage Plugins",
          action: "cloud.agent.plugins",
          variant: "outline",
        },
        children: [],
        on: {
          click: { action: "cloud.agent.plugins", params: { id: agentId } },
        },
      },
      retryBtn: {
        type: "Button",
        props: { label: "Retry Deployment", action: "cloud.agent.provision" },
        children: [],
        on: {
          click: { action: "cloud.agent.provision", params: { id: agentId } },
        },
      },
      viewBtn: {
        type: "Button",
        props: {
          label: "View Agent Details",
          action: "cloud.agent.select",
          variant: "outline",
        },
        children: [],
        on: {
          click: { action: "cloud.agent.select", params: { id: agentId } },
        },
      },
    },
    state: {},
  };
}

function buildPluginSpec(
  agentId: string,
  agentName: string,
  plugins: Array<{
    id: string;
    name: string;
    enabled: boolean;
    description?: string;
  }>,
): UiSpec {
  return {
    root: "root",
    elements: {
      root: {
        type: "Stack",
        props: { gap: "lg" },
        children: [
          "heading",
          "subtitle",
          plugins.length > 0 ? "pluginList" : "empty",
        ],
      },
      heading: {
        type: "Heading",
        props: { text: `Plugins: ${agentName}` },
        children: [],
      },
      subtitle: {
        type: "Text",
        props: {
          text: "Enable or disable hosted managed plugins for this agent. Changes may require a restart.",
        },
        children: [],
      },
      pluginList: {
        type: "Grid",
        props: { columns: 2, gap: "md" },
        children: plugins.map((p) => p.id),
      },
      ...Object.fromEntries(
        plugins.map((p) => [
          p.id,
          {
            type: "Card" as const,
            props: { title: p.name },
            children: [`${p.id}-desc`, `${p.id}-toggle`],
          },
        ]),
      ),
      ...Object.fromEntries(
        plugins.map((p) => [
          `${p.id}-desc`,
          {
            type: "Text" as const,
            props: { text: p.description ?? "No description" },
            children: [],
          },
        ]),
      ),
      ...Object.fromEntries(
        plugins.map((p) => [
          `${p.id}-toggle`,
          {
            type: "Button" as const,
            props: {
              label: p.enabled ? "Enabled" : "Disabled",
              variant: p.enabled ? "primary" : "outline",
              action: "cloud.agent.pluginToggle",
            },
            children: [],
            on: {
              click: {
                action: "cloud.agent.pluginToggle",
                params: { agentId, pluginId: p.id, enabled: !p.enabled },
              },
            },
          },
        ]),
      ),
      empty: {
        type: "Text",
        props: { text: "No managed plugins available for this agent." },
        children: [],
      },
    },
    state: {},
  };
}

function buildApiExplorerSpec(): UiSpec {
  return {
    root: "root",
    elements: {
      root: {
        type: "Stack",
        props: { gap: "lg" },
        children: [
          "heading",
          "methodSelect",
          "urlInput",
          "bodyArea",
          "executeBtn",
          "responseArea",
        ],
      },
      heading: {
        type: "Heading",
        props: { text: "API Explorer" },
        children: [],
      },
      methodSelect: {
        type: "Select",
        props: {
          label: "Method",
          statePath: "method",
          options: [
            { label: "GET", value: "GET" },
            { label: "POST", value: "POST" },
            { label: "PUT", value: "PUT" },
            { label: "PATCH", value: "PATCH" },
            { label: "DELETE", value: "DELETE" },
          ],
        },
        children: [],
      },
      urlInput: {
        type: "Input",
        props: {
          label: "API Path",
          placeholder: "/api/v1/eliza/agents",
          statePath: "apiPath",
        },
        children: [],
      },
      bodyArea: {
        type: "Textarea",
        props: {
          label: "Request Body (JSON, optional)",
          placeholder: '{ "key": "value" }',
          statePath: "requestBody",
        },
        children: [],
      },
      executeBtn: {
        type: "Button",
        props: { label: "Execute", action: "cloud.api.executeTest" },
        children: [],
        on: {
          click: {
            action: "cloud.api.executeTest",
            params: {
              method: { $path: "method" },
              path: { $path: "apiPath" },
              body: { $path: "requestBody" },
            },
          },
        },
      },
      responseArea: {
        type: "Card",
        props: { title: "Response" },
        children: ["responseText"],
      },
      responseText: {
        type: "Text",
        props: { text: "Execute a request to see the response here." },
        children: [],
      },
    },
    state: { method: "GET", apiPath: "/api/v1/eliza/agents", requestBody: "" },
  };
}

function buildHealthSpec(
  agents: Array<{
    id: string;
    agentName: string;
    status: string;
    lastHeartbeatAt?: string;
    errorMessage?: string;
  }>,
  _totalCost?: number,
): UiSpec {
  const healthy = agents.filter((a) => a.status === "running").length;
  const degraded = agents.filter(
    (a) => a.status === "error" || a.status === "disconnected",
  ).length;
  const stopped = agents.filter((a) =>
    ["stopped", "pending", "sleeping"].includes(a.status),
  ).length;

  return {
    root: "root",
    elements: {
      root: {
        type: "Stack",
        props: { gap: "lg" },
        children: [
          "heading",
          "healthGrid",
          agents.length > 0 ? "agentHealthTable" : "",
        ],
      },
      heading: {
        type: "Heading",
        props: { text: "System Health" },
        children: [],
      },
      healthGrid: {
        type: "Grid",
        props: { columns: 3, gap: "md" },
        children: ["healthyCard", "degradedCard", "stoppedCard"],
      },
      healthyCard: {
        type: "Card",
        props: { title: "Healthy" },
        children: ["healthyMetric"],
      },
      healthyMetric: {
        type: "Metric",
        props: { label: "Running", value: String(healthy) },
        children: [],
      },
      degradedCard: {
        type: "Card",
        props: { title: "Degraded" },
        children: ["degradedMetric"],
      },
      degradedMetric: {
        type: "Metric",
        props: { label: "Errors", value: String(degraded) },
        children: [],
      },
      stoppedCard: {
        type: "Card",
        props: { title: "Stopped" },
        children: ["stoppedMetric"],
      },
      stoppedMetric: {
        type: "Metric",
        props: { label: "Stopped/Pending", value: String(stopped) },
        children: [],
      },
      agentHealthTable: {
        type: "Table",
        props: {
          columns: [
            { header: "Agent", accessor: "name" },
            { header: "Status", accessor: "status" },
            { header: "Heartbeat", accessor: "heartbeat" },
            { header: "Issues", accessor: "issues" },
          ],
          rows: agents.map((a) => ({
            name: a.agentName,
            status: a.status,
            heartbeat: a.lastHeartbeatAt
              ? new Date(a.lastHeartbeatAt).toLocaleString()
              : "Never",
            issues: a.errorMessage ? "⚠ Has errors" : "None",
          })),
        },
        children: [],
      },
    },
    state: {},
  };
}

function buildBillingSpec(balance: number): UiSpec {
  return {
    root: "root",
    elements: {
      root: {
        type: "Stack",
        props: { gap: "lg", align: "center" },
        children: ["heading", "balanceCard"],
      },
      heading: { type: "Heading", props: { text: "Billing" }, children: [] },
      balanceCard: {
        type: "Card",
        props: {
          title: "Credit Balance",
          style: { width: "100%", maxWidth: 400 },
        },
        children: ["balanceMetric", "addCreditsBtn"],
      },
      balanceMetric: {
        type: "Metric",
        props: { label: "Available Credits", value: fmtCredits(balance) },
        children: [],
      },
      addCreditsBtn: {
        type: "Button",
        props: { label: "Add Credits", action: "cloud.openBilling" },
        children: [],
        on: { click: { action: "cloud.openBilling" } },
      },
    },
    state: {},
  };
}

function buildTransactionsSpec(
  txns: Array<{
    id: string;
    amount: number;
    type: string;
    description?: string;
    created_at: string;
  }>,
): UiSpec {
  return {
    root: "root",
    elements: {
      root: {
        type: "Stack",
        props: { gap: "lg" },
        children: ["heading", txns.length > 0 ? "txnTable" : "empty"],
      },
      heading: {
        type: "Heading",
        props: { text: `Recent Transactions (${txns.length})` },
        children: [],
      },
      txnTable: {
        type: "Table",
        props: {
          columns: [
            { header: "Date", accessor: "date" },
            { header: "Type", accessor: "type" },
            { header: "Amount", accessor: "amount" },
            { header: "Description", accessor: "description" },
          ],
          rows: txns.slice(0, 20).map((t) => ({
            date: new Date(t.created_at).toLocaleDateString(),
            type: t.type,
            amount: t.amount > 0 ? `+${t.amount}` : `${t.amount}`,
            description: t.description ?? "—",
          })),
        },
        children: [],
      },
      empty: {
        type: "Text",
        props: { text: "No recent transactions." },
        children: [],
      },
    },
    state: {},
  };
}

function buildInvoicesSpec(
  invoices: Array<{
    id: string;
    amount: number;
    status: string;
    description?: string;
    createdAt?: string;
  }>,
): UiSpec {
  return {
    root: "root",
    elements: {
      root: {
        type: "Stack",
        props: { gap: "lg" },
        children: ["heading", "invoiceTable"],
      },
      heading: {
        type: "Heading",
        props: { text: `Invoices (${invoices.length})` },
        children: [],
      },
      invoiceTable: {
        type: "Table",
        props: {
          columns: [
            { header: "ID", accessor: "id" },
            { header: "Amount", accessor: "amount" },
            { header: "Status", accessor: "status" },
            { header: "Date", accessor: "date" },
          ],
          rows: invoices.map((inv) => ({
            id: idShort(inv.id),
            amount: `$${inv.amount.toFixed(2)}`,
            status: inv.status,
            date: inv.createdAt
              ? new Date(inv.createdAt).toLocaleDateString()
              : "—",
          })),
        },
        children: [],
      },
    },
    state: {},
  };
}

function buildApiKeysSpec(
  keys: Array<{
    id: string;
    name: string;
    key_prefix?: string;
    is_active: boolean;
    last_used_at?: string;
    usage_count?: number;
  }>,
): UiSpec {
  return {
    root: "root",
    elements: {
      root: {
        type: "Stack",
        props: { gap: "lg" },
        children: [
          "heading",
          "createBtn",
          keys.length > 0 ? "keysTable" : "empty",
        ],
      },
      heading: {
        type: "Heading",
        props: { text: `API Keys (${keys.length})` },
        children: [],
      },
      createBtn: {
        type: "Button",
        props: { label: "Create API Key", action: "cloud.apikey.create" },
        children: [],
        on: { click: { action: "cloud.apikey.create" } },
      },
      keysTable: {
        type: "Table",
        props: {
          columns: [
            { header: "Name", accessor: "name" },
            { header: "Active", accessor: "active" },
            { header: "Prefix", accessor: "prefix" },
            { header: "Last Used", accessor: "lastUsed" },
            { header: "Uses", accessor: "uses" },
          ],
          rows: keys.map((k) => ({
            name: k.name,
            active: k.is_active ? "Yes" : "No",
            prefix: k.key_prefix ?? "—",
            lastUsed: k.last_used_at
              ? new Date(k.last_used_at).toLocaleDateString()
              : "Never",
            uses: String(k.usage_count ?? 0),
          })),
        },
        children: [],
      },
      empty: {
        type: "Text",
        props: { text: 'No API keys yet. Click "Create API Key" to make one.' },
        children: [],
      },
    },
    state: {},
  };
}

function buildAppsSpec(
  apps: Array<{
    id: string;
    name: string;
    deployment_status: string;
    description?: string;
  }>,
): UiSpec {
  return {
    root: "root",
    elements: {
      root: {
        type: "Stack",
        props: { gap: "lg" },
        children: ["heading", apps.length > 0 ? "appsTable" : "empty"],
      },
      heading: {
        type: "Heading",
        props: { text: `Apps (${apps.length})` },
        children: [],
      },
      appsTable: {
        type: "Table",
        props: {
          columns: [
            { header: "Name", accessor: "name" },
            { header: "Status", accessor: "status" },
            { header: "Description", accessor: "description" },
          ],
          rows: apps.map((a) => ({
            name: a.name,
            status: a.deployment_status,
            description: a.description ?? "—",
          })),
        },
        children: [],
      },
      empty: {
        type: "Text",
        props: { text: "No apps yet." },
        children: [],
      },
    },
    state: {},
  };
}

function buildAnalyticsSpec(analytics: {
  overallStats?: {
    totalCost?: number;
    totalTokens?: number;
    totalRequests?: number;
    periodDays?: number;
  };
  providerBreakdown?: Array<{
    provider: string;
    cost?: number;
    percentage?: number;
  }>;
  modelBreakdown?: Array<{
    model: string;
    cost?: number;
    percentage?: number;
  }>;
}): UiSpec {
  const stats = analytics.overallStats;
  const periodLabel = stats?.periodDays ? `(last ${stats.periodDays}d)` : "";

  return {
    root: "root",
    elements: {
      root: {
        type: "Stack",
        props: { gap: "lg" },
        children: [
          "heading",
          "metricsGrid",
          ...(analytics.providerBreakdown?.length ? ["providerCard"] : []),
          ...(analytics.modelBreakdown?.length ? ["modelCard"] : []),
        ],
      },
      heading: {
        type: "Heading",
        props: { text: `Analytics ${periodLabel}` },
        children: [],
      },
      metricsGrid: {
        type: "Grid",
        props: { columns: 3, gap: "md" },
        children: ["costMetric", "tokensMetric", "requestsMetric"],
      },
      costMetric: {
        type: "Card",
        props: { title: "Total Cost" },
        children: ["costMetricInner"],
      },
      costMetricInner: {
        type: "Metric",
        props: {
          label: "Cost",
          value: stats?.totalCost ? `$${stats.totalCost.toFixed(2)}` : "—",
        },
        children: [],
      },
      tokensMetric: {
        type: "Card",
        props: { title: "Tokens Used" },
        children: ["tokensMetricInner"],
      },
      tokensMetricInner: {
        type: "Metric",
        props: {
          label: "Tokens",
          value: stats?.totalTokens ? stats.totalTokens.toLocaleString() : "—",
        },
        children: [],
      },
      requestsMetric: {
        type: "Card",
        props: { title: "Requests" },
        children: ["requestsMetricInner"],
      },
      requestsMetricInner: {
        type: "Metric",
        props: {
          label: "Requests",
          value: stats?.totalRequests
            ? stats.totalRequests.toLocaleString()
            : "—",
        },
        children: [],
      },
      providerCard: {
        type: "Card",
        props: { title: "By Provider" },
        children: ["providerTable"],
      },
      providerTable: {
        type: "Table",
        props: {
          columns: [
            { header: "Provider", accessor: "provider" },
            { header: "Cost", accessor: "cost" },
            { header: "%", accessor: "pct" },
          ],
          rows:
            analytics.providerBreakdown?.map((p) => ({
              provider: p.provider,
              cost: `$${p.cost?.toFixed(2) ?? "0.00"}`,
              pct: p.percentage != null ? `${p.percentage.toFixed(0)}%` : "—",
            })) ?? [],
        },
        children: [],
      },
      modelCard: {
        type: "Card",
        props: { title: "By Model" },
        children: ["modelTable"],
      },
      modelTable: {
        type: "Table",
        props: {
          columns: [
            { header: "Model", accessor: "model" },
            { header: "Cost", accessor: "cost" },
            { header: "%", accessor: "pct" },
          ],
          rows:
            analytics.modelBreakdown?.map((m) => ({
              model: m.model,
              cost: `$${m.cost?.toFixed(2) ?? "0.00"}`,
              pct: m.percentage != null ? `${m.percentage.toFixed(0)}%` : "—",
            })) ?? [],
        },
        children: [],
      },
    },
    state: {},
  };
}

function buildProjectionsSpec(projections: {
  historicalData?: Array<{ date: string; cost?: number }>;
  projections?: Array<{ date: string; projectedCost?: number }>;
  alerts?: Array<{ message: string; severity?: string }>;
  creditBalance?: number;
}): UiSpec {
  const alertEls: Array<{
    id: string;
    type: string;
    props: Record<string, unknown>;
    children: string[];
  }> = [];
  if (projections.alerts?.length) {
    projections.alerts.forEach((a, i) => {
      alertEls.push({
        id: `alert_${i}`,
        type: "Alert",
        props: {
          variant: a.severity === "high" ? "error" : "warning",
          message: a.message,
        },
        children: [],
      });
    });
  }

  return {
    root: "root",
    elements: {
      root: {
        type: "Stack",
        props: { gap: "lg" },
        children: [
          "heading",
          ...(projections.creditBalance != null ? ["creditMetric"] : []),
          ...alertEls.map((a) => a.id),
          "projectionTable",
        ],
      },
      heading: {
        type: "Heading",
        props: { text: "Cost Projections" },
        children: [],
      },
      ...(projections.creditBalance != null
        ? {
            creditMetric: {
              type: "Card",
              props: { title: "Current Balance" },
              children: ["creditMetricInner"],
            },
            creditMetricInner: {
              type: "Metric",
              props: {
                label: "Credits",
                value: fmtCredits(projections.creditBalance),
              },
              children: [],
            },
          }
        : {}),
      ...alertEls.reduce(
        (acc, a) => {
          acc[a.id] = a;
          return acc;
        },
        {} as Record<
          string,
          { type: string; props: Record<string, unknown>; children: string[] }
        >,
      ),
      projectionTable: {
        type: "Table",
        props: {
          columns: [
            { header: "Period", accessor: "period" },
            { header: "Actual Cost", accessor: "actual" },
            { header: "Projected", accessor: "projected" },
          ],
          rows: [
            ...(projections.historicalData?.slice(-4).map((h) => ({
              period: h.date,
              actual: `$${h.cost?.toFixed(2) ?? "0.00"}`,
              projected: "—",
            })) ?? []),
            ...(projections.projections?.map((p) => ({
              period: p.date,
              actual: "—",
              projected: `$${p.projectedCost?.toFixed(2) ?? "0.00"}`,
            })) ?? []),
          ],
        },
        children: [],
      },
    },
    state: {},
  };
}

function buildProfileSpec(user: {
  id: string;
  email?: string | null;
  email_verified?: boolean | null;
  wallet_address?: string | null;
  wallet_chain_type?: string | null;
  wallet_verified?: boolean;
  name?: string | null;
  avatar?: string | null;
  displayName?: string;
  username?: string;
  avatarUrl?: string;
  bio?: string;
  createdAt?: string;
  created_at?: string;
  updated_at?: string;
  role?: string;
  nickname?: string | null;
  work_function?: string | null;
  preferences?: string | null;
  email_notifications?: boolean | null;
  response_notifications?: boolean | null;
  is_active?: boolean;
  organization?: {
    id: string;
    name: string;
    slug: string;
    credit_balance?: number;
    billing_email?: string | null;
    is_active?: boolean;
    created_at?: string;
    updated_at?: string;
  };
}): UiSpec {
  return {
    root: "profileOverview",
    elements: {
      profileOverview: {
        type: "ProfileOverview",
        props: {
          userId: user.id,
          email: user.email || "",
          emailVerified: user.email_verified ?? false,
          walletAddress: user.wallet_address || "",
          walletChainType: user.wallet_chain_type || "",
          walletVerified: user.wallet_verified ?? false,
          displayName: user.displayName || user.name || "",
          username: user.username || "",
          bio: user.bio || user.preferences || "",
          avatarUrl: user.avatarUrl || user.avatar || "",
          createdAt: user.createdAt || user.created_at || "",
          updatedAt: user.updated_at || "",
          role: user.role || "user",
          nickname: user.nickname || "",
          workFunction: user.work_function || "",
          preferences: user.preferences || "",
          emailNotifications: user.email_notifications ?? false,
          responseNotifications: user.response_notifications ?? false,
          isActive: user.is_active ?? true,
          orgId: user.organization?.id || "",
          orgName: user.organization?.name || "",
          orgSlug: user.organization?.slug || "",
          orgCreditBalance: user.organization?.credit_balance ?? 0,
          orgBillingEmail: user.organization?.billing_email || "",
          orgIsActive: user.organization?.is_active ?? true,
          orgCreatedAt: user.organization?.created_at || "",
        },
        children: [],
      },
    },
    state: {},
  };
}

function buildSecuritySpec(mfa: { enabled: boolean; method?: string }): UiSpec {
  return {
    root: "root",
    elements: {
      root: {
        type: "Stack",
        props: { gap: "lg" },
        children: ["heading", "mfaCard"],
      },
      heading: { type: "Heading", props: { text: "Security" }, children: [] },
      mfaCard: {
        type: "Card",
        props: { title: "Multi-Factor Authentication" },
        children: ["mfaStatus"],
      },
      mfaStatus: {
        type: "Stack",
        props: { gap: "sm" },
        children: ["mfaBadge", "mfaText"],
      },
      mfaBadge: {
        type: "Badge",
        props: {
          label: mfa.enabled ? "Enabled" : "Disabled",
          variant: mfa.enabled ? "success" : "warning",
        },
        children: [],
      },
      mfaText: {
        type: "Text",
        props: {
          text: mfa.enabled
            ? `Method: ${mfa.method ?? "authenticator app"}`
            : "Set up MFA in your security settings for additional protection.",
        },
        children: [],
      },
    },
    state: {},
  };
}

function buildAuditSpec(
  events: Array<{
    id: string;
    action: string;
    resource?: string;
    createdAt: string;
    ip?: string;
  }>,
): UiSpec {
  return {
    root: "root",
    elements: {
      root: {
        type: "Stack",
        props: { gap: "lg" },
        children: ["heading", events.length > 0 ? "auditTable" : "empty"],
      },
      heading: { type: "Heading", props: { text: "Audit Log" }, children: [] },
      auditTable: {
        type: "Table",
        props: {
          columns: [
            { header: "Date", accessor: "date" },
            { header: "Action", accessor: "action" },
            { header: "Resource", accessor: "resource" },
            { header: "IP", accessor: "ip" },
          ],
          rows: events.slice(0, 30).map((e) => ({
            date: new Date(e.createdAt).toLocaleString(),
            action: e.action,
            resource: e.resource ?? "—",
            ip: e.ip ?? "—",
          })),
        },
        children: [],
      },
      empty: {
        type: "Text",
        props: { text: "No audit events found." },
        children: [],
      },
    },
    state: {},
  };
}

function buildConnectorsSpec(
  connectors: Array<{
    name: string;
    connected: boolean;
    status?: string;
  }>,
): UiSpec {
  return {
    root: "root",
    elements: {
      root: {
        type: "Stack",
        props: { gap: "lg" },
        children: ["heading", "connectorGrid"],
      },
      heading: {
        type: "Heading",
        props: { text: "Connectors & Integrations" },
        children: [],
      },
      connectorGrid: {
        type: "Grid",
        props: { columns: 2, gap: "md" },
        children: connectors.map((c) => c.name),
      },
      ...Object.fromEntries(
        connectors.map((c) => [
          c.name,
          {
            type: "Card",
            props: { title: c.name },
            children: [`${c.name}-badge`, `${c.name}-status`],
          },
        ]),
      ),
      ...Object.fromEntries(
        connectors.map((c) => [
          `${c.name}-badge`,
          {
            type: "Badge",
            props: {
              label: c.connected ? "Connected" : "Disconnected",
              variant: c.connected ? "success" : "error",
            },
            children: [],
          },
        ]),
      ),
      ...Object.fromEntries(
        connectors.map((c) => [
          `${c.name}-status`,
          {
            type: "Text",
            props: {
              text: c.status ?? (c.connected ? "Active" : "Not connected"),
            },
            children: [],
          },
        ]),
      ),
    },
    state: {},
  };
}

function buildAdminOverviewSpec(overview: {
  totalUsers?: number;
  totalAgents?: number;
  flaggedUsers?: number;
  pendingViolations?: number;
}): UiSpec {
  return {
    root: "root",
    elements: {
      root: {
        type: "Stack",
        props: { gap: "lg" },
        children: ["heading", "adminMetricsGrid"],
      },
      heading: {
        type: "Heading",
        props: { text: "Admin Overview" },
        children: [],
      },
      adminMetricsGrid: {
        type: "Grid",
        props: { columns: 2, gap: "md" },
        children: ["usersCard", "agentsCard", "flaggedCard", "violationsCard"],
      },
      usersCard: {
        type: "Card",
        props: { title: "Total Users" },
        children: ["usersMetric"],
      },
      usersMetric: {
        type: "Metric",
        props: { label: "Users", value: String(overview.totalUsers ?? 0) },
        children: [],
      },
      agentsCard: {
        type: "Card",
        props: { title: "Total Agents" },
        children: ["agentsMetric"],
      },
      agentsMetric: {
        type: "Metric",
        props: { label: "Agents", value: String(overview.totalAgents ?? 0) },
        children: [],
      },
      flaggedCard: {
        type: "Card",
        props: { title: "Flagged Users" },
        children: ["flaggedMetric"],
      },
      flaggedMetric: {
        type: "Metric",
        props: {
          label: "Flagged",
          value: String(overview.flaggedUsers ?? 0),
        },
        children: [],
      },
      violationsCard: {
        type: "Card",
        props: { title: "Pending Violations" },
        children: ["violationsMetric"],
      },
      violationsMetric: {
        type: "Metric",
        props: {
          label: "Violations",
          value: String(overview.pendingViolations ?? 0),
        },
        children: [],
      },
    },
    state: {},
  };
}

function buildMcpSpec(
  mcps: Array<{
    id: string;
    name: string;
    status?: string;
    description?: string;
  }>,
): UiSpec {
  return {
    root: "root",
    elements: {
      root: {
        type: "Stack",
        props: { gap: "lg" },
        children: ["heading", mcps.length > 0 ? "mcpTable" : "empty"],
      },
      heading: {
        type: "Heading",
        props: { text: `MCP Servers (${mcps.length})` },
        children: [],
      },
      mcpTable: {
        type: "Table",
        props: {
          columns: [
            { header: "Name", accessor: "name" },
            { header: "Status", accessor: "status" },
            { header: "Description", accessor: "description" },
          ],
          rows: mcps.map((m) => ({
            name: m.name,
            status: m.status ?? "unknown",
            description: m.description ?? "—",
          })),
        },
        children: [],
      },
      empty: {
        type: "Text",
        props: { text: "No MCP servers configured." },
        children: [],
      },
    },
    state: {},
  };
}

function _buildHelpSpec(): UiSpec {
  return {
    root: "root",
    elements: {
      root: {
        type: "Stack",
        props: { gap: "lg" },
        children: ["heading", "helpCards"],
      },
      heading: {
        type: "Heading",
        props: { text: "What I Can Help With" },
        children: [],
      },
      helpCards: {
        type: "Grid",
        props: { columns: 2, gap: "md" },
        children: [
          "agentsHelp",
          "billingHelp",
          "appsHelp",
          "apiKeysHelp",
          "analyticsHelp",
          "accountHelp",
          "securityHelp",
          "adminHelp",
        ],
      },
      agentsHelp: {
        type: "Card",
        props: {
          title: "Agents",
          description: "List, create, and manage your agents",
        },
        children: ["agentsHelpText"],
      },
      agentsHelpText: {
        type: "Text",
        props: {
          text: '"show my agents" · "create an agent" · "deploy my agent"',
        },
        children: [],
      },
      billingHelp: {
        type: "Card",
        props: {
          title: "Billing",
          description: "Check credits, transactions, and invoices",
        },
        children: ["billingHelpText"],
      },
      billingHelpText: {
        type: "Text",
        props: {
          text: '"check balance" · "recent transactions" · "show invoices"',
        },
        children: [],
      },
      appsHelp: {
        type: "Card",
        props: {
          title: "Apps",
          description: "List and manage your deployed apps",
        },
        children: ["appsHelpText"],
      },
      appsHelpText: {
        type: "Text",
        props: { text: '"show my apps" · "app status"' },
        children: [],
      },
      apiKeysHelp: {
        type: "Card",
        props: {
          title: "API Keys",
          description: "Manage API access keys",
        },
        children: ["apiKeysHelpText"],
      },
      apiKeysHelpText: {
        type: "Text",
        props: { text: '"list API keys" · "create an API key"' },
        children: [],
      },
      analyticsHelp: {
        type: "Card",
        props: {
          title: "Analytics",
          description: "Usage statistics and cost projections",
        },
        children: ["analyticsHelpText"],
      },
      analyticsHelpText: {
        type: "Text",
        props: { text: '"show analytics" · "cost projections"' },
        children: [],
      },
      accountHelp: {
        type: "Card",
        props: {
          title: "Account",
          description: "Profile, organization, and team",
        },
        children: ["accountHelpText"],
      },
      accountHelpText: {
        type: "Text",
        props: { text: '"my profile" · "team members" · "organization"' },
        children: [],
      },
      securityHelp: {
        type: "Card",
        props: {
          title: "Security",
          description: "MFA, audit logs, sessions, and privacy",
        },
        children: ["securityHelpText"],
      },
      securityHelpText: {
        type: "Text",
        props: { text: '"MFA status" · "audit log" · "my sessions"' },
        children: [],
      },
      adminHelp: {
        type: "Card",
        props: {
          title: "Admin",
          description: "Moderation, redemptions, and metrics",
        },
        children: ["adminHelpText"],
      },
      adminHelpText: {
        type: "Text",
        props: { text: '"admin overview" · "manage users" · "redemptions"' },
        children: [],
      },
    },
    state: {},
  };
}

// ── User message handlers ──────────────────────────────────────────

async function handleAuthError(ctx: AgentContext): Promise<AgentResult | null> {
  if (!ctx.isAuthenticated) {
    return {
      text: "You need to be signed in to use that. Please log in first.",
      spec: null,
    };
  }
  return null;
}

async function handleListAgents(ctx: AgentContext): Promise<AgentResult> {
  const authErr = await handleAuthError(ctx);
  if (authErr) return authErr;
  try {
    const agents = await fetchAgents();
    if (agents.length === 0) {
      const spec = buildAgentFormSpec();
      return {
        text: "You don't have any agents yet. Let's create one! Fill in the form below to create and deploy a new agent.",
        spec,
      };
    }
    const spec = buildAgentsSpec(agents);
    return { text: `Found ${agents.length} agent(s).`, spec };
  } catch (err) {
    return {
      text: `Couldn't fetch agents: ${err instanceof Error ? err.message : "Unknown error"}`,
      spec: null,
    };
  }
}

async function handleAgentDetail(ctx: AgentContext): Promise<AgentResult> {
  const authErr = await handleAuthError(ctx);
  if (authErr) return authErr;
  try {
    const agents = await fetchAgents();
    if (agents.length === 0) {
      const spec = buildAgentFormSpec();
      return {
        text: "You don't have any agents yet. Let's create one! Fill in the form below to create and deploy a new agent.",
        spec,
      };
    }
    const first = agents[0];
    const detail = await fetchAgentDetail(first.id);
    const spec = buildAgentDetailSpec(detail);
    return { text: `Showing details for ${detail.agentName}.`, spec };
  } catch (err) {
    return {
      text: `Couldn't fetch agent details: ${err instanceof Error ? err.message : "Unknown error"}`,
      spec: null,
    };
  }
}

async function handleCreateAgent(_ctx: AgentContext): Promise<AgentResult> {
  const spec = buildAgentFormSpec();
  return {
    text: "I'll help you create a new agent. Fill in the form below.",
    spec,
  };
}

async function handleProvisionAgent(ctx: AgentContext): Promise<AgentResult> {
  const authErr = await handleAuthError(ctx);
  if (authErr) return authErr;
  try {
    const agents = await fetchAgents();
    if (agents.length === 0) {
      const spec = buildAgentFormSpec();
      return {
        text: "You don't have any agents yet. Let's create one! Fill in the form below to create and deploy a new agent.",
        spec,
      };
    }
    const ready = agents.filter(
      (a) =>
        a.status === "stopped" ||
        a.status === "pending" ||
        a.status === "error",
    );
    if (ready.length === 0) {
      if (agents.every((a) => a.status === "running")) {
        return {
          text: "All agents are already running. Select one to view details.",
          spec: null,
        };
      }
      return {
        text: "No agents available to deploy. Create one first.",
        spec: null,
      };
    }
    const target = ready[0];
    const result = await provisionAgent(target.id);
    const spec = buildDeployProgressSpec(
      target.id,
      target.agentName,
      result.jobId,
      result.queued || result.alreadyInProgress ? "provisioning" : "running",
      AGENT_ACTIONS,
    );
    return {
      text: result.alreadyInProgress
        ? `${target.agentName} is already being deployed.`
        : result.queued
          ? `Deployment queued for ${target.agentName}. This usually takes 2-5 minutes.`
          : `Deploying ${target.agentName}...`,
      spec,
    };
  } catch (err) {
    return {
      text: `Couldn't deploy: ${err instanceof Error ? err.message : "Unknown error"}`,
      spec: null,
    };
  }
}

async function handleBilling(_ctx: AgentContext): Promise<AgentResult> {
  const authErr = await handleAuthError(_ctx);
  if (authErr) return authErr;
  try {
    const billing = await fetchBilling();
    const spec = buildBillingSpec(billing.balance);
    return { text: `Your balance is ${fmtCredits(billing.balance)}.`, spec };
  } catch (err) {
    return {
      text: `Couldn't fetch billing: ${err instanceof Error ? err.message : "Unknown error"}`,
      spec: null,
    };
  }
}

async function handleTransactions(_ctx: AgentContext): Promise<AgentResult> {
  const authErr = await handleAuthError(_ctx);
  if (authErr) return authErr;
  try {
    const txns = await fetchTransactions();
    const spec = buildTransactionsSpec(txns);
    return { text: `Showing ${txns.length} recent transactions.`, spec };
  } catch (err) {
    return {
      text: `Couldn't fetch transactions: ${err instanceof Error ? err.message : "Unknown error"}`,
      spec: null,
    };
  }
}

async function handleInvoices(_ctx: AgentContext): Promise<AgentResult> {
  const authErr = await handleAuthError(_ctx);
  if (authErr) return authErr;
  try {
    const invoices = await fetchInvoices();
    const spec = buildInvoicesSpec(invoices);
    return { text: `Found ${invoices.length} invoice(s).`, spec };
  } catch (err) {
    return {
      text: `Couldn't fetch invoices: ${err instanceof Error ? err.message : "Unknown error"}`,
      spec: null,
    };
  }
}

async function handleListApiKeys(_ctx: AgentContext): Promise<AgentResult> {
  const authErr = await handleAuthError(_ctx);
  if (authErr) return authErr;
  try {
    const keys = await fetchApiKeys();
    const spec = buildApiKeysSpec(keys);
    return { text: `You have ${keys.length} API key(s).`, spec };
  } catch (err) {
    return {
      text: `Couldn't fetch API keys: ${err instanceof Error ? err.message : "Unknown error"}`,
      spec: null,
    };
  }
}

async function handleListApps(_ctx: AgentContext): Promise<AgentResult> {
  const authErr = await handleAuthError(_ctx);
  if (authErr) return authErr;
  try {
    const apps = await fetchApps();
    const spec = buildAppsSpec(apps);
    return { text: `You have ${apps.length} app(s).`, spec };
  } catch (err) {
    return {
      text: `Couldn't fetch apps: ${err instanceof Error ? err.message : "Unknown error"}`,
      spec: null,
    };
  }
}

async function handleAnalytics(_ctx: AgentContext): Promise<AgentResult> {
  const authErr = await handleAuthError(_ctx);
  if (authErr) return authErr;
  try {
    const analytics = await fetchAnalytics();
    const spec = buildAnalyticsSpec(analytics);
    return { text: "Here's your analytics overview.", spec };
  } catch (err) {
    return {
      text: `Couldn't fetch analytics: ${err instanceof Error ? err.message : "Unknown error"}`,
      spec: null,
    };
  }
}

async function handleProjections(_ctx: AgentContext): Promise<AgentResult> {
  const authErr = await handleAuthError(_ctx);
  if (authErr) return authErr;
  try {
    const projections = await fetchProjections();
    const spec = buildProjectionsSpec(projections);
    return { text: "Here are your cost projections.", spec };
  } catch (err) {
    return {
      text: `Couldn't fetch projections: ${err instanceof Error ? err.message : "Unknown error"}`,
      spec: null,
    };
  }
}

async function handleHealth(ctx: AgentContext): Promise<AgentResult> {
  const authErr = await handleAuthError(ctx);
  if (authErr) return authErr;
  try {
    const agents = await fetchAgents();
    const billing = await fetchBilling();
    const spec = buildHealthSpec(agents, billing.balance);
    const healthy = agents.filter((a) => a.status === "running").length;
    const total = agents.length;
    return {
      text: `System health: ${healthy}/${total} agents running. Balance: ${fmtCredits(billing.balance)}.`,
      spec,
    };
  } catch (err) {
    return {
      text: `Couldn't fetch health data: ${err instanceof Error ? err.message : "Unknown error"}`,
      spec: null,
    };
  }
}

async function handleProfile(_ctx: AgentContext): Promise<AgentResult> {
  const authErr = await handleAuthError(_ctx);
  if (authErr) return authErr;
  try {
    const user = await fetchUserProfile();
    const spec = buildProfileSpec(user);
    return {
      text: `Here's your profile, ${user.displayName ?? user.username ?? "there"}.`,
      spec,
    };
  } catch (err) {
    return {
      text: `Couldn't fetch profile: ${err instanceof Error ? err.message : "Unknown error"}`,
      spec: null,
    };
  }
}

async function handleOrganizations(_ctx: AgentContext): Promise<AgentResult> {
  const authErr = await handleAuthError(_ctx);
  if (authErr) return authErr;
  try {
    const user = await fetchUserProfile();
    const members = await fetchOrgMembers();
    const spec: UiSpec = {
      root: "root",
      elements: {
        root: {
          type: "Stack",
          props: { gap: "lg" },
          children: ["heading", "orgCard", "membersHeading", "membersTable"],
        },
        heading: {
          type: "Heading",
          props: { text: "Organization" },
          children: [],
        },
        orgCard: {
          type: "Card",
          props: {
            title: user.organization?.name ?? "Personal Account",
          },
          children: ["orgText"],
        },
        orgText: {
          type: "Text",
          props: {
            text: user.organization
              ? `Slug: ${user.organization.slug}`
              : "You are not part of an organization.",
          },
          children: [],
        },
        membersHeading: {
          type: "Heading",
          props: { text: `Team Members (${members.length})` },
          children: [],
        },
        membersTable: {
          type: "Table",
          props: {
            columns: [
              { header: "Email", accessor: "email" },
              { header: "Role", accessor: "role" },
              { header: "Joined", accessor: "joined" },
            ],
            rows: members.map((m) => ({
              email: m.email ?? "—",
              role: m.role ?? "member",
              joined: m.joinedAt
                ? new Date(m.joinedAt).toLocaleDateString()
                : "—",
            })),
          },
          children: [],
        },
      },
      state: {},
    };
    return {
      text: user.organization
        ? `Organization: ${user.organization.name}, ${members.length} member(s).`
        : "Personal account — no organization.",
      spec,
    };
  } catch (err) {
    return {
      text: `Couldn't fetch organization info: ${err instanceof Error ? err.message : "Unknown error"}`,
      spec: null,
    };
  }
}

async function handleSecurity(_ctx: AgentContext): Promise<AgentResult> {
  const authErr = await handleAuthError(_ctx);
  if (authErr) return authErr;
  try {
    const mfa = await fetchMfaStatus();
    const spec = buildSecuritySpec(mfa);
    return {
      text: mfa.enabled
        ? "MFA is enabled on your account."
        : "MFA is not yet enabled.",
      spec,
    };
  } catch (err) {
    return {
      text: `Couldn't fetch security info: ${err instanceof Error ? err.message : "Unknown error"}`,
      spec: null,
    };
  }
}

async function handleAuditLog(_ctx: AgentContext): Promise<AgentResult> {
  const authErr = await handleAuthError(_ctx);
  if (authErr) return authErr;
  try {
    const events = await fetchAuditEvents();
    const spec = buildAuditSpec(events);
    return { text: `Found ${events.length} recent audit event(s).`, spec };
  } catch (err) {
    return {
      text: `Couldn't fetch audit log: ${err instanceof Error ? err.message : "Unknown error"}`,
      spec: null,
    };
  }
}

async function handleConnectors(_ctx: AgentContext): Promise<AgentResult> {
  const authErr = await handleAuthError(_ctx);
  if (authErr) return authErr;
  try {
    const connectorNames = ["telegram", "whatsapp", "twilio", "blooio"];
    const results = await Promise.all(
      connectorNames.map(async (name) => {
        const status = await fetchConnectorStatus(name);
        return { name, ...status };
      }),
    );
    const spec = buildConnectorsSpec(results);
    const connected = results.filter((r) => r.connected).length;
    return {
      text: `${connected}/${results.length} connectors connected.`,
      spec,
    };
  } catch (err) {
    return {
      text: `Couldn't fetch connector status: ${err instanceof Error ? err.message : "Unknown error"}`,
      spec: null,
    };
  }
}

async function handleMcps(_ctx: AgentContext): Promise<AgentResult> {
  const authErr = await handleAuthError(_ctx);
  if (authErr) return authErr;
  try {
    const mcps = await fetchMcps();
    const spec = buildMcpSpec(mcps);
    return { text: `Found ${mcps.length} MCP server(s).`, spec };
  } catch (err) {
    return {
      text: `Couldn't fetch MCPs: ${err instanceof Error ? err.message : "Unknown error"}`,
      spec: null,
    };
  }
}

async function handlePlugins(ctx: AgentContext): Promise<AgentResult> {
  const authErr = await handleAuthError(ctx);
  if (authErr) return authErr;
  try {
    const agents = await fetchAgents();
    if (agents.length === 0) {
      return {
        text: "No agents to manage plugins for. Create an agent first.",
        spec: null,
      };
    }
    const first = agents[0];
    const _detail = await fetchAgentDetail(first.id);
    const samplePlugins = [
      {
        id: "discord",
        name: "Discord",
        enabled: true,
        description: "Connect to Discord",
      },
      {
        id: "telegram",
        name: "Telegram",
        enabled: true,
        description: "Telegram messaging",
      },
      {
        id: "twitter",
        name: "Twitter/X",
        enabled: false,
        description: "Post & reply on X",
      },
      {
        id: "web-search",
        name: "Web Search",
        enabled: true,
        description: "Search the web",
      },
      {
        id: "knowledge-base",
        name: "Knowledge Base",
        enabled: true,
        description: "Document Q&A",
      },
      {
        id: "image-gen",
        name: "Image Generation",
        enabled: false,
        description: "Generate images",
      },
    ];
    const spec = buildPluginSpec(first.id, first.agentName, samplePlugins);
    return {
      text: `Hosted managed plugins for ${first.agentName}. Toggle plugins on/off below.`,
      spec,
    };
  } catch (err) {
    return {
      text: `Error: ${err instanceof Error ? err.message : "Unknown"}`,
      spec: null,
    };
  }
}

async function handleApiExplorer(_ctx: AgentContext): Promise<AgentResult> {
  const authErr = await handleAuthError(_ctx);
  if (authErr) return authErr;
  const spec = buildApiExplorerSpec();
  return {
    text: "API Explorer — select a method, enter a path, and execute.",
    spec,
  };
}

async function handleAdminOverview(ctx: AgentContext): Promise<AgentResult> {
  if (!ctx.isAdmin) {
    return {
      text: "Admin access required.",
      spec: null,
    };
  }
  try {
    const data = await fetchAdminOverview();
    const overview = data.overview ?? {};
    const spec = buildAdminOverviewSpec(overview);
    return {
      text: `Admin overview: ${overview.totalUsers ?? "?"} users, ${overview.totalAgents ?? "?"} agents.`,
      spec,
    };
  } catch (err) {
    return {
      text: `Couldn't fetch admin data: ${err instanceof Error ? err.message : "Unknown error"}`,
      spec: null,
    };
  }
}

async function handleAdminRedemptions(ctx: AgentContext): Promise<AgentResult> {
  if (!ctx.isAdmin) {
    return { text: "Admin access required.", spec: null };
  }
  try {
    const redemptions = await fetchAdminRedemptions();
    const spec: UiSpec = {
      root: "root",
      elements: {
        root: {
          type: "Stack",
          props: { gap: "lg" },
          children: [
            "heading",
            redemptions.length > 0 ? "redemptionTable" : "empty",
          ],
        },
        heading: {
          type: "Heading",
          props: { text: `Redemptions (${redemptions.length})` },
          children: [],
        },
        redemptionTable: {
          type: "Table",
          props: {
            columns: [
              { header: "Code", accessor: "code" },
              { header: "Amount", accessor: "amount" },
              { header: "Uses", accessor: "uses" },
              { header: "Max Uses", accessor: "maxUses" },
              { header: "Active", accessor: "active" },
              { header: "Expires", accessor: "expires" },
            ],
            rows: redemptions.map((r) => ({
              code: r.code ?? "—",
              amount: r.amount != null ? `$${r.amount}` : "—",
              uses: String(r.uses ?? 0),
              maxUses: String(r.maxUses ?? "∞"),
              active: r.isActive ? "Yes" : "No",
              expires: r.expiresAt
                ? new Date(r.expiresAt).toLocaleDateString()
                : "Never",
            })),
          },
          children: [],
        },
        empty: {
          type: "Text",
          props: { text: "No redemptions configured." },
          children: [],
        },
      },
      state: {},
    };
    return { text: `Found ${redemptions.length} redemption(s).`, spec };
  } catch (err) {
    return {
      text: `Couldn't fetch redemptions: ${err instanceof Error ? err.message : "Unknown error"}`,
      spec: null,
    };
  }
}

async function handleTopUp(_ctx: AgentContext): Promise<AgentResult> {
  const authErr = await handleAuthError(_ctx);
  if (authErr) return authErr;
  const spec: UiSpec = {
    root: "root",
    elements: {
      root: {
        type: "Stack",
        props: { gap: "lg", align: "center" },
        children: ["heading", "card"],
      },
      heading: {
        type: "Heading",
        props: { text: "Add Credits" },
        children: [],
      },
      card: {
        type: "Card",
        props: { title: "Purchase Credits", style: { maxWidth: 400 } },
        children: ["text", "btn"],
      },
      text: {
        type: "Text",
        props: {
          text: "Go to the billing section in your settings to add credits via credit/debit card or cryptocurrency.",
        },
        children: [],
      },
      btn: {
        type: "Button",
        props: { label: "Open Billing", action: "cloud.openBilling" },
        children: [],
        on: { click: { action: "cloud.openBilling" } },
      },
    },
    state: {},
  };
  return { text: "You can add credits from the billing settings.", spec };
}

// ── Proactive Cloud Assessment Engine ──────────────────────────────

interface CloudAssessment {
  auth: AgentContext;
  agents: Array<{
    id: string;
    agentName: string;
    status: string;
    lastHeartbeatAt?: string;
    webUiUrl?: string;
    errorMessage?: string;
  }>;
  containers: Array<{
    id: string;
    name: string;
    status: string;
    image?: string;
  }>;
  billing: { balance: number };
  connectorStatuses: Record<string, { connected: boolean; status?: string }>;
  mcps: Array<{ id: string; name: string; status?: string }>;
  apiKeys: Array<{ id: string; name: string; is_active: boolean }>;
  apps: Array<{ id: string; name: string; deployment_status: string }>;
}

interface CloudStep {
  id: string;
  priority: number; // 1 = critical, 2 = important, 3 = nice-to-have
  title: string;
  description: string;
  action: string;
  actionLabel: string;
  status: "done" | "ready" | "blocked" | "optional";
}

async function assessCloudState(ctx: AgentContext): Promise<CloudAssessment> {
  // Fetch everything in parallel for speed
  const [
    agents,
    containers,
    billing,
    apiKeys,
    apps,
    mcps,
    discord,
    telegram,
    twitter,
  ] = await Promise.allSettled([
    fetchAgents(),
    fetchContainers(),
    fetchBilling(),
    fetchApiKeys(),
    fetchApps(),
    fetchMcps(),
    fetchConnectorStatus("discord"),
    fetchConnectorStatus("telegram"),
    fetchConnectorStatus("twitter"),
  ]);

  return {
    auth: ctx,
    agents: agents.status === "fulfilled" ? agents.value : [],
    containers: containers.status === "fulfilled" ? containers.value : [],
    billing: billing.status === "fulfilled" ? billing.value : { balance: 0 },
    apiKeys: apiKeys.status === "fulfilled" ? apiKeys.value : [],
    apps: apps.status === "fulfilled" ? apps.value : [],
    mcps: mcps.status === "fulfilled" ? mcps.value : [],
    connectorStatuses: {
      discord:
        discord.status === "fulfilled" ? discord.value : { connected: false },
      telegram:
        telegram.status === "fulfilled" ? telegram.value : { connected: false },
      twitter:
        twitter.status === "fulfilled" ? twitter.value : { connected: false },
    },
  };
}

function deriveSteps(state: CloudAssessment): CloudStep[] {
  const steps: CloudStep[] = [];
  const hasCredits = state.billing.balance > 1;
  const hasAgents = state.agents.length > 0;
  const runningAgents = state.agents.filter((a) => a.status === "running");
  const stoppedAgents = state.agents.filter((a) =>
    ["stopped", "error", "disconnected"].includes(a.status),
  );
  const hasContainers = state.containers.length > 0;
  const connectedPlatforms = Object.entries(state.connectorStatuses).filter(
    ([, v]) => v.connected,
  );
  const safeApiKeys = Array.isArray(state.apiKeys) ? state.apiKeys : [];
  const hasApiKeys = safeApiKeys.filter((k) => k.is_active).length > 0;
  const hasApps = state.apps.length > 0;
  const hasMcps = state.mcps.length > 0;

  // 1. Credits — can't do anything without them
  steps.push({
    id: "credits",
    priority: 1,
    title: hasCredits
      ? `Credits: ${fmtCredits(state.billing.balance)}`
      : "Add Credits",
    description: hasCredits
      ? `You have ${fmtCredits(state.billing.balance)} available. ${
          state.billing.balance < 10
            ? "Consider topping up for uninterrupted service."
            : "Looking good."
        }`
      : "You need credits to deploy and run agents, containers, and apps.",
    action: hasCredits ? "cloud.billing.balance" : "cloud.billing.topup",
    actionLabel: hasCredits
      ? state.billing.balance < 10
        ? "Top Up"
        : "View Balance"
      : "Add Credits",
    status: hasCredits ? "done" : "ready",
  });

  // 2. Deploy first agent — the primary use case
  if (!hasAgents) {
    steps.push({
      id: "first-agent",
      priority: 1,
      title: "Deploy Your First Agent",
      description:
        "Create a 24/7 persisted agent runtime. Choose a character, pick a tier, and deploy — your agent runs even when you close the browser.",
      action: "cloud.agent.showCreateForm",
      actionLabel: "Create Agent",
      status: hasCredits ? "ready" : "blocked",
    });
  } else {
    steps.push({
      id: "agents-status",
      priority: 2,
      title: `Agents: ${runningAgents.length} running, ${stoppedAgents.length} stopped`,
      description:
        runningAgents.length > 0
          ? `${runningAgents.map((a) => a.agentName).join(", ")} ${runningAgents.length === 1 ? "is" : "are"} live.${
              stoppedAgents.length > 0
                ? ` ${stoppedAgents.length} agent(s) stopped — resume them?`
                : ""
            }`
          : `All ${state.agents.length} agent(s) are stopped. Resume one to get back online.`,
      action: "cloud.agent.refresh",
      actionLabel: stoppedAgents.length > 0 ? "Manage Agents" : "View Agents",
      status: runningAgents.length > 0 ? "done" : "ready",
    });
  }

  // 3. Containers
  if (!hasContainers && hasAgents) {
    steps.push({
      id: "containers",
      priority: 3,
      title: "Deploy Containers",
      description:
        "Run custom Docker workloads alongside your agents — coding sandboxes, databases, microservices, or full apps.",
      action: "cloud.containers.list",
      actionLabel: "Deploy Container",
      status: "optional",
    });
  } else if (hasContainers) {
    const runningC = state.containers.filter((c) => c.status === "running");
    steps.push({
      id: "containers",
      priority: 3,
      title: `Containers: ${runningC.length}/${state.containers.length} running`,
      description: `${state.containers.length} container(s) deployed.`,
      action: "cloud.containers.list",
      actionLabel: "View Containers",
      status: "done",
    });
  }

  // 4. Connect platforms
  if (connectedPlatforms.length === 0 && hasAgents) {
    steps.push({
      id: "connectors",
      priority: 2,
      title: "Connect Platforms",
      description:
        "Wire your agents to Discord, Telegram, Twitter, or Slack so people can interact with them.",
      action: "cloud.connectors.list",
      actionLabel: "Set Up Connectors",
      status: "ready",
    });
  } else if (connectedPlatforms.length > 0) {
    steps.push({
      id: "connectors",
      priority: 3,
      title: `Connected: ${connectedPlatforms.map(([p]) => p).join(", ")}`,
      description: `${connectedPlatforms.length}/3 platforms connected.`,
      action: "cloud.connectors.list",
      actionLabel: "Manage Connectors",
      status: "done",
    });
  }

  // 5. API Keys
  if (!hasApiKeys && hasAgents) {
    steps.push({
      id: "api-keys",
      priority: 2,
      title: "Create API Keys",
      description:
        "Generate API keys to access your agents programmatically from mobile apps, desktops, or third-party services.",
      action: "cloud.apikey.create",
      actionLabel: "Create Key",
      status: "ready",
    });
  } else if (hasApiKeys) {
    steps.push({
      id: "api-keys",
      priority: 3,
      title: `API Keys: ${safeApiKeys.filter((k) => k.is_active).length} active`,
      description: "Your API keys are set up.",
      action: "cloud.apikey.list",
      actionLabel: "Manage Keys",
      status: "done",
    });
  }

  // 6. MCP Servers
  if (!hasMcps && hasAgents) {
    steps.push({
      id: "mcps",
      priority: 3,
      title: "Configure MCP Servers",
      description:
        "Extend your agents with MCP tool servers — give them access to databases, APIs, file systems, and more.",
      action: "cloud.mcps.list",
      actionLabel: "Browse MCPs",
      status: "optional",
    });
  } else if (hasMcps) {
    steps.push({
      id: "mcps",
      priority: 3,
      title: `MCP Servers: ${state.mcps.length} configured`,
      description: `${state.mcps.map((m) => m.name).join(", ")}`,
      action: "cloud.mcps.list",
      actionLabel: "Manage MCPs",
      status: "done",
    });
  }

  // 7. Apps / Whitelabel
  if (!hasApps && hasAgents && runningAgents.length > 0) {
    steps.push({
      id: "apps",
      priority: 3,
      title: "Publish an App",
      description:
        "Package your agent as a monetizable app with custom branding, domains, and billing.",
      action: "cloud.apps.list",
      actionLabel: "Create App",
      status: "optional",
    });
  } else if (hasApps) {
    steps.push({
      id: "apps",
      priority: 3,
      title: `Apps: ${state.apps.length} published`,
      description: state.apps
        .map((a) => `${a.name} (${a.deployment_status})`)
        .join(", "),
      action: "cloud.apps.list",
      actionLabel: "Manage Apps",
      status: "done",
    });
  }

  // Sort by priority then status (ready first, then done, then optional)
  const statusOrder: Record<string, number> = {
    blocked: 0,
    ready: 1,
    optional: 2,
    done: 3,
  };
  steps.sort(
    (a, b) =>
      a.priority - b.priority ||
      (statusOrder[a.status] ?? 99) - (statusOrder[b.status] ?? 99),
  );

  return steps;
}

function buildAssessmentSpec(
  _state: CloudAssessment,
  steps: CloudStep[],
  greeting: string,
): UiSpec {
  const completedCount = steps.filter((s) => s.status === "done").length;
  const totalCount = steps.length;
  const readinessPercent =
    totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;
  const nextAction = steps.find(
    (s) => s.status === "ready" || s.status === "optional",
  );

  const elements: Record<string, any> = {
    root: {
      type: "Stack",
      props: { gap: "lg" },
      children: [
        "greeting",
        "readiness",
        "stepsList",
        ...(nextAction ? ["nextActionCta"] : []),
      ],
    },
    greeting: {
      type: "Text",
      props: { text: greeting },
      children: [],
    },
    readiness: {
      type: "Progress",
      props: {
        label: `Cloud Readiness: ${readinessPercent}%`,
        value: readinessPercent,
        max: 100,
      },
      children: [],
    },
    stepsList: {
      type: "Stack",
      props: { gap: "sm" },
      children: steps.map((s) => s.id),
    },
  };

  // Build each step as a card
  for (const step of steps) {
    const statusIcon =
      step.status === "done"
        ? "✓"
        : step.status === "blocked"
          ? "⊘"
          : step.status === "ready"
            ? "→"
            : "○";
    const statusColor =
      step.status === "done"
        ? "success"
        : step.status === "blocked"
          ? "error"
          : step.status === "ready"
            ? "warning"
            : "info";

    elements[step.id] = {
      type: "Stack",
      props: { gap: "xs", direction: "row", align: "start" },
      children: [`${step.id}_badge`, `${step.id}_content`, `${step.id}_btn`],
    };
    elements[`${step.id}_badge`] = {
      type: "Badge",
      props: {
        label: statusIcon,
        variant: statusColor,
      },
      children: [],
    };
    elements[`${step.id}_content`] = {
      type: "Stack",
      props: { gap: "xs" },
      children: [`${step.id}_title`, `${step.id}_desc`],
    };
    elements[`${step.id}_title`] = {
      type: "Text",
      props: { text: step.title, weight: "bold" },
      children: [],
    };
    elements[`${step.id}_desc`] = {
      type: "Text",
      props: { text: step.description, size: "sm" },
      children: [],
    };
    elements[`${step.id}_btn`] = {
      type: "Button",
      props: {
        label: step.actionLabel,
        variant: step.status === "ready" ? "default" : "outline",
        size: "sm",
        disabled: step.status === "blocked",
      },
      children: [],
      on: { click: { action: step.action } },
    };
  }

  if (nextAction) {
    elements.nextActionCta = {
      type: "Button",
      props: {
        label: `Next: ${nextAction.actionLabel}`,
        variant: "default",
      },
      children: [],
      on: { click: { action: nextAction.action } },
    };
  }

  return { root: "root", elements, state: {} };
}

async function runProactiveAssessment(
  ctx: AgentContext,
  personalGreeting: string,
  opts?: { includeIssues?: boolean },
): Promise<AgentResult> {
  const state = await assessCloudState(ctx);
  const steps = deriveSteps(state);
  const issues = detectIssues(state);
  const completedCount = steps.filter((s) => s.status === "done").length;
  const readyCount = steps.filter((s) => s.status === "ready").length;
  const nextAction = steps.find((s) => s.status === "ready");

  let textSummary = personalGreeting;

  // Proactively surface critical issues
  const criticalIssues = issues.filter((i) => i.severity === "critical");
  const warnings = issues.filter((i) => i.severity === "warning");

  if (criticalIssues.length > 0) {
    textSummary += "\n\n⚠️ **Issues detected:**";
    for (const issue of criticalIssues) {
      textSummary += `\n- 🔴 **${issue.area}**: ${issue.message} → ${issue.fix}`;
    }
  }

  if (opts?.includeIssues && warnings.length > 0) {
    if (criticalIssues.length === 0) textSummary += "\n";
    for (const issue of warnings) {
      textSummary += `\n- 🟡 **${issue.area}**: ${issue.message} → ${issue.fix}`;
    }
  }

  if (criticalIssues.length === 0) {
    if (completedCount === steps.length) {
      textSummary +=
        " Your cloud is fully set up — all systems operational. What would you like to work on?";
    } else if (readyCount > 0 && nextAction) {
      textSummary += ` Your cloud is ${Math.round((completedCount / steps.length) * 100)}% configured. Next step: **${nextAction.title}** — ${nextAction.description}`;
    } else if (completedCount === 0) {
      textSummary +=
        " Let's get your cloud set up. I'll walk you through each step.";
    }
  }

  const spec = buildAssessmentSpec(state, steps, "");
  return { text: textSummary, spec };
}

// ── Public API: initial canvas load assessment ─────────────────────

/**
 * Called on canvas mount to give the user an immediate, personalized
 * assessment of their cloud state. No user input required.
 */
export async function assessAndGreet(): Promise<AgentResult> {
  const ctx = await detectAuthContext();
  if (!ctx.isAuthenticated) {
    return {
      text: `Hey! I'm **${MIST_NAME}**, your cloud assistant. Sign in to get started — I'll help you deploy agents, manage keys, and keep everything running smooth.`,
      spec: null,
    };
  }
  const name = ctx.userEmail ? ctx.userEmail.split("@")[0] : "there";
  return runProactiveAssessment(
    ctx,
    `Welcome back, ${name}! ${MIST_NAME} here.`,
    { includeIssues: true },
  );
}

// ── handleUnknown (now falls through to proactive assessment) ──────

async function handleUnknown(
  ctx: AgentContext,
  text: string,
): Promise<AgentResult> {
  const lower = text.toLowerCase();

  // Greetings → proactive assessment with Mist's voice
  if (/(hi|hello|hey|good\s*(morning|afternoon|evening)|sup|yo)/i.test(lower)) {
    const name = ctx.userEmail ? ctx.userEmail.split("@")[0] : "there";
    return runProactiveAssessment(ctx, `Hey ${name}! ${MIST_NAME} here.`, {
      includeIssues: true,
    });
  }

  // Help / setup / get started → proactive assessment
  if (
    /(help|what can you|guide|tutorial|commands|capabilities|set\s*up|get\s*started|onboard|walk\s*me)/i.test(
      lower,
    )
  ) {
    return runProactiveAssessment(
      ctx,
      `I'm ${MIST_NAME} — here to help you navigate Eliza Cloud. Here's your current status and what to do next.`,
      { includeIssues: true },
    );
  }

  // General conversational prompt → Call LLM with Mist's system prompt
  try {
    const response = await fetch("/api/v1/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [
          { role: "system", content: MIST_SYSTEM_PROMPT },
          { role: "user", content: text },
        ],
        id: "nvidia/nemotron-3-ultra-550b-a55b:free",
      }),
    });

    if (response.ok && response.body) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let reply = "";
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith("0:")) {
            try {
              const textVal = JSON.parse(trimmed.slice(2));
              if (typeof textVal === "string") {
                reply += textVal;
              }
            } catch {}
          }
        }
      }

      if (reply.trim()) {
        return {
          text: reply,
          spec: null,
        };
      }
    }
  } catch (err) {
    console.error("[Mist] LLM fallback failed", err);
  }

  // Fallback to proactive assessment if LLM is unavailable
  return runProactiveAssessment(
    ctx,
    `I couldn't quite parse that one, but here's where things stand. You can ask me about agents, billing, API keys, connectors, containers — or just say "what should I do next?"`,
    { includeIssues: true },
  );
}

// ── Mist emotional intent handlers ─────────────────────────────────

async function handleConfused(ctx: AgentContext): Promise<AgentResult> {
  const name = ctx.userEmail ? ctx.userEmail.split("@")[0] : "there";
  const state = await assessCloudState(ctx);
  const issues = detectIssues(state);
  const steps = deriveSteps(state);
  const nextStep = steps.find((s) => s.status === "ready");

  let text = `No worries, ${name} — I've got you. I'm **${MIST_NAME}**, your cloud assistant. Let me break this down.\n\n`;

  text +=
    "**Eliza Cloud** is a platform for running AI agents 24/7. You can:\n";
  text +=
    "- 🤖 **Create agents** — autonomous AI personalities that run in the cloud\n";
  text += "- 🔑 **Manage API keys** — so apps can talk to your agents\n";
  text += "- 💳 **Add credits** — agents need credits to run\n";
  text +=
    "- 🔌 **Connect platforms** — wire agents to Discord, Telegram, Twitter\n";
  text += "- 📦 **Deploy containers** — run custom code alongside agents\n";

  if (issues.length > 0) {
    text += "\n**Right now, I see some things that need attention:**\n";
    for (const issue of issues.slice(0, 3)) {
      const icon =
        issue.severity === "critical"
          ? "🔴"
          : issue.severity === "warning"
            ? "🟡"
            : "💡";
      text += `- ${icon} ${issue.message} → ${issue.fix}\n`;
    }
  }

  if (nextStep) {
    text += `\n**Your next step:** ${nextStep.title} — ${nextStep.description}`;
  } else if (steps.every((s) => s.status === "done")) {
    text +=
      "\n✅ Everything looks good! Your cloud is fully set up. Ask me anything.";
  }

  const spec = buildAssessmentSpec(state, steps, "");
  return { text, spec };
}

async function handleFrustrated(ctx: AgentContext): Promise<AgentResult> {
  const name = ctx.userEmail ? ctx.userEmail.split("@")[0] : "there";
  const state = await assessCloudState(ctx);
  const issues = detectIssues(state);

  let text = `I hear you, ${name}. Let me run a quick diagnostic and figure out what's going wrong.\n\n`;

  if (issues.length === 0) {
    text +=
      "Actually, your cloud looks healthy — no critical issues detected. ";
    text += "Can you tell me more about what's not working? I'll dig in.\n\n";
    text += "Common things to check:\n";
    text += "- Is your agent actually deployed? (try: *show my agents*)\n";
    text += "- Do you have credits? (try: *show billing*)\n";
    text += "- Are your API keys set up? (try: *show API keys*)\n";
    text += "- Is the right plugin enabled? (try: *show plugins*)";
  } else {
    text += `I found **${issues.length} issue${issues.length > 1 ? "s" : ""}** that could be causing problems:\n\n`;
    for (const issue of issues) {
      const icon =
        issue.severity === "critical"
          ? "🔴"
          : issue.severity === "warning"
            ? "🟡"
            : "💡";
      text += `${icon} **${issue.area}**: ${issue.message}\n   → **Fix:** ${issue.fix}\n\n`;
    }
    const firstActionable = issues.find((i) => i.action);
    if (firstActionable) {
      text += `Let's start with the most critical one. I'd recommend: **${firstActionable.fix}**`;
    }
  }

  const steps = deriveSteps(state);
  const spec = buildAssessmentSpec(state, steps, "");
  return { text, spec };
}

async function handleIdentity(_ctx: AgentContext): Promise<AgentResult> {
  const text =
    `I'm **${MIST_NAME}** — the cloud ego of Eliza. Think of me as the part of Eliza that lives in the cloud and keeps everything running.\n\n` +
    `I can help you with:\n` +
    `- **Agents** — create, deploy, configure, and monitor AI agents\n` +
    `- **API Keys** — generate keys for programmatic access\n` +
    `- **Billing** — check credits, top up, view invoices\n` +
    `- **Connectors** — wire agents to Discord, Telegram, Twitter\n` +
    `- **Containers** — deploy Docker workloads\n` +
    `- **MCP Servers** — extend agents with tool servers\n` +
    `- **Security** — MFA, audit logs, sessions\n` +
    `- **Analytics** — usage stats and cost projections\n` +
    `- **Diagnostics** — I proactively detect config issues, credit problems, and broken plugins\n\n` +
    `I also handle the emotional stuff — if you're confused, stuck, or frustrated, just tell me. ` +
    `I'll figure out what's wrong and give you the exact next step.\n\n` +
    `Try saying: *"what should I do next?"* or *"check my setup"* or just ask anything.`;

  return { text, spec: null };
}

async function handleWhatNow(ctx: AgentContext): Promise<AgentResult> {
  const name = ctx.userEmail ? ctx.userEmail.split("@")[0] : "there";
  return runProactiveAssessment(
    ctx,
    `Great question, ${name}! Let me check your cloud and find the most impactful thing you can do right now.`,
    { includeIssues: true },
  );
}

async function handleDiagnose(ctx: AgentContext): Promise<AgentResult> {
  const name = ctx.userEmail ? ctx.userEmail.split("@")[0] : "there";
  const state = await assessCloudState(ctx);
  const issues = detectIssues(state);
  const steps = deriveSteps(state);

  let text = `Running full diagnostics, ${name}...\n\n`;

  // System overview
  const running = state.agents.filter((a) => a.status === "running").length;
  const total = state.agents.length;
  text += `**System Overview**\n`;
  text += `- Agents: ${running}/${total} running\n`;
  text += `- Credits: ${fmtCredits(state.billing.balance)}\n`;
  text += `- API Keys: ${(Array.isArray(state.apiKeys) ? state.apiKeys : []).filter((k) => k.is_active).length} active\n`;
  text += `- Containers: ${state.containers.length} deployed\n`;
  text += `- MCP Servers: ${state.mcps.length} configured\n`;
  const connectedPlatforms = Object.entries(state.connectorStatuses).filter(
    ([, v]) => v.connected,
  );
  text += `- Connectors: ${connectedPlatforms.length}/3 connected\n`;

  if (issues.length === 0) {
    text += `\n✅ **No issues detected.** Everything looks healthy.`;
  } else {
    text += `\n**Issues Found (${issues.length}):**\n\n`;
    for (const issue of issues) {
      const icon =
        issue.severity === "critical"
          ? "🔴 CRITICAL"
          : issue.severity === "warning"
            ? "🟡 WARNING"
            : "💡 INFO";
      text += `**${icon} — ${issue.area}**\n${issue.message}\n→ ${issue.fix}\n\n`;
    }
  }

  const spec = buildAssessmentSpec(state, steps, "");
  return { text, spec };
}

// ── Action handlers (for onAction button clicks) ───────────────────

async function handleActionAgentRefresh(): Promise<AgentResult> {
  try {
    const agents = await fetchAgents();
    const spec = buildAgentsSpec(agents);
    return { text: `Refreshed. Found ${agents.length} agent(s).`, spec };
  } catch (err) {
    return {
      text: `Couldn't refresh: ${err instanceof Error ? err.message : "Unknown"}`,
      spec: null,
    };
  }
}

async function handleActionAgentSelect(
  params?: Record<string, unknown>,
): Promise<AgentResult> {
  try {
    const agentId = (params?.id as string) ?? "";
    if (!agentId) {
      const agents = await fetchAgents();
      if (agents.length === 0) return { text: "No agents.", spec: null };
      const detail = await fetchAgentDetail(agents[0].id);
      return {
        text: `Showing ${detail.agentName}.`,
        spec: buildAgentDetailSpec(detail),
      };
    }
    const detail = await fetchAgentDetail(agentId);
    return {
      text: `Showing ${detail.agentName}.`,
      spec: buildAgentDetailSpec(detail),
    };
  } catch (err) {
    return {
      text: `Error: ${err instanceof Error ? err.message : "Unknown"}`,
      spec: null,
    };
  }
}

async function handleActionAgentProvision(
  params?: Record<string, unknown>,
): Promise<AgentResult> {
  try {
    const agentId = (params?.id as string) ?? "";
    if (!agentId) {
      const agents = await fetchAgents();
      const toProvision = agents.find(
        (a) =>
          a.status === "stopped" ||
          a.status === "pending" ||
          a.status === "error",
      );
      if (!toProvision) return { text: "No agents to deploy.", spec: null };
      const result = await provisionAgent(toProvision.id);
      return {
        text: `Deploying ${toProvision.agentName}...`,
        spec: buildDeployProgressSpec(
          toProvision.id,
          toProvision.agentName,
          result.jobId,
          "provisioning",
          AGENT_ACTIONS,
        ),
      };
    }
    const agents = await fetchAgents();
    const agent = agents.find((a) => a.id === agentId);
    if (!agent) return { text: "Agent not found.", spec: null };
    const result = await provisionAgent(agentId);
    return {
      text: `Deploying ${agent.agentName}...`,
      spec: buildDeployProgressSpec(
        agentId,
        agent.agentName,
        result.jobId,
        "provisioning",
        AGENT_ACTIONS,
      ),
    };
  } catch (err) {
    return {
      text: `Deploy failed: ${err instanceof Error ? err.message : "Unknown"}`,
      spec: null,
    };
  }
}

async function handleActionAgentResume(
  params?: Record<string, unknown>,
): Promise<AgentResult> {
  try {
    const agentId = (params?.id as string) ?? "";
    if (!agentId) return { text: "No agent specified.", spec: null };
    const result = await resumeAgent(agentId);
    return {
      text: result.queued
        ? "Resume queued. This may take a moment."
        : "Agent resumed.",
      spec: null,
    };
  } catch (err) {
    return {
      text: `Resume failed: ${err instanceof Error ? err.message : "Unknown"}`,
      spec: null,
    };
  }
}

async function handleActionAgentSnapshot(
  params?: Record<string, unknown>,
): Promise<AgentResult> {
  try {
    const agentId = (params?.id as string) ?? "";
    if (!agentId) return { text: "No agent specified.", spec: null };
    const result = await snapshotAgent(agentId);
    return {
      text: result.jobId
        ? "Snapshot queued. This may take a moment."
        : "Snapshot saved.",
      spec: null,
    };
  } catch (err) {
    return {
      text: `Snapshot failed: ${err instanceof Error ? err.message : "Unknown"}`,
      spec: null,
    };
  }
}

async function handleActionAgentDelete(
  params?: Record<string, unknown>,
): Promise<AgentResult> {
  try {
    const agentId = (params?.id as string) ?? "";
    if (!agentId) return { text: "No agent specified.", spec: null };
    await deleteAgent(agentId);
    const agents = await fetchAgents();
    const spec = buildAgentsSpec(agents);
    return { text: "Agent deleted.", spec };
  } catch (err) {
    return {
      text: `Delete failed: ${err instanceof Error ? err.message : "Unknown"}`,
      spec: null,
    };
  }
}

async function handleActionSubmitCreate(
  params?: Record<string, unknown>,
): Promise<AgentResult> {
  try {
    const name =
      (params?.name as string) || (params?.agentName as string) || "agent";
    const flavor = (params?.flavor as string) || "eliza";
    const executionTier = (params?.executionTier as string) || "shared";
    const _description = (params?.description as string) || "";

    const createBody: Record<string, any> = {
      agentName: name,
      autoProvision: true,
    };

    if (executionTier === "dedicated") {
      let dockerImage = "ghcr.io/elizaos/eliza:stable";
      if (flavor === "eliza-develop") {
        dockerImage = "ghcr.io/elizaos/eliza:develop";
      }
      createBody.dockerImage = dockerImage;
    }

    const res = await api<{
      success: boolean;
      created?: boolean;
      source?: string;
      data?: {
        id?: string;
        agentId?: string;
        sandboxId?: string;
        jobId?: string;
        status?: string;
        executionTier?: string;
        estimatedCompletionAt?: string;
      };
    }>("/api/v1/eliza/agents", {
      method: "POST",
      json: createBody,
    });

    const agentId = res.data?.id ?? res.data?.agentId ?? res.data?.sandboxId;
    if (!agentId) {
      throw new Error("Failed to create agent: no ID returned");
    }

    if (
      res.data?.status === "running" ||
      res.source === "shared_runtime" ||
      res.source === "warm_pool"
    ) {
      const agents = await fetchAgents();
      const spec = buildAgentsSpec(agents);
      return {
        text: `Successfully created and deployed agent "${name}"!`,
        spec,
      };
    }

    const spec = buildDeployProgressSpec(
      agentId,
      name,
      res.data?.jobId ?? null,
      res.data?.status ?? "provisioning",
      AGENT_ACTIONS,
    );

    return {
      text: `Creating and deploying agent "${name}"...`,
      spec,
    };
  } catch (err) {
    return {
      text: `Create failed: ${err instanceof Error ? err.message : "Unknown"}`,
      spec: null,
    };
  }
}

async function handleActionShowCreateForm(): Promise<AgentResult> {
  const spec = buildAgentFormSpec();
  return {
    text: "Fill in the details below to create a new agent.",
    spec,
  };
}

async function handleActionApiKeyCreate(): Promise<AgentResult> {
  return {
    text: "To create an API key, go to Settings > API Keys. Tell me the name you want and I'll guide you.",
    spec: null,
  };
}

async function handleActionApiKeyRevoke(
  params?: Record<string, unknown>,
): Promise<AgentResult> {
  try {
    const keyId = (params?.id as string) ?? "";
    if (!keyId) return { text: "No key specified.", spec: null };
    await revokeApiKey(keyId);
    const keys = await fetchApiKeys();
    const spec = buildApiKeysSpec(keys);
    return { text: "API key revoked.", spec };
  } catch (err) {
    return {
      text: `Revoke failed: ${err instanceof Error ? err.message : "Unknown"}`,
      spec: null,
    };
  }
}

async function handleActionPlugins(
  params?: Record<string, unknown>,
): Promise<AgentResult> {
  try {
    const agentId = (params?.id as string) ?? "";
    if (!agentId) {
      const agents = await fetchAgents();
      if (agents.length === 0) return { text: "No agents.", spec: null };
      const first = agents[0];
      const samplePlugins = [
        {
          id: "discord",
          name: "Discord",
          enabled: true,
          description: "Connect to Discord",
        },
        {
          id: "telegram",
          name: "Telegram",
          enabled: true,
          description: "Telegram messaging",
        },
        {
          id: "twitter",
          name: "Twitter/X",
          enabled: false,
          description: "Post & reply on X",
        },
        {
          id: "web-search",
          name: "Web Search",
          enabled: true,
          description: "Search the web",
        },
        {
          id: "knowledge-base",
          name: "Knowledge Base",
          enabled: true,
          description: "Document Q&A",
        },
        {
          id: "image-gen",
          name: "Image Generation",
          enabled: false,
          description: "Generate images",
        },
      ];
      return {
        text: `Plugins for ${first.agentName}.`,
        spec: buildPluginSpec(first.id, first.agentName, samplePlugins),
      };
    }
    const agents = await fetchAgents();
    const agent = agents.find((a) => a.id === agentId) ?? agents[0];
    const samplePlugins = [
      {
        id: "discord",
        name: "Discord",
        enabled: true,
        description: "Connect to Discord",
      },
      {
        id: "telegram",
        name: "Telegram",
        enabled: true,
        description: "Telegram messaging",
      },
      {
        id: "twitter",
        name: "Twitter/X",
        enabled: false,
        description: "Post & reply on X",
      },
    ];
    return {
      text: `Plugins for ${agent.agentName}.`,
      spec: buildPluginSpec(agentId, agent.agentName, samplePlugins),
    };
  } catch (err) {
    return {
      text: `Error: ${err instanceof Error ? err.message : "Unknown"}`,
      spec: null,
    };
  }
}

async function handleActionPluginToggle(
  params?: Record<string, unknown>,
): Promise<AgentResult> {
  const pluginId = (params?.pluginId as string) ?? "";
  const enabled = params?.enabled as boolean;
  return {
    text: `${enabled ? "Enabled" : "Disabled"} plugin: ${pluginId}. Changes may require an agent restart to take effect.`,
    spec: null,
  };
}

async function handleActionApiExecuteTest(
  params?: Record<string, unknown>,
): Promise<AgentResult> {
  try {
    const method = (params?.method as string) ?? "GET";
    const path = (params?.path as string) ?? "/api/v1/eliza/agents";
    const bodyStr = params?.body as string;

    const fetchOpts: RequestInit = {
      method,
      headers: { "Content-Type": "application/json" },
      credentials: "include",
    };

    if (bodyStr?.trim() && method !== "GET") {
      fetchOpts.body = bodyStr;
    }

    const startTime = performance.now();
    const res = await fetch(path, fetchOpts);
    const elapsed = ((performance.now() - startTime) / 1000).toFixed(2);

    let responseBody: string;
    try {
      const json = await res.json();
      responseBody = JSON.stringify(json, null, 2);
    } catch {
      responseBody = await res.text().catch(() => "(empty response)");
    }

    const spec: UiSpec = {
      root: "root",
      elements: {
        root: {
          type: "Stack",
          props: { gap: "lg" },
          children: ["resultHeader", "resultMeta", "resultBody"],
        },
        resultHeader: {
          type: "Stack",
          props: { gap: "sm", direction: "row", align: "center" },
          children: ["resultStatus", "resultTime"],
        },
        resultStatus: {
          type: "Badge",
          props: {
            label: `${res.status} ${res.statusText}`,
            variant: res.ok ? "success" : "error",
          },
          children: [],
        },
        resultTime: {
          type: "Text",
          props: { text: `${elapsed}s` },
          children: [],
        },
        resultMeta: {
          type: "Text",
          props: { text: `${method} ${path}` },
          children: [],
        },
        resultBody: {
          type: "Card",
          props: { title: "Response Body" },
          children: ["resultBodyText"],
        },
        resultBodyText: {
          type: "Text",
          props: { text: responseBody.slice(0, 5000) },
          children: [],
        },
      },
      state: {},
    };

    return {
      text: `${method} ${path} → ${res.status} (${elapsed}s)`,
      spec,
    };
  } catch (err) {
    return {
      text: `Request failed: ${err instanceof Error ? err.message : "Unknown"}`,
      spec: null,
    };
  }
}

// ── Main handler (chat messages) ───────────────────────────────────

export async function processUserMessage(
  text: string,
  _history: CanvasMessage[],
): Promise<AgentResult> {
  const ctx = await detectAuthContext();
  const intent = parseIntent(text);

  try {
    switch (intent.type) {
      case "listAgents":
        return handleListAgents(ctx);
      case "agentDetail":
        return handleAgentDetail(ctx);
      case "createAgent":
        return handleCreateAgent(ctx);
      case "provisionAgent":
        return handleProvisionAgent(ctx);
      case "getBilling":
        return handleBilling(ctx);
      case "transactions":
        return handleTransactions(ctx);
      case "topUp":
        return handleTopUp(ctx);
      case "invoices":
        return handleInvoices(ctx);
      case "listApiKeys":
        return handleListApiKeys(ctx);
      case "createApiKey":
        return handleListApiKeys(ctx);
      case "listApps":
        return handleListApps(ctx);
      case "appDetail":
        return handleListApps(ctx);
      case "earnings":
        return handleEarnings(ctx);
      case "redeemRewards":
        return handleActionShowRedeemForm(ctx);
      case "analytics":
        return handleAnalytics(ctx);
      case "projections":
        return handleProjections(ctx);
      case "health":
        return handleHealth(ctx);
      case "profile":
        return handleProfile(ctx);
      case "organizations":
        return handleOrganizations(ctx);
      case "security":
        return handleSecurity(ctx);
      case "auditLog":
        return handleAuditLog(ctx);
      case "sessions":
        return handleListAgents(ctx);
      case "privacy":
        return handleListAgents(ctx);
      case "connectors":
        return handleConnectors(ctx);
      case "mcps":
        return handleMcps(ctx);
      case "plugins":
        return handlePlugins(ctx);
      case "apiExplorer":
        return handleApiExplorer(ctx);
      case "adminOverview":
        return handleAdminOverview(ctx);
      case "adminUsers":
        return handleAdminOverview(ctx);
      case "adminRedemptions":
        return handleAdminRedemptions(ctx);
      case "adminMetrics":
        return handleAdminMetrics(ctx);
      case "adminInfrastructure":
        return handleAdminInfrastructure(ctx);
      case "adminRpc":
        return handleAdminRpc(ctx);
      case "securityPermissions":
        return handleSecurityPermissions(ctx);
      case "documents":
        return handleDocuments(ctx);
      case "giveSuggestion":
        return {
          text: "Thanks for the suggestion! Use the Feedback form from the user menu, or just tell me and I'll note it down.",
          spec: null,
        };

      // Infrastructure intents
      case "containers":
        return handleContainers(ctx);
      case "domains":
        return handleDomains(ctx);
      case "remotePairing":
        return handleRemoteSessions(ctx);

      // Mist emotional/conversational intents
      case "confused":
        return handleConfused(ctx);
      case "frustrated":
        return handleFrustrated(ctx);
      case "identity":
        return handleIdentity(ctx);
      case "whatNow":
        return handleWhatNow(ctx);
      case "diagnose":
        return handleDiagnose(ctx);

      case "unknown":
        return handleUnknown(ctx, intent.text);
    }
  } catch (err) {
    return {
      text: `Something went wrong: ${err instanceof Error ? err.message : "Unknown error"}`,
      spec: null,
    };
  }
}

// ── Container API calls ────────────────────────────────────────────

async function fetchContainers() {
  try {
    const res =
      await api<
        Array<{
          id: string;
          name: string;
          status: string;
          image?: string;
          created_at?: string;
        }>
      >("/api/v1/containers");
    return res ?? [];
  } catch {
    return [];
  }
}

async function fetchContainerQuota() {
  try {
    const res = await api<{
      used: number;
      limit: number;
      creditRunway?: number;
    }>("/api/v1/containers/quota");
    return res;
  } catch {
    return { used: 0, limit: 5, creditRunway: 0 };
  }
}

async function fetchDomains() {
  try {
    const res = await api<{
      domains: Array<{
        id: string;
        domain: string;
        status: string;
        verified: boolean;
        sslStatus?: string;
        autoRenew?: boolean;
        resourceType?: string;
      }>;
    }>("/api/v1/domains");
    return res?.domains ?? [];
  } catch {
    return [];
  }
}

async function fetchRemoteSessions() {
  try {
    const res = await api<{
      sessions: Array<{
        id: string;
        status: string;
        deviceInfo?: string;
        createdAt?: string;
      }>;
    }>("/api/v1/remote/sessions");
    return res?.sessions ?? [];
  } catch {
    return [];
  }
}

async function createPairingCode(agentId: string) {
  const res = await fetch("/api/v1/remote/pair", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ agentId }),
  });
  const json = (await res.json().catch(() => ({}))) as {
    success?: boolean;
    data?: {
      code?: string;
      expiresAt?: string;
      sessionId?: string;
      status?: string;
    };
  };
  if (!res.ok || !json.success || !json.data) {
    throw new Error("Failed to create pairing code");
  }
  return json.data;
}

// ── Container intent handlers ──────────────────────────────────────

async function handleContainers(_ctx: AgentContext): Promise<AgentResult> {
  const containers = await fetchContainers();
  const quota = await fetchContainerQuota();

  return {
    text: `You have ${containers.length} container(s). Quota: ${quota.used}/${quota.limit} used.`,
    spec: {
      root: "root",
      elements: {
        root: {
          type: "Stack",
          props: { gap: "lg" },
          children: [
            "heading",
            "quotaCard",
            ...(containers.length > 0 ? ["list"] : ["empty"]),
          ],
        },
        heading: {
          type: "Heading",
          props: { text: `Containers (${containers.length})` },
          children: [],
        },
        quotaCard: {
          type: "ContainerQuotaGauge" as any,
          props: {
            title: "Container Quota",
            value: `${quota.used} / ${quota.limit}`,
            status: quota.used >= quota.limit ? "error" : "active",
            subtitle: quota.creditRunway
              ? `~${Math.floor(quota.creditRunway)} days runway`
              : undefined,
          },
          children: [],
        },
        list: {
          type: "Table",
          props: {
            columns: [
              { header: "Name", accessor: "name" },
              { header: "Status", accessor: "status" },
              { header: "Image", accessor: "image" },
            ],
            rows: containers.map((c) => ({
              name: c.name,
              status: c.status,
              image: c.image ? c.image.split("/").pop() : "—",
            })),
          },
          children: [],
        },
        empty: {
          type: "Text",
          props: {
            text: 'No containers deployed yet. Say "deploy a container" to get started.',
          },
          children: [],
        },
      },
      state: {},
    },
  };
}

async function handleDomains(_ctx: AgentContext): Promise<AgentResult> {
  const domains = await fetchDomains();

  return {
    text: `You have ${domains.length} managed domain(s).`,
    spec: {
      root: "root",
      elements: {
        root: {
          type: "Stack",
          props: { gap: "lg" },
          children: ["heading", ...(domains.length > 0 ? ["list"] : ["empty"])],
        },
        heading: {
          type: "Heading",
          props: { text: `Domains (${domains.length})` },
          children: [],
        },
        list: {
          type: "Table",
          props: {
            columns: [
              { header: "Domain", accessor: "domain" },
              { header: "Status", accessor: "status" },
              { header: "SSL", accessor: "ssl" },
              { header: "Verified", accessor: "verified" },
            ],
            rows: domains.map((d) => ({
              domain: d.domain,
              status: d.status,
              ssl: d.sslStatus ?? "—",
              verified: d.verified ? "✓" : "✗",
            })),
          },
          children: [],
        },
        empty: {
          type: "Text",
          props: {
            text: 'No domains yet. Say "add a domain" to register one.',
          },
          children: [],
        },
      },
      state: {},
    },
  };
}

async function handleRemoteSessions(_ctx: AgentContext): Promise<AgentResult> {
  const sessions = await fetchRemoteSessions();

  return {
    text: `You have ${sessions.length} active remote session(s).`,
    spec: {
      root: "root",
      elements: {
        root: {
          type: "Stack",
          props: { gap: "lg" },
          children: [
            "heading",
            "pairBtn",
            ...(sessions.length > 0 ? ["list"] : ["empty"]),
          ],
        },
        heading: {
          type: "Heading",
          props: { text: `Remote Sessions (${sessions.length})` },
          children: [],
        },
        pairBtn: {
          type: "Button",
          props: { label: "Pair New Device", variant: "default" },
          children: [],
          on: { click: { action: "cloud.remote.pair" } },
        },
        list: {
          type: "Table",
          props: {
            columns: [
              { header: "Session", accessor: "id" },
              { header: "Status", accessor: "status" },
              { header: "Device", accessor: "device" },
            ],
            rows: sessions.map((s) => ({
              id: idShort(s.id),
              status: s.status,
              device: s.deviceInfo ?? "Unknown",
            })),
          },
          children: [],
        },
        empty: {
          type: "Text",
          props: {
            text: 'No active sessions. Click "Pair New Device" to connect mobile or desktop.',
          },
          children: [],
        },
      },
      state: {},
    },
  };
}

// ── Container/domain/remote action handlers ────────────────────────

async function handleActionContainersList(): Promise<AgentResult> {
  const ctx = await detectAuthContext();
  return handleContainers(ctx);
}

async function handleActionContainerQuota(): Promise<AgentResult> {
  const quota = await fetchContainerQuota();
  return {
    text: `Container quota: ${quota.used}/${quota.limit} used. Credit runway: ~${Math.floor(quota.creditRunway ?? 0)} days.`,
    spec: null,
  };
}

async function handleActionContainerDeploy(
  params?: Record<string, unknown>,
): Promise<AgentResult> {
  const name = (params?.name as string) ?? "my-container";
  const image = (params?.image as string) ?? "";
  if (!image) {
    return {
      text: "Please specify a Docker image to deploy (e.g. `ghcr.io/elizaos/my-app:latest`).",
      spec: null,
    };
  }
  try {
    const res = await fetch("/api/v1/containers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ name, image }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(
        (data as { error?: string }).error ?? `HTTP ${res.status}`,
      );
    }
    return {
      text: `Container "${name}" deployed with image \`${image}\`. It will be provisioned shortly.`,
      spec: null,
    };
  } catch (err) {
    return {
      text: `Failed to deploy container: ${err instanceof Error ? err.message : "Unknown error"}`,
      spec: null,
    };
  }
}

async function handleActionDomainsList(): Promise<AgentResult> {
  const ctx = await detectAuthContext();
  return handleDomains(ctx);
}

async function handleActionRemotePair(
  params?: Record<string, unknown>,
): Promise<AgentResult> {
  const agents = await fetchAgents();
  let targetAgent = agents.find((a) => a.status === "running");

  const agentId = params?.agentId as string;
  if (agentId) {
    targetAgent = agents.find((a) => a.id === agentId);
  }

  if (!targetAgent) {
    return {
      text: "No running agents found. Deploy and start an agent first before pairing a device.",
      spec: null,
    };
  }

  try {
    const pairing = await createPairingCode(targetAgent.id);
    const code = pairing.code ?? "------";
    const agentName = targetAgent.agentName ?? "Agent";

    // We encode a custom elizaos deep link payload that connects to the specific agent:
    const deepLinkUrl = `elizaos://pair?code=${code}&agentId=${targetAgent.id}`;
    // Generate a high-contrast premium QR code via qrserver:
    const qrCodeUrl = `https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=${encodeURIComponent(
      deepLinkUrl,
    )}`;

    return {
      text: `Pairing code generated for agent "${agentName}": ${code}. Scan the QR code or enter this code in the app.`,
      spec: {
        root: "root",
        elements: {
          root: {
            type: "Stack",
            props: { gap: "lg", align: "center" },
            children: ["heading", "qrcode", "code", "expiry", "subtext"],
          },
          heading: {
            type: "Heading",
            props: { text: "Link Agent to Phone" },
            children: [],
          },
          qrcode: {
            type: "Image",
            props: {
              src: qrCodeUrl,
              alt: "Pairing QR Code",
            },
            children: [],
          },
          code: {
            type: "Heading",
            props: {
              text: code,
              level: 1,
            },
            children: [],
          },
          expiry: {
            type: "Text",
            props: {
              text: pairing.expiresAt
                ? `Expires: ${new Date(pairing.expiresAt).toLocaleTimeString()}`
                : "Code expires in 5 minutes",
            },
            children: [],
          },
          subtext: {
            type: "Text",
            props: {
              text: "Scan the QR code with your phone to link automatically, or enter the 6-digit code in the Eliza app.",
            },
            children: [],
          },
        },
        state: {},
      },
    };
  } catch (err) {
    return {
      text: `Failed to generate pairing code: ${err instanceof Error ? err.message : "Unknown error"}`,
      spec: null,
    };
  }
}

async function handleActionRemoteSessions(): Promise<AgentResult> {
  const ctx = await detectAuthContext();
  return handleRemoteSessions(ctx);
}

async function handleActionConnectorsList(): Promise<AgentResult> {
  const ctx = await detectAuthContext();
  return handleConnectors(ctx);
}

async function handleActionBillingBalance(): Promise<AgentResult> {
  const billing = await fetchBilling();
  return {
    text: `Your current credit balance is ${fmtCredits(billing.balance)}.`,
    spec: {
      root: "root",
      elements: {
        root: {
          type: "Stack",
          props: { gap: "md" },
          children: ["card", "topupBtn"],
        },
        card: {
          type: "CreditBalanceCard" as any,
          props: {
            title: "Credit Balance",
            value: fmtCredits(billing.balance),
            status:
              billing.balance > 5
                ? "active"
                : billing.balance > 0
                  ? "warning"
                  : "error",
          },
          children: [],
        },
        topupBtn: {
          type: "Button",
          props: { label: "Add Credits", variant: "default" },
          children: [],
          on: { click: { action: "cloud.billing.topup" } },
        },
      },
      state: {},
    },
  };
}

// ── Earnings & Payout Handlers ─────────────────────────────────────

interface BalanceData {
  balance: {
    totalEarned: number;
    availableBalance: number;
    pendingBalance: number;
    totalRedeemed: number;
    totalPending: number;
    totalConvertedToCredits: number;
  };
  bySource: Array<{
    source: "miniapp" | "agent" | "mcp";
    totalEarned: number;
    count: number;
  }>;
  recentEarnings: Array<{
    id: string;
    source: "miniapp" | "agent" | "mcp";
    sourceId: string;
    amount: number;
    description: string;
    createdAt: string;
  }>;
  limits: {
    minRedemptionUsd: number;
    maxSingleRedemptionUsd: number;
    userDailyLimitUsd: number;
    userHourlyLimitUsd: number;
  };
  eligibility: {
    canRedeem: boolean;
    reason?: string;
    cooldownEndsAt?: string;
    dailyLimitRemaining?: number;
  };
}

async function fetchEarningsBalance(): Promise<BalanceData> {
  const res = await api<BalanceData>("/api/v1/redemptions/balance");
  return res;
}

async function handleEarnings(_ctx: AgentContext): Promise<AgentResult> {
  const authErr = await handleAuthError(_ctx);
  if (authErr) return authErr;
  try {
    const balance = await fetchEarningsBalance();
    const spec = buildEarningsSpec(balance);
    return {
      text: `Your available rewards balance is ${fmtCredits(balance.balance.availableBalance)} (total earned: ${fmtCredits(balance.balance.totalEarned)}).`,
      spec,
    };
  } catch (err) {
    return {
      text: `Couldn't load earnings: ${err instanceof Error ? err.message : "Unknown error"}`,
      spec: null,
    };
  }
}

async function handleActionShowRedeemForm(
  _ctx?: AgentContext,
): Promise<AgentResult> {
  const authCtx = _ctx || (await detectAuthContext());
  const authErr = await handleAuthError(authCtx);
  if (authErr) return authErr;
  try {
    const balance = await fetchEarningsBalance();
    const spec = buildRedeemFormSpec(balance);
    return {
      text: `You have ${fmtCredits(balance.balance.availableBalance)} available to redeem. Choose a network and wallet to start the approval flow.`,
      spec,
    };
  } catch (err) {
    return {
      text: `Couldn't load redemption form: ${err instanceof Error ? err.message : "Unknown error"}`,
      spec: null,
    };
  }
}

async function handleActionSubmitRedeem(
  params?: Record<string, unknown>,
): Promise<AgentResult> {
  try {
    const amountStr = (params?.amount as string) || "0";
    const amount = parseFloat(amountStr);
    const network = (params?.network as string) || "base";
    const payoutAddress = (params?.payoutAddress as string) || "";

    if (Number.isNaN(amount) || amount <= 0) {
      throw new Error("Invalid redemption amount");
    }
    if (!payoutAddress) {
      throw new Error("Payout wallet address is required");
    }

    const pointsAmount = Math.round(amount * 100);

    const res = await api<{
      success: boolean;
      redemptionId?: string;
      message?: string;
      error?: string;
      quote?: {
        usdValue?: number;
        elizaAmount?: number;
        requiresReview?: boolean;
      };
    }>("/api/v1/redemptions", {
      method: "POST",
      json: {
        pointsAmount,
        network,
        payoutAddress,
      },
    });

    if (!res.success) {
      throw new Error(res.error || "Redemption request failed");
    }

    const requiresReview = res.quote?.requiresReview ?? amount > 1000;
    const status = requiresReview
      ? "Pending Admin Approval"
      : "Approved & Processing";
    const statusMessage = requiresReview
      ? "For security, redemptions greater than $1,000 require manual review. Our administrators will verify and process your transaction shortly."
      : `Your redemption request has been approved and is being processed on the ${network.toUpperCase()} network.`;

    const spec = buildRedeemStatusSpec({
      amount,
      network,
      payoutAddress,
      status,
      message: res.message || statusMessage,
    });

    return {
      text: `Redemption request submitted! Status: ${status}`,
      spec,
    };
  } catch (err) {
    return {
      text: `Redemption failed: ${err instanceof Error ? err.message : "Unknown error"}`,
      spec: null,
    };
  }
}

function buildEarningsSpec(balance: BalanceData): UiSpec {
  return {
    root: "root",
    elements: {
      root: {
        type: "Stack",
        props: { gap: "lg" },
        children: [
          "heading",
          "metricsGrid",
          "sourcesCard",
          "recentCard",
          "actionBtn",
        ],
      },
      heading: {
        type: "Heading",
        props: { text: "Earnings & Proceeds" },
        children: [],
      },
      metricsGrid: {
        type: "Grid",
        props: { columns: 3, gap: "md" },
        children: ["availableMetric", "earnedMetric", "redeemedMetric"],
      },
      availableMetric: {
        type: "Card",
        props: { title: "Available to Redeem" },
        children: ["availableValue"],
      },
      availableValue: {
        type: "Metric",
        props: {
          label: "Available",
          value: `$${balance.balance.availableBalance.toFixed(2)}`,
        },
        children: [],
      },
      earnedMetric: {
        type: "Card",
        props: { title: "Total Earned" },
        children: ["earnedValue"],
      },
      earnedValue: {
        type: "Metric",
        props: {
          label: "Lifetime Earned",
          value: `$${balance.balance.totalEarned.toFixed(2)}`,
        },
        children: [],
      },
      redeemedMetric: {
        type: "Card",
        props: { title: "Total Redeemed" },
        children: ["redeemedValue"],
      },
      redeemedValue: {
        type: "Metric",
        props: {
          label: "Redeemed",
          value: `$${balance.balance.totalRedeemed.toFixed(2)}`,
        },
        children: [],
      },
      sourcesCard: {
        type: "Card",
        props: { title: "Revenue by Source" },
        children: ["sourcesTable"],
      },
      sourcesTable: {
        type: "Table",
        props: {
          columns: [
            { header: "Source", accessor: "source" },
            { header: "Total Earned", accessor: "amount" },
            { header: "Count", accessor: "count" },
          ],
          rows: balance.bySource.map((s) => ({
            source:
              s.source === "miniapp"
                ? "Apps"
                : s.source === "agent"
                  ? "Agents"
                  : "MCPs",
            amount: `$${s.totalEarned.toFixed(2)}`,
            count: String(s.count),
          })),
        },
        children: [],
      },
      recentCard: {
        type: "Card",
        props: { title: "Recent Earnings" },
        children: ["recentTable"],
      },
      recentTable: {
        type: "Table",
        props: {
          columns: [
            { header: "Description", accessor: "desc" },
            { header: "Amount", accessor: "amount" },
            { header: "Date", accessor: "date" },
          ],
          rows: (balance.recentEarnings || []).map((e) => ({
            desc: e.description,
            amount: `+$${e.amount.toFixed(2)}`,
            date: new Date(e.createdAt).toLocaleDateString(),
          })),
        },
        children: [],
      },
      actionBtn: {
        type: "Button",
        props: {
          label: "Redeem Rewards for elizaOS",
          action: "cloud.earnings.showRedeemForm",
        },
        children: [],
        on: {
          click: {
            action: "cloud.earnings.showRedeemForm",
          },
        },
      },
    },
    state: {},
  };
}

function buildRedeemFormSpec(balance: BalanceData): UiSpec {
  const minRedemption = balance.limits?.minRedemptionUsd ?? 1.0;
  const maxRedemption = Math.min(
    balance.balance?.availableBalance ?? 0,
    balance.limits?.maxSingleRedemptionUsd ?? 1000.0,
  );

  return {
    root: "root",
    elements: {
      root: {
        type: "Stack",
        props: { gap: "lg" },
        children: ["heading", "infoCard", "formStack"],
      },
      heading: {
        type: "Heading",
        props: { text: "Token Redemption Request" },
        children: [],
      },
      infoCard: {
        type: "Card",
        props: { title: "Available Rewards" },
        children: ["balanceText"],
      },
      balanceText: {
        type: "Text",
        props: {
          text: `You have $${(balance.balance?.availableBalance ?? 0).toFixed(2)} USD available to redeem. Redemptions are paid in elizaOS tokens to your wallet.`,
        },
        children: [],
      },
      formStack: {
        type: "Stack",
        props: { gap: "md" },
        children: [
          "amountField",
          "networkField",
          "addressField",
          "submitBtn",
          "cancelBtn",
        ],
      },
      amountField: {
        type: "Input",
        props: {
          label: `Amount to Redeem (USD) — Min $${minRedemption.toFixed(2)}, Max $${maxRedemption.toFixed(2)}`,
          placeholder: "Enter amount",
          statePath: "amount",
        },
        children: [],
      },
      networkField: {
        type: "Select",
        props: {
          label: "Select Payout Network",
          statePath: "network",
          placeholder: "Choose a network...",
          options: [
            { label: "Base (EVM)", value: "base" },
            { label: "Solana", value: "solana" },
            { label: "Ethereum (EVM)", value: "ethereum" },
            { label: "BNB Chain", value: "bnb" },
          ],
        },
        children: [],
      },
      addressField: {
        type: "Input",
        props: {
          label: "Payout Wallet Address",
          placeholder: "Enter address on the chosen network",
          statePath: "payoutAddress",
        },
        children: [],
      },
      submitBtn: {
        type: "Button",
        props: {
          label: "Request Payout",
          action: "cloud.earnings.submitRedeem",
        },
        children: [],
        on: {
          click: {
            action: "cloud.earnings.submitRedeem",
          },
        },
      },
      cancelBtn: {
        type: "Button",
        props: {
          label: "Cancel",
          action: "cloud.earnings.cancel",
        },
        children: [],
        on: {
          click: {
            action: "cloud.earnings.cancel",
          },
        },
      },
    },
    state: {},
  };
}

function buildRedeemStatusSpec(statusData: {
  amount: number;
  network: string;
  payoutAddress: string;
  status: string;
  message: string;
}): UiSpec {
  return {
    root: "root",
    elements: {
      root: {
        type: "Stack",
        props: { gap: "lg" },
        children: ["heading", "statusCard", "messageText", "doneBtn"],
      },
      heading: {
        type: "Heading",
        props: { text: "Payout Request Submitted" },
        children: [],
      },
      statusCard: {
        type: "Card",
        props: { title: "Approval Status Details" },
        children: ["detailsTable"],
      },
      detailsTable: {
        type: "Table",
        props: {
          columns: [
            { header: "Parameter", accessor: "key" },
            { header: "Value", accessor: "val" },
          ],
          rows: [
            { key: "Amount", val: `$${statusData.amount.toFixed(2)} USD` },
            { key: "Network", val: statusData.network.toUpperCase() },
            { key: "Wallet Address", val: statusData.payoutAddress },
            { key: "Status", val: statusData.status },
          ],
        },
        children: [],
      },
      messageText: {
        type: "Text",
        props: { text: statusData.message },
        children: [],
      },
      doneBtn: {
        type: "Button",
        props: {
          label: "Back to Earnings",
          action: "cloud.earnings.cancel",
        },
        children: [],
        on: {
          click: {
            action: "cloud.earnings.cancel",
          },
        },
      },
    },
    state: {},
  };
}

// ── Action dispatch (for onAction button clicks) ───────────────────

export async function processAction(
  action: string,
  params?: Record<string, unknown>,
): Promise<AgentResult | null> {
  const name = action.replace("cloud.", "");

  switch (name) {
    // Agent actions
    case "agent.refresh":
      return handleActionAgentRefresh();
    case "agent.select":
      return handleActionAgentSelect(params);
    case "agent.provision":
      return handleActionAgentProvision(params);
    case "agent.resume":
      return handleActionAgentResume(params);
    case "agent.snapshot":
      return handleActionAgentSnapshot(params);
    case "agent.delete":
      return handleActionAgentDelete(params);
    case "agent.submitCreate":
      return handleActionSubmitCreate(params);
    case "agent.showCreateForm":
      return handleActionShowCreateForm();
    case "agent.cancel":
      return { text: "Cancelled.", spec: null };
    case "agent.plugins":
      return handleActionPlugins(params);
    case "agent.pluginToggle":
      return handleActionPluginToggle(params);

    // API key actions
    case "apikey.create":
      return handleActionApiKeyCreate();
    case "apikey.revoke":
      return handleActionApiKeyRevoke(params);
    case "api.executeTest":
      return handleActionApiExecuteTest(params);

    // Security/permissions actions
    case "security.revokeGrant":
      return handleActionSecurityRevokeGrant(params);

    // Documents actions
    case "documents.upload":
      return handleActionDocumentsUpload(params);
    case "documents.delete":
      return handleActionDocumentsDelete(params);

    // Container actions
    case "containers.list":
      return handleActionContainersList();
    case "containers.deploy":
      return handleActionContainerDeploy(params);
    case "containers.quota":
      return handleActionContainerQuota();

    // Domain actions
    case "domains.list":
      return handleActionDomainsList();

    // Remote & sync actions
    case "remote.pair":
      return handleActionRemotePair(params);
    case "remote.sessions":
      return handleActionRemoteSessions();

    // Connector actions
    case "connectors.list":
      return handleActionConnectorsList();

    // Billing actions
    case "billing.balance":
      return handleActionBillingBalance();

    // Earnings actions
    case "earnings.showRedeemForm":
      return handleActionShowRedeemForm();
    case "earnings.submitRedeem":
      return handleActionSubmitRedeem(params);
    case "earnings.cancel": {
      const authCtx = await detectAuthContext();
      return handleEarnings(authCtx);
    }

    default:
      return null;
  }
}

// ── API Fetch Functions ───────────────────────────────────────────

async function fetchAdminWarmPool() {
  try {
    const res = await api<{
      success: boolean;
      data: {
        enabled: boolean;
        minPoolSize: number;
        maxPoolSize: number;
        image: string;
        size: {
          ready: number;
          provisioning: number;
          onCurrentImage: number;
          stale: number;
        };
        forecast: { predictedRate: number; targetPoolSize: number };
        policy: {
          forecastWindowHours: number;
          emaAlpha: number;
          idleScaleDownMs: number;
          replenishBurstLimit: number;
        };
      };
    }>("/api/v1/admin/warm-pool");
    return res.data;
  } catch {
    return null;
  }
}

async function fetchAdminInfraContainers() {
  try {
    const res = await api<{
      containers: Array<{
        id: string;
        name: string;
        status: string;
        image?: string;
        created_at?: string;
      }>;
      total: number;
    }>("/api/v1/admin/infrastructure/containers");
    return res;
  } catch {
    return { containers: [], total: 0 };
  }
}

async function fetchAdminMetrics(view: string = "overview") {
  try {
    const res = await api<any>(`/api/v1/admin/metrics?view=${view}`);
    return res;
  } catch {
    return null;
  }
}

async function fetchAdminRpcStatus() {
  try {
    const res = await api<{
      success: boolean;
      data: {
        evm: Array<{
          network: string;
          chainId: number;
          rpcUrl: string;
          reachable: boolean;
          latencyMs: number | null;
          latestBlock: string | null;
          hotWalletBalance: number | null;
          error: string | null;
        }>;
        solana: { rpcUrl: string; configured: boolean };
        allReachable: boolean;
        hotWalletAddress: string | null;
        checkedAt: string;
      };
    }>("/api/admin/rpc-status");
    return res.data;
  } catch {
    return null;
  }
}

interface PluginGrant {
  grant_id: string;
  plugin_id: string;
  plugin_name?: string | null;
  permission: string;
  scope?: string | null;
  granted_at: string;
  last_used?: string | null;
}

async function fetchPluginGrants() {
  try {
    const res = await api<{ grants: PluginGrant[] }>(
      "/api/v1/me/plugin-grants",
    );
    return res.grants ?? [];
  } catch {
    return [];
  }
}

async function fetchDocuments() {
  try {
    const res = await api<{ documents: any[] }>("/api/v1/documents");
    return res.documents ?? [];
  } catch {
    return [];
  }
}

// ── Intent Handlers ───────────────────────────────────────────────

async function handleAdminInfrastructure(
  _ctx: AgentContext,
): Promise<AgentResult> {
  const authErr = await handleAuthError(_ctx);
  if (authErr) return authErr;
  const warmPool = await fetchAdminWarmPool();
  const containers = await fetchAdminInfraContainers();
  return {
    text: `Surfacing platform infrastructure pool configuration. Current ready pool size is ${warmPool?.size?.ready ?? 0}.`,
    spec: buildAdminInfrastructureSpec(warmPool, containers.containers),
  };
}

async function handleAdminRpc(_ctx: AgentContext): Promise<AgentResult> {
  const authErr = await handleAuthError(_ctx);
  if (authErr) return authErr;
  const rpc = await fetchAdminRpcStatus();
  return {
    text: `Queried RPC network connection health. Reachable: ${rpc?.allReachable ? "YES" : "NO"}.`,
    spec: buildAdminRpcStatusSpec(rpc),
  };
}

async function handleSecurityPermissions(
  _ctx: AgentContext,
): Promise<AgentResult> {
  const authErr = await handleAuthError(_ctx);
  if (authErr) return authErr;
  const grants = await fetchPluginGrants();
  return {
    text: "Surfacing active third-party plugin grants and permissions configuration.",
    spec: buildPermissionsMatrixSpec(grants),
  };
}

async function handleDocuments(_ctx: AgentContext): Promise<AgentResult> {
  const authErr = await handleAuthError(_ctx);
  if (authErr) return authErr;
  const docs = await fetchDocuments();
  return {
    text: "Surfacing knowledge base text files and uploader form.",
    spec: buildDocumentsSpec(docs),
  };
}

async function handleAdminMetrics(_ctx: AgentContext): Promise<AgentResult> {
  const authErr = await handleAuthError(_ctx);
  if (authErr) return authErr;
  const metrics = await fetchAdminMetrics("overview");
  return {
    text: "Surfacing platform growth, retention, and engagement metrics.",
    spec: buildAdminMetricsSpec(metrics),
  };
}

// ── Action Handlers ───────────────────────────────────────────────

async function handleActionSecurityRevokeGrant(
  params?: Record<string, unknown>,
): Promise<AgentResult> {
  const grantId = params?.grantId as string;
  if (!grantId) {
    return { text: "No grant ID provided to revoke.", spec: null };
  }
  try {
    const res = await fetch(
      `/api/v1/me/plugin-grants/${encodeURIComponent(grantId)}`,
      {
        method: "DELETE",
        credentials: "include",
      },
    );
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const grants = await fetchPluginGrants();
    return {
      text: "Successfully revoked plugin permission grant.",
      spec: buildPermissionsMatrixSpec(grants),
    };
  } catch (err) {
    return {
      text: `Failed to revoke plugin grant: ${err instanceof Error ? err.message : "Unknown error"}.`,
      spec: null,
    };
  }
}

async function handleActionDocumentsUpload(
  params?: Record<string, unknown>,
): Promise<AgentResult> {
  const filename = (params?.filename as string) || "text-document.txt";
  const content = (params?.content as string) || "";
  if (!content) {
    return { text: "Cannot upload an empty document.", spec: null };
  }
  try {
    const res = await fetch("/api/v1/documents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ filename, content, contentType: "text/plain" }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(
        (data as { error?: string }).error ?? `HTTP ${res.status}`,
      );
    }
    const docs = await fetchDocuments();
    return {
      text: "Successfully uploaded new text document to the knowledge base.",
      spec: buildDocumentsSpec(docs),
    };
  } catch (err) {
    return {
      text: `Failed to upload document: ${err instanceof Error ? err.message : "Unknown error"}.`,
      spec: null,
    };
  }
}

async function handleActionDocumentsDelete(
  params?: Record<string, unknown>,
): Promise<AgentResult> {
  const id = params?.id as string;
  if (!id) {
    return { text: "No document ID provided to delete.", spec: null };
  }
  try {
    const res = await fetch(`/api/v1/documents/${encodeURIComponent(id)}`, {
      method: "DELETE",
      credentials: "include",
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(
        (data as { error?: string }).error ?? `HTTP ${res.status}`,
      );
    }
    const docs = await fetchDocuments();
    return {
      text: "Successfully deleted document from the knowledge base.",
      spec: buildDocumentsSpec(docs),
    };
  } catch (err) {
    return {
      text: `Failed to delete document: ${err instanceof Error ? err.message : "Unknown error"}.`,
      spec: null,
    };
  }
}

// ── Spec Builders ─────────────────────────────────────────────────

function buildAdminInfrastructureSpec(
  warmPool: any,
  containers: any[],
): UiSpec {
  const size = warmPool?.size;
  return {
    root: "root",
    elements: {
      root: {
        type: "Stack",
        props: { gap: "lg" },
        children: ["heading", "infraOverview", "containersCard"],
      },
      heading: {
        type: "Heading",
        props: { text: "Platform Infrastructure Status" },
        children: [],
      },
      infraOverview: {
        type: "InfrastructureOverview",
        props: {
          title: "Warm Pool Configuration",
          subtitle: `Image: ${warmPool?.image || "—"}`,
          status: warmPool?.enabled ? "active" : "inactive",
          value: size
            ? `Ready: ${size.ready} | Provisioning: ${size.provisioning}`
            : "Loading pool metrics...",
          items: [
            {
              name: "Min Pool Size",
              value: String(warmPool?.minPoolSize ?? 0),
            },
            {
              name: "Max Pool Size",
              value: String(warmPool?.maxPoolSize ?? 0),
            },
            {
              name: "Forecasted Target Size",
              value: String(warmPool?.forecast?.targetPoolSize ?? 0),
            },
            {
              name: "Predicted Rate",
              value: String(warmPool?.forecast?.predictedRate ?? 0),
            },
            {
              name: "Replenish Burst Limit",
              value: String(warmPool?.policy?.replenishBurstLimit ?? 0),
            },
          ],
        },
        children: [],
      },
      containersCard: {
        type: "Card",
        props: { title: `Active Containers (${containers.length})` },
        children: [
          containers.length > 0 ? "containersTable" : "noContainersText",
        ],
      },
      containersTable: {
        type: "Table",
        props: {
          columns: ["ID", "Name", "Status", "Image"],
          rows: containers
            .slice(0, 50)
            .map((c) => [
              idShort(c.id),
              c.name,
              c.status,
              c.image ? c.image.split("/").pop() : "—",
            ]),
        },
        children: [],
      },
      noContainersText: {
        type: "Text",
        props: {
          text: "No containers are active across the platform infrastructure.",
        },
        children: [],
      },
    },
    state: {},
  };
}

function buildAdminRpcStatusSpec(rpc: any): UiSpec {
  const evmList = rpc?.evm || [];
  const solana = rpc?.solana;
  return {
    root: "root",
    elements: {
      root: {
        type: "Stack",
        props: { gap: "lg" },
        children: ["heading", "rpcSummary", "solanaCard", "evmCard"],
      },
      heading: {
        type: "Heading",
        props: { text: "RPC Health Monitor" },
        children: [],
      },
      rpcSummary: {
        type: "Alert",
        props: {
          variant: rpc?.allReachable ? "success" : "warning",
          title: rpc?.allReachable
            ? "All RPCs Reachable"
            : "Some RPCs Degrading",
          message: `Last checked at ${rpc?.checkedAt ? new Date(rpc.checkedAt).toLocaleString() : "Never"}. Hot wallet: ${rpc?.hotWalletAddress || "Not configured"}.`,
        },
        children: [],
      },
      solanaCard: {
        type: "Card",
        props: { title: "Solana RPC" },
        children: ["solanaMetrics"],
      },
      solanaMetrics: {
        type: "Table",
        props: {
          columns: ["Metric", "Value"],
          rows: [
            ["RPC URL", solana?.rpcUrl || "—"],
            ["Payout Configured", solana?.configured ? "Yes" : "No"],
          ],
        },
        children: [],
      },
      evmCard: {
        type: "Card",
        props: { title: `EVM RPC Connections (${evmList.length})` },
        children: ["evmTable"],
      },
      evmTable: {
        type: "Table",
        props: {
          columns: [
            "Network",
            "Status",
            "Latency",
            "Latest Block",
            "Wallet Balance",
          ],
          rows: evmList.map((e: any) => [
            e.network,
            e.reachable ? "ONLINE" : "OFFLINE",
            e.latencyMs ? `${e.latencyMs}ms` : "—",
            e.latestBlock || "—",
            e.hotWalletBalance != null
              ? `${e.hotWalletBalance.toFixed(2)} ELIZA`
              : "—",
          ]),
        },
        children: [],
      },
    },
    state: {},
  };
}

function buildPermissionsMatrixSpec(grants: any[]): UiSpec {
  const grantElements: Record<string, any> = {};

  grants.forEach((g) => {
    const cardId = `grant-${g.grant_id}`;
    const infoId = `grant-${g.grant_id}-info`;
    const revokeBtnId = `grant-${g.grant_id}-revoke`;

    grantElements[cardId] = {
      type: "Card",
      props: { title: g.plugin_name || g.plugin_id },
      children: [infoId, revokeBtnId],
    };

    grantElements[infoId] = {
      type: "Text",
      props: {
        text: `Permission: ${g.permission} ${g.scope ? `(scope: ${g.scope})` : ""} · Granted: ${new Date(g.granted_at).toLocaleDateString()}`,
      },
      children: [],
    };

    grantElements[revokeBtnId] = {
      type: "Button",
      props: {
        label: "Revoke Access",
        variant: "outline",
        action: "cloud.security.revokeGrant",
      },
      children: [],
      on: {
        click: {
          action: "cloud.security.revokeGrant",
          params: {
            grantId: g.grant_id,
            pluginId: g.plugin_id,
            permission: g.permission,
          },
        },
      },
    };
  });

  return {
    root: "root",
    elements: {
      root: {
        type: "Stack",
        props: { gap: "lg" },
        children: [
          "heading",
          "permissionsOverview",
          "listHeading",
          ...(grants.length > 0 ? ["grantGrid"] : ["noGrantsText"]),
        ],
      },
      heading: {
        type: "Heading",
        props: { text: "Plugin Permissions Matrix" },
        children: [],
      },
      permissionsOverview: {
        type: "PermissionMatrix",
        props: {
          title: "Account Security & Grants",
          subtitle:
            "Third-party plugins request permissions to interact with your agent workflows. Manage active tokens and access configurations below.",
          status: grants.length > 0 ? "active" : "inactive",
        },
        children: [],
      },
      listHeading: {
        type: "Heading",
        props: { text: `Active Grants (${grants.length})`, level: 2 },
        children: [],
      },
      ...(grants.length > 0
        ? {
            grantGrid: {
              type: "Grid",
              props: { columns: 2, gap: "md" },
              children: grants.map((g) => `grant-${g.grant_id}`),
            },
          }
        : {}),
      noGrantsText: {
        type: "Text",
        props: {
          text: "No plugins have been granted account access permissions.",
        },
        children: [],
      },
      ...grantElements,
    },
    state: {},
  };
}

function buildDocumentsSpec(docs: any[]): UiSpec {
  const docElements: Record<string, any> = {};

  docs.forEach((d) => {
    const cardId = `doc-${d.id}`;
    const infoId = `doc-${d.id}-info`;
    const deleteBtnId = `doc-${d.id}-delete`;

    docElements[cardId] = {
      type: "Card",
      props: { title: d.filename || "Untitled Document" },
      children: [infoId, deleteBtnId],
    };

    docElements[infoId] = {
      type: "Text",
      props: {
        text: `Type: ${d.contentType || "text/plain"} · Size: ${d.size || 0} bytes · Created: ${d.createdAt ? new Date(d.createdAt).toLocaleDateString() : "—"}`,
      },
      children: [],
    };

    docElements[deleteBtnId] = {
      type: "Button",
      props: {
        label: "Delete Document",
        variant: "outline",
        action: "cloud.documents.delete",
      },
      children: [],
      on: {
        click: {
          action: "cloud.documents.delete",
          params: { id: d.id },
        },
      },
    };
  });

  return {
    root: "root",
    elements: {
      root: {
        type: "Stack",
        props: { gap: "lg" },
        children: [
          "heading",
          "uploadCard",
          "listHeading",
          ...(docs.length > 0 ? ["docGrid"] : ["noDocsText"]),
        ],
      },
      heading: {
        type: "Heading",
        props: { text: "Knowledge Base Documents" },
        children: [],
      },
      uploadCard: {
        type: "Card",
        props: { title: "Upload New Document" },
        children: ["uploadForm"],
      },
      uploadForm: {
        type: "Stack",
        props: { gap: "md" },
        children: ["filenameInput", "contentInput", "uploadBtn"],
      },
      filenameInput: {
        type: "Input",
        props: {
          label: "Filename",
          placeholder: "knowledge.txt",
          statePath: "filename",
        },
        children: [],
      },
      contentInput: {
        type: "Textarea",
        props: {
          label: "Document Content",
          placeholder:
            "Enter the text content to add to your agent's knowledge base...",
          statePath: "content",
          rows: 6,
        },
        children: [],
      },
      uploadBtn: {
        type: "Button",
        props: { label: "Upload Document" },
        children: [],
        on: {
          click: {
            action: "cloud.documents.upload",
            params: {
              filename: { $path: "filename" },
              content: { $path: "content" },
            },
          },
        },
      },
      listHeading: {
        type: "Heading",
        props: { text: `Stored Documents (${docs.length})`, level: 2 },
        children: [],
      },
      ...(docs.length > 0
        ? {
            docGrid: {
              type: "Grid",
              props: { columns: 2, gap: "md" },
              children: docs.map((d) => `doc-${d.id}`),
            },
          }
        : {}),
      noDocsText: {
        type: "Text",
        props: {
          text: "No documents uploaded yet. Use the form above to add knowledge to your agents.",
        },
        children: [],
      },
      ...docElements,
    },
    state: {
      filename: "",
      content: "",
    },
  };
}

function buildAdminMetricsSpec(metrics: any): UiSpec {
  const stats = metrics || {};
  return {
    root: "root",
    elements: {
      root: {
        type: "Stack",
        props: { gap: "lg" },
        children: ["heading", "metricsGrid", "engagementCard"],
      },
      heading: {
        type: "Heading",
        props: { text: "Engagement & Retention Dashboard" },
        children: [],
      },
      metricsGrid: {
        type: "Grid",
        props: { columns: 3, gap: "md" },
        children: ["dauCard", "mauCard", "retentionCard"],
      },
      dauCard: {
        type: "Card",
        props: { title: "Daily Active Users (DAU)" },
        children: ["dauMetric"],
      },
      dauMetric: {
        type: "Metric",
        props: {
          label: "Active Today",
          value: String(stats.dau ?? stats.dailyActiveUsers ?? 0),
        },
        children: [],
      },
      mauCard: {
        type: "Card",
        props: { title: "Monthly Active Users (MAU)" },
        children: ["mauMetric"],
      },
      mauMetric: {
        type: "Metric",
        props: {
          label: "Active 30d",
          value: String(stats.mau ?? stats.monthlyActiveUsers ?? 0),
        },
        children: [],
      },
      retentionCard: {
        type: "Card",
        props: { title: "D7 Retention Rate" },
        children: ["retentionMetric"],
      },
      retentionMetric: {
        type: "Metric",
        props: {
          label: "Cohort Return Rate",
          value: stats.retentionRate ? `${stats.retentionRate}%` : "—",
        },
        children: [],
      },
      engagementCard: {
        type: "Card",
        props: { title: "Engagement Breakdown" },
        children: ["engagementTable"],
      },
      engagementTable: {
        type: "Table",
        props: {
          columns: [
            "Metric Category",
            "Current Value",
            "Growth vs Prev Period",
          ],
          rows: [
            [
              "New Signups",
              String(stats.newSignups ?? 0),
              stats.signupsGrowth ? `${stats.signupsGrowth}%` : "—",
            ],
            [
              "Agent Provisions",
              String(stats.agentProvisions ?? 0),
              stats.provisionsGrowth ? `${stats.provisionsGrowth}%` : "—",
            ],
            [
              "Credits Spent",
              stats.creditsSpent ? `$${stats.creditsSpent.toFixed(2)}` : "—",
              stats.spendGrowth ? `${stats.spendGrowth}%` : "—",
            ],
            [
              "OAuth Connections",
              stats.oauthRate ? `${stats.oauthRate}%` : "—",
              "—",
            ],
          ],
        },
        children: [],
      },
    },
    state: {},
  };
}

// Re-export for imports
export type { CanvasMessage } from "./canvas-store";
