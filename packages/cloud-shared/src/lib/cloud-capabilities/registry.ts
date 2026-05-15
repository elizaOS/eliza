export type CloudCapabilityCategory =
  | "auth"
  | "account"
  | "credits"
  | "billing"
  | "apps"
  | "agents"
  | "containers"
  | "mcp"
  | "a2a"
  | "admin";

export type CloudAuthMode =
  | "public"
  | "session"
  | "api_key"
  | "bearer_steward"
  | "wallet_signature"
  | "siwe"
  | "x402"
  | "admin";

export type CloudCapabilityStatus = "implemented" | "in_progress" | "contract";

export type CloudBillingEffect =
  | "none"
  | "credit_topup"
  | "credit_debit"
  | "recurring_compute"
  | "creator_earnings"
  | "admin_adjustment";

export interface CloudCapability {
  id: string;
  category: CloudCapabilityCategory;
  title: string;
  summary: string;
  auth: {
    modes: readonly CloudAuthMode[];
    adminOnly?: boolean;
  };
  billing: {
    effect: CloudBillingEffect;
    account: "none" | "organization" | "user" | "creator";
    ledger?: "credit_transactions" | "redeemable_earnings_ledger" | "usage_records";
    cancellable?: boolean;
  };
  surfaces: {
    rest: {
      method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
      path: string;
      status: CloudCapabilityStatus;
    };
    mcp: {
      tool: `cloud.${string}`;
      status: CloudCapabilityStatus;
    };
    a2a: {
      skill: `cloud.${string}`;
      status: CloudCapabilityStatus;
    };
    skill: {
      section: string;
      status: CloudCapabilityStatus;
    };
  };
}

const capability = (definition: CloudCapability): CloudCapability => definition;

