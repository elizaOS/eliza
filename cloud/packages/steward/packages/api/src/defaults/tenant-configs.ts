/**
 * Default tenant control plane configurations for common use cases.
 */

import type { PolicyTemplate, TenantControlPlaneConfig } from "@stwd/shared";

// ─── Policy Templates ─────────────────────────────────────────────────────────

const TRADING_TEMPLATE: PolicyTemplate = {
  id: "trading-agent",
  name: "Trading Agent",
  description: "For agents that trade on DEXs. Spending limits + approved routers.",
  icon: "chart-line",
  policies: [
    {
      id: "tpl-spend",
      type: "spending-limit",
      enabled: true,
      config: {
        maxPerTx: "100000000000000000",
        maxPerDay: "1000000000000000000",
        maxPerWeek: "5000000000000000000",
      },
    },
    {
      id: "tpl-addresses",
      type: "approved-addresses",
      enabled: true,
      config: {
        addresses: ["0x1111111254EEB25477B68fb85Ed929f73A960582"],
        mode: "whitelist",
      },
    },
    {
      id: "tpl-rate",
      type: "rate-limit",
      enabled: true,
      config: { maxTxPerHour: 20, maxTxPerDay: 100 },
    },
  ],
  customizableFields: [
    {
      path: "spending-limit.maxPerDay",
      label: "Daily Spending Limit",
      description: "Max ETH per day",
      type: "currency",
      default: "1.0",
      min: "0.01",
      max: "100",
    },
    {
      path: "spending-limit.maxPerTx",
      label: "Max Per Transaction",
      description: "Max ETH per single tx",
      type: "currency",
      default: "0.1",
      min: "0.001",
      max: "10",
    },
    {
      path: "rate-limit.maxTxPerDay",
      label: "Max Trades Per Day",
      description: "Rate limit",
      type: "number",
      default: 100,
      min: 1,
      max: 1000,
    },
  ],
};

const CHATBOT_TEMPLATE: PolicyTemplate = {
  id: "chatbot-agent",
  name: "Chat Agent",
  description: "For conversational agents that tip or pay for services. Low limits, high safety.",
  icon: "message-circle",
  policies: [
    {
      id: "tpl-spend",
      type: "spending-limit",
      enabled: true,
      config: {
        maxPerTx: "10000000000000000",
        maxPerDay: "50000000000000000",
        maxPerWeek: "200000000000000000",
      },
    },
    {
      id: "tpl-auto",
      type: "auto-approve-threshold",
      enabled: true,
      config: { threshold: "5000000000000000" },
    },
    {
      id: "tpl-rate",
      type: "rate-limit",
      enabled: true,
      config: { maxTxPerHour: 5, maxTxPerDay: 20 },
    },
  ],
  customizableFields: [
    {
      path: "spending-limit.maxPerDay",
      label: "Daily Budget",
      description: "Max ETH per day",
      type: "currency",
      default: "0.05",
    },
    {
      path: "auto-approve-threshold.threshold",
      label: "Auto-Approve Below",
      description: "Transactions under this amount skip approval",
      type: "currency",
      default: "0.005",
    },
  ],
};

// ─── Default Configs ──────────────────────────────────────────────────────────

export const MILADY_CLOUD_CONFIG: TenantControlPlaneConfig = {
  tenantId: "milady-cloud",
  displayName: "Milady Cloud",
  policyExposure: {
    "spending-limit": "visible",
    "approved-addresses": "hidden",
    "auto-approve-threshold": "visible",
    "time-window": "hidden",
    "rate-limit": "enforced",
    "allowed-chains": "enforced",
  },
  policyTemplates: [TRADING_TEMPLATE, CHATBOT_TEMPLATE],
  secretRoutePresets: [
    {
      id: "openai",
      name: "OpenAI API",
      hostPattern: "api.openai.com",
      pathPattern: "/*",
      injectAs: "bearer",
      injectKey: "Authorization",
      injectFormat: "Bearer {value}",
      provisioning: "platform",
    },
    {
      id: "anthropic",
      name: "Anthropic API",
      hostPattern: "api.anthropic.com",
      pathPattern: "/*",
      injectAs: "header",
      injectKey: "x-api-key",
      injectFormat: "{value}",
      provisioning: "platform",
    },
  ],
  approvalConfig: {
    autoExpireSeconds: 86400,
    approvers: { mode: "owner" },
    webhookCallbackEnabled: true,
  },
  featureFlags: {
    showFundingQR: true,
    showTransactionHistory: true,
    showSpendDashboard: true,
    showPolicyControls: true,
    showApprovalQueue: true,
    showSecretManager: false,
    enableSolana: true,
    showChainSelector: false,
    allowAddressExport: true,
  },
  theme: {
    primaryColor: "#8B5CF6",
    accentColor: "#A78BFA",
    backgroundColor: "#0F0F0F",
    surfaceColor: "#1A1A2E",
    textColor: "#FAFAFA",
    mutedColor: "#6B7280",
    successColor: "#10B981",
    errorColor: "#EF4444",
    warningColor: "#F59E0B",
    borderRadius: 12,
    fontFamily: "Inter, system-ui, sans-serif",
    colorScheme: "dark",
  },
};

export const MILADY_DESKTOP_CONFIG: TenantControlPlaneConfig = {
  tenantId: "milady-desktop",
  displayName: "Milady Desktop",
  policyExposure: {
    "spending-limit": "visible",
    "approved-addresses": "visible",
    "auto-approve-threshold": "visible",
    "time-window": "visible",
    "rate-limit": "visible",
    "allowed-chains": "visible",
  },
  policyTemplates: [TRADING_TEMPLATE, CHATBOT_TEMPLATE],
  secretRoutePresets: [
    {
      id: "custom-api",
      name: "Custom API Key",
      hostPattern: "*",
      pathPattern: "/*",
      injectAs: "header",
      injectKey: "Authorization",
      injectFormat: "Bearer {value}",
      provisioning: "user",
    },
  ],
  approvalConfig: {
    autoExpireSeconds: 0,
    approvers: { mode: "owner" },
    webhookCallbackEnabled: false,
  },
  featureFlags: {
    showFundingQR: true,
    showTransactionHistory: true,
    showSpendDashboard: true,
    showPolicyControls: true,
    showApprovalQueue: true,
    showSecretManager: true,
    enableSolana: true,
    showChainSelector: true,
    allowAddressExport: true,
  },
  theme: {
    primaryColor: "#8B5CF6",
    accentColor: "#A78BFA",
    backgroundColor: "#0F0F0F",
    surfaceColor: "#1A1A2E",
    textColor: "#FAFAFA",
    mutedColor: "#6B7280",
    successColor: "#10B981",
    errorColor: "#EF4444",
    warningColor: "#F59E0B",
    borderRadius: 12,
    fontFamily: "Inter, system-ui, sans-serif",
    colorScheme: "dark",
  },
};

export const ELIZA_CLOUD_CONFIG: TenantControlPlaneConfig = {
  tenantId: "eliza-cloud",
  displayName: "Eliza Cloud",
  policyExposure: {
    "spending-limit": "enforced",
    "approved-addresses": "hidden",
    "auto-approve-threshold": "hidden",
    "time-window": "hidden",
    "rate-limit": "enforced",
    "allowed-chains": "enforced",
  },
  policyTemplates: [CHATBOT_TEMPLATE],
  secretRoutePresets: [
    {
      id: "openai",
      name: "OpenAI API",
      hostPattern: "api.openai.com",
      pathPattern: "/*",
      injectAs: "bearer",
      injectKey: "Authorization",
      injectFormat: "Bearer {value}",
      provisioning: "platform",
    },
    {
      id: "anthropic",
      name: "Anthropic API",
      hostPattern: "api.anthropic.com",
      pathPattern: "/*",
      injectAs: "header",
      injectKey: "x-api-key",
      injectFormat: "{value}",
      provisioning: "platform",
    },
  ],
  approvalConfig: {
    autoExpireSeconds: 3600,
    approvers: { mode: "tenant-admin" },
    webhookCallbackEnabled: true,
  },
  featureFlags: {
    showFundingQR: true,
    showTransactionHistory: true,
    showSpendDashboard: false,
    showPolicyControls: false,
    showApprovalQueue: false,
    showSecretManager: false,
    enableSolana: false,
    showChainSelector: false,
    allowAddressExport: true,
  },
  theme: {
    primaryColor: "#3B82F6",
    accentColor: "#60A5FA",
    backgroundColor: "#111827",
    surfaceColor: "#1F2937",
    textColor: "#F9FAFB",
    mutedColor: "#9CA3AF",
    successColor: "#10B981",
    errorColor: "#EF4444",
    warningColor: "#F59E0B",
    borderRadius: 8,
    fontFamily: "Inter, system-ui, sans-serif",
    colorScheme: "dark",
  },
};

/** All default configs, keyed by tenant ID */
export const DEFAULT_TENANT_CONFIGS: Record<string, TenantControlPlaneConfig> = {
  "milady-cloud": MILADY_CLOUD_CONFIG,
  "milady-desktop": MILADY_DESKTOP_CONFIG,
  "eliza-cloud": ELIZA_CLOUD_CONFIG,
};