export const CLOUD_CAPABILITIES = [
  capability({
    id: "auth.wallet_nonce",
    category: "auth",
    title: "Create wallet login nonce",
    summary: "Issue a nonce for wallet-based SIWE signup and login.",
    auth: { modes: ["public"] },
    billing: { effect: "none", account: "none" },
    surfaces: {
      rest: { method: "GET", path: "/api/auth/siwe/nonce", status: "implemented" },
      mcp: { tool: "cloud.auth.wallet_nonce", status: "implemented" },
      a2a: { skill: "cloud.auth.wallet_nonce", status: "implemented" },
      skill: { section: "Authentication", status: "implemented" },
    },
  }),
  capability({
    id: "auth.wallet_verify",
    category: "auth",
    title: "Verify wallet login",
    summary:
      "Verify a SIWE message, create the Cloud account if needed, and return API credentials.",
    auth: { modes: ["siwe"] },
    billing: { effect: "none", account: "organization" },
    surfaces: {
      rest: { method: "POST", path: "/api/auth/siwe/verify", status: "implemented" },
      mcp: { tool: "cloud.auth.wallet_verify", status: "implemented" },
      a2a: { skill: "cloud.auth.wallet_verify", status: "implemented" },
      skill: { section: "Authentication", status: "implemented" },
    },
  }),
  capability({
    id: "auth.steward_session",
    category: "auth",
    title: "Create Steward session",
    summary: "Exchange a Steward token for a Cloud session and synced Cloud user.",
    auth: { modes: ["bearer_steward"] },
    billing: { effect: "none", account: "organization" },
    surfaces: {
      rest: { method: "POST", path: "/api/auth/steward-session", status: "implemented" },
      mcp: { tool: "cloud.auth.steward_session", status: "implemented" },
      a2a: { skill: "cloud.auth.steward_session", status: "implemented" },
      skill: { section: "Authentication", status: "implemented" },
    },
  }),
  capability({
    id: "account.profile",
    category: "account",
    title: "Get account profile",
    summary: "Return the authenticated user, organization, wallet, and account status.",
    auth: { modes: ["session", "api_key", "bearer_steward", "wallet_signature"] },
    billing: { effect: "none", account: "organization" },
    surfaces: {
      rest: { method: "GET", path: "/api/v1/user", status: "implemented" },
      mcp: { tool: "cloud.account.profile", status: "implemented" },
      a2a: { skill: "cloud.account.profile", status: "implemented" },
      skill: { section: "Account", status: "implemented" },
    },
  }),
  capability({
    id: "credits.summary",
    category: "credits",
    title: "Get credit summary",
    summary: "Show organization credit balance, recent transactions, pricing, apps, and earnings.",
    auth: { modes: ["session", "api_key", "bearer_steward", "wallet_signature"] },
    billing: { effect: "none", account: "organization", ledger: "credit_transactions" },
    surfaces: {
      rest: { method: "GET", path: "/api/v1/credits/summary", status: "implemented" },
      mcp: { tool: "cloud.credits.summary", status: "implemented" },
      a2a: { skill: "cloud.credits.summary", status: "implemented" },
      skill: { section: "Credits", status: "implemented" },
    },
  }),
  capability({
    id: "credits.transactions",
    category: "credits",
    title: "List credit transactions",
    summary: "Return the organization credit transaction ledger.",
    auth: { modes: ["session", "api_key", "bearer_steward", "wallet_signature"] },
    billing: { effect: "none", account: "organization", ledger: "credit_transactions" },
    surfaces: {
      rest: { method: "GET", path: "/api/credits/transactions", status: "implemented" },
      mcp: { tool: "cloud.credits.transactions", status: "implemented" },
      a2a: { skill: "cloud.credits.transactions", status: "implemented" },
      skill: { section: "Credits", status: "implemented" },
    },
  }),
  capability({
    id: "credits.wallet_topup",
    category: "credits",
    title: "Top up credits from wallet",
    summary: "Charge a wallet through x402 and add credits to the organization ledger.",
    auth: { modes: ["x402", "wallet_signature", "api_key", "session"] },
    billing: { effect: "credit_topup", account: "organization", ledger: "credit_transactions" },
    surfaces: {
      rest: { method: "POST", path: "/api/v1/topup/:amount", status: "implemented" },
      mcp: { tool: "cloud.credits.wallet_topup", status: "implemented" },
      a2a: { skill: "cloud.credits.wallet_topup", status: "implemented" },
      skill: { section: "Credits", status: "implemented" },
    },
  }),
  capability({
    id: "billing.settings",
    category: "billing",
    title: "Manage billing settings",
    summary: "Read or update auto top-up and pay-as-you-go-from-earnings settings.",
    auth: { modes: ["session", "api_key", "bearer_steward", "wallet_signature"] },
    billing: { effect: "none", account: "organization" },
    surfaces: {
      rest: { method: "GET", path: "/api/v1/billing/settings", status: "implemented" },
      mcp: { tool: "cloud.billing.settings", status: "implemented" },
      a2a: { skill: "cloud.billing.settings", status: "implemented" },
      skill: { section: "Billing", status: "implemented" },
    },
  }),
  capability({
    id: "billing.active_resources",
    category: "billing",
    title: "List active billable resources",
    summary:
      "Show every resource currently billing an organization, cost, and cancellation action.",
    auth: { modes: ["session", "api_key", "bearer_steward", "wallet_signature"] },
    billing: { effect: "none", account: "organization" },
    surfaces: {
      rest: { method: "GET", path: "/api/v1/billing/active", status: "implemented" },
      mcp: { tool: "cloud.billing.active_resources", status: "implemented" },
      a2a: { skill: "cloud.billing.active_resources", status: "implemented" },
      skill: { section: "Billing", status: "implemented" },
    },
  }),
  capability({
    id: "billing.ledger",
    category: "billing",
    title: "List billing ledger",
    summary: "Show recent account charges and credit events with billable metadata.",
    auth: { modes: ["session", "api_key", "bearer_steward", "wallet_signature"] },
    billing: { effect: "none", account: "organization", ledger: "credit_transactions" },
    surfaces: {
      rest: { method: "GET", path: "/api/v1/billing/ledger", status: "implemented" },
      mcp: { tool: "cloud.billing.ledger", status: "implemented" },
      a2a: { skill: "cloud.billing.ledger", status: "implemented" },
      skill: { section: "Billing", status: "implemented" },
    },
  }),
  capability({
    id: "billing.cancel_resource",
    category: "billing",
    title: "Cancel billable resource",
    summary: "Stop or delete a billable resource so future billing stops.",
    auth: { modes: ["session", "api_key", "bearer_steward", "wallet_signature"] },
    billing: { effect: "recurring_compute", account: "organization", cancellable: true },
    surfaces: {
      rest: { method: "POST", path: "/api/v1/billing/resources/:id/cancel", status: "implemented" },
      mcp: { tool: "cloud.billing.cancel_resource", status: "implemented" },
      a2a: { skill: "cloud.billing.cancel_resource", status: "implemented" },
      skill: { section: "Billing", status: "implemented" },
    },
  }),
  capability({
    id: "apps.manage",
    category: "apps",
    title: "Manage apps",
    summary: "Create, list, update, and configure Cloud apps as backend integration units.",
    auth: { modes: ["session", "api_key", "bearer_steward", "wallet_signature"] },
    billing: { effect: "none", account: "organization" },
    surfaces: {
      rest: { method: "POST", path: "/api/v1/apps", status: "implemented" },
      mcp: { tool: "cloud.apps.manage", status: "implemented" },
      a2a: { skill: "cloud.apps.manage", status: "implemented" },
      skill: { section: "Apps", status: "implemented" },
    },
  }),
  capability({
    id: "apps.monetization",
    category: "apps",
    title: "Manage app monetization",
    summary: "Configure app markup, revenue share, and creator earning controls.",
    auth: { modes: ["session", "api_key", "bearer_steward", "wallet_signature"] },
    billing: {
      effect: "creator_earnings",
      account: "creator",
      ledger: "redeemable_earnings_ledger",
    },
    surfaces: {
      rest: { method: "PUT", path: "/api/v1/apps/:id/monetization", status: "implemented" },
      mcp: { tool: "cloud.apps.monetization", status: "implemented" },
      a2a: { skill: "cloud.apps.monetization", status: "implemented" },
      skill: { section: "Apps", status: "implemented" },
    },
  }),
  capability({
    id: "apps.chat",
    category: "apps",
    title: "Use app chat",
    summary: "Call app chat APIs and debit consumer credits.",
    auth: { modes: ["session", "api_key", "bearer_steward", "wallet_signature"] },
    billing: { effect: "credit_debit", account: "organization", ledger: "credit_transactions" },
    surfaces: {
      rest: { method: "POST", path: "/api/v1/apps/:id/chat", status: "implemented" },
      mcp: { tool: "cloud.apps.chat", status: "implemented" },
      a2a: { skill: "cloud.apps.chat", status: "implemented" },
      skill: { section: "Apps", status: "implemented" },
    },
  }),
  capability({
    id: "agents.manage",
    category: "agents",
    title: "Manage agents",
    summary: "List, create, update, and inspect Cloud agents and characters.",
    auth: { modes: ["session", "api_key", "bearer_steward", "wallet_signature"] },
    billing: { effect: "none", account: "organization" },
    surfaces: {
      rest: { method: "GET", path: "/api/v1/eliza/agents", status: "implemented" },
      mcp: { tool: "cloud.agents.manage", status: "implemented" },
      a2a: { skill: "cloud.agents.manage", status: "implemented" },
      skill: { section: "Agents", status: "implemented" },
    },
  }),
  capability({
    id: "agents.chat",
    category: "agents",
    title: "Chat with agents",
    summary: "Send chat requests to agents through Cloud and monetized protocols.",
    auth: { modes: ["session", "api_key", "bearer_steward", "wallet_signature"] },
    billing: { effect: "credit_debit", account: "organization", ledger: "credit_transactions" },
    surfaces: {
      rest: { method: "POST", path: "/api/agents/:id/a2a", status: "implemented" },
      mcp: { tool: "cloud.agents.chat", status: "implemented" },
      a2a: { skill: "cloud.agents.chat", status: "implemented" },
      skill: { section: "Agents", status: "implemented" },
    },
  }),
  capability({
    id: "containers.manage",
    category: "containers",
    title: "Manage containers",
    summary: "List, provision, inspect, and operate user-deployed Docker containers.",
    auth: { modes: ["session", "api_key", "bearer_steward", "wallet_signature"] },
    billing: {
      effect: "recurring_compute",
      account: "organization",
      ledger: "credit_transactions",
    },
    surfaces: {
      rest: { method: "GET", path: "/api/v1/containers", status: "implemented" },
      mcp: { tool: "cloud.containers.manage", status: "implemented" },
      a2a: { skill: "cloud.containers.manage", status: "implemented" },
      skill: { section: "Containers", status: "implemented" },
    },
  }),
  capability({
    id: "containers.quota",
    category: "containers",
    title: "Get container quota",
    summary: "Show container limits, pricing, and estimated account runway.",
    auth: { modes: ["session", "api_key", "bearer_steward", "wallet_signature"] },
    billing: { effect: "none", account: "organization" },
    surfaces: {
      rest: { method: "GET", path: "/api/v1/containers/quota", status: "implemented" },
      mcp: { tool: "cloud.containers.quota", status: "implemented" },
      a2a: { skill: "cloud.containers.quota", status: "implemented" },
      skill: { section: "Containers", status: "implemented" },
    },
  }),
  capability({
    id: "mcp.platform",
    category: "mcp",
    title: "Use platform MCP",
    summary: "Expose Cloud account, billing, app, agent, and admin operations through MCP tools.",
    auth: { modes: ["session", "api_key", "bearer_steward", "wallet_signature", "admin"] },
    billing: { effect: "none", account: "organization" },
    surfaces: {
      rest: { method: "POST", path: "/api/mcp", status: "implemented" },
      mcp: { tool: "cloud.mcp.platform", status: "implemented" },
      a2a: { skill: "cloud.mcp.platform", status: "implemented" },
      skill: { section: "MCP", status: "implemented" },
    },
  }),
  capability({
    id: "a2a.platform",
    category: "a2a",
    title: "Use platform A2A",
    summary: "Expose Cloud operations through a platform A2A agent and Agent Card.",
    auth: { modes: ["session", "api_key", "bearer_steward", "wallet_signature", "admin"] },
    billing: { effect: "none", account: "organization" },
    surfaces: {
      rest: { method: "POST", path: "/api/a2a", status: "implemented" },
      mcp: { tool: "cloud.a2a.platform", status: "implemented" },
      a2a: { skill: "cloud.a2a.platform", status: "implemented" },
      skill: { section: "A2A", status: "implemented" },
    },
  }),
  capability({
    id: "admin.users",
    category: "admin",
    title: "Administer users",
    summary: "Admin-only user inspection and support workflows.",
    auth: { modes: ["admin"], adminOnly: true },
    billing: { effect: "none", account: "none" },
    surfaces: {
      rest: { method: "GET", path: "/api/v1/admin/users", status: "implemented" },
      mcp: { tool: "cloud.admin.users", status: "implemented" },
      a2a: { skill: "cloud.admin.users", status: "implemented" },
      skill: { section: "Admin", status: "implemented" },
    },
  }),
  capability({
    id: "admin.orgs",
    category: "admin",
    title: "Administer organizations",
    summary: "Admin-only organization inspection, rate-limit, and billing support workflows.",
    auth: { modes: ["admin"], adminOnly: true },
    billing: { effect: "admin_adjustment", account: "organization" },
    surfaces: {
      rest: { method: "GET", path: "/api/v1/admin/orgs", status: "implemented" },
      mcp: { tool: "cloud.admin.orgs", status: "implemented" },
      a2a: { skill: "cloud.admin.orgs", status: "implemented" },
      skill: { section: "Admin", status: "implemented" },
    },
  }),
  capability({
    id: "admin.infrastructure",
    category: "admin",
    title: "Administer infrastructure",
    summary:
      "Admin-only infrastructure, Docker node, container, pricing, and moderation operations.",
    auth: { modes: ["admin"], adminOnly: true },
    billing: { effect: "none", account: "none" },
    surfaces: {
      rest: { method: "GET", path: "/api/v1/admin/infrastructure", status: "implemented" },
      mcp: { tool: "cloud.admin.infrastructure", status: "implemented" },
      a2a: { skill: "cloud.admin.infrastructure", status: "implemented" },
      skill: { section: "Admin", status: "implemented" },
    },
  }),
];

export function getCloudCapabilities(): readonly CloudCapability[] {
  return CLOUD_CAPABILITIES;
}

export function getCloudCapabilitiesByCategory(
  category: CloudCapabilityCategory,
): readonly CloudCapability[] {
  return CLOUD_CAPABILITIES.filter((capability) => capability.category === category);
}

export function getCloudCapability(id: string): CloudCapability | undefined {
  return CLOUD_CAPABILITIES.find((capability) => capability.id === id);
}

export function getCloudProtocolCoverage() {
  return CLOUD_CAPABILITIES.map((capability) => ({
    id: capability.id,
    category: capability.category,
    rest: capability.surfaces.rest.status,
    mcp: capability.surfaces.mcp.status,
    a2a: capability.surfaces.a2a.status,
    skill: capability.surfaces.skill.status,
    adminOnly: capability.auth.adminOnly === true,
    billingEffect: capability.billing.effect,
  }));
}
