/**
 * Tenant control plane configuration routes.
 *
 * Mount: app.route("/tenants", tenantConfigRoutes)
 * These extend the existing tenant routes with config management.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { resolveTxt } from "node:dns/promises";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { hashSha256Hex } from "../../../auth/src/index.ts";
import {
  policies,
  tenantAppClientSecrets,
  tenantAppClients as tenantAppClientsTable,
  tenantConfigs as tenantConfigsTable,
  tenantRequestSigningKeys,
  tenantSamlSsoConfigs,
  tenantSsoDomains,
  toPersistedPolicyRule,
} from "../../../db/src/index.ts";
import type {
  ApprovalConfig,
  PolicyExposureConfig,
  PolicyRule,
  PolicyTemplate,
  SecretRoutePreset,
  TenantAppClient,
  TenantAppClientEnvironment,
  TenantAppClientSecret,
  TenantAppClientSecretCreateResult,
  TenantAuthAbuseConfig,
  TenantControlPlaneConfig,
  TenantFeatureFlags,
  TenantGasSponsorshipConfig,
  TenantOidcProviderConfig,
  TenantSamlSsoConfig,
  TenantSsoDomain,
  TenantTestAccountConfig,
  TenantTheme,
} from "../../../shared/src/index.ts";
import { type EncryptedKey, KeyStore } from "../../../vault/src/index.ts";
import { DEFAULT_TENANT_CONFIGS } from "../defaults/tenant-configs";
import {
  getTenantIdempotencyMetrics,
  type TenantIdempotencyMetricsSnapshot,
} from "../middleware/idempotency";
import { isHstsEnabled } from "../middleware/security-headers";
import { invalidateTenantCorsCache } from "../middleware/tenant-cors";
import {
  withTenantAuditedTransaction,
  writeAuditEvent,
} from "../services/audit";
import { normalizeAuthAbuseConfig } from "../services/auth-abuse";
import {
  type ApiResponse,
  type AppVariables,
  db,
  ensureAgentForTenant,
  getConditionSetReferenceValidationError,
  MASTER_PASSWORD,
  requireTenantLevel,
  safeJsonParse,
  setNoStoreHeaders,
} from "../services/context";
import { normalizeGasSponsorshipConfig } from "../services/gas-sponsorship";
import { normalizeOidcProviders } from "../services/oidc-provider-config";
import { getPolicyRulesValidationError } from "../services/policy-validation";
import { isRecentMfaTimestamp } from "../services/recent-mfa";
import {
  buildSamlServiceProviderUrls,
  normalizeSamlSsoUpdate,
} from "../services/saml-sso-config";
import {
  createTenantTestAccountConfig,
  publicTestAccount,
} from "../services/test-account-credentials";
import { requireTenantId } from "./tenants";

export const tenantConfigRoutes = new Hono<{ Variables: AppVariables }>();

tenantConfigRoutes.use("*", async (c, next) => {
  setNoStoreHeaders(c);
  await next();
});

type TenantAppClientSecretRow = typeof tenantAppClientSecrets.$inferSelect;
type TenantSsoDomainRow = typeof tenantSsoDomains.$inferSelect;
type TenantSamlSsoConfigRow = typeof tenantSamlSsoConfigs.$inferSelect;

const MAX_POLICY_TEMPLATES = 50;
const MAX_POLICY_TEMPLATES_BYTES = 262_144;
const MAX_TEMPLATE_CUSTOMIZABLE_FIELDS = 50;
const MAX_ALLOWED_ORIGINS = 50;
const MAX_ALLOWED_REDIRECT_URLS = 100;
const MAX_NATIVE_APP_IDENTIFIERS = 50;
const MAX_APP_CLIENTS = 25;
const THEME_COLOR_KEYS = [
  "primaryColor",
  "accentColor",
  "backgroundColor",
  "surfaceColor",
  "textColor",
  "mutedColor",
  "successColor",
  "errorColor",
  "warningColor",
] as const;
const THEME_COLOR_SCHEMES = new Set(["light", "dark", "system"] as const);
const THEME_ASSET_URL_KEYS = ["logoUrl", "faviconUrl"] as const;
const THEME_ASSET_EXTENSIONS: Record<
  (typeof THEME_ASSET_URL_KEYS)[number],
  string[]
> = {
  logoUrl: [".png"],
  faviconUrl: [".ico", ".png"],
};
const ACCESS_ALLOWLIST_TYPES = new Set([
  "email",
  "email_domain",
  "wallet",
  "phone",
] as const);
const APP_CLIENT_ENVIRONMENTS = new Set<TenantAppClientEnvironment>([
  "development",
  "preview",
  "staging",
  "production",
]);
const EMBEDDED_WALLET_CREATE_ON_LOGIN = new Set([
  "off",
  "users-without-wallets",
  "all-users",
]);

type AccessAllowlistEntryType =
  typeof ACCESS_ALLOWLIST_TYPES extends Set<infer Type> ? Type : never;

interface AccessAllowlistEntry {
  id: string;
  tenantId: string;
  type: AccessAllowlistEntryType;
  value: string;
  acceptedAt: string | null;
}

type TenantSecurityChecklistStatus = "pass" | "warning" | "fail";

interface TenantSecurityChecklistItem {
  id: string;
  label: string;
  status: TenantSecurityChecklistStatus;
  description: string;
  remediation?: string;
}

interface TenantSecurityChecklist {
  tenantId: string;
  generatedAt: string;
  summary: Record<TenantSecurityChecklistStatus, number>;
  items: TenantSecurityChecklistItem[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface TenantRequestSigningKey {
  id: string;
  tenantId: string;
  name: string;
  secretPrefix: string;
  status: "active" | "retiring" | "revoked";
  createdAt: Date;
  updatedAt: Date;
  expiresAt?: Date | null;
  revokedAt?: Date | null;
}

interface TenantRequestSigningKeyCreateResult {
  key: TenantRequestSigningKey;
  signingSecret: string;
}

const emptyTenantConfig = (tenantId: string): TenantControlPlaneConfig => ({
  tenantId,
  policyExposure: {},
  policyTemplates: [],
  secretRoutePresets: [],
  approvalConfig: {},
  featureFlags: {},
  oidcProviders: [],
  authAbuseConfig: {},
  appClients: [],
  testAccount: { enabled: false },
  gasSponsorshipConfig: {},
  allowedRedirectUrls: [],
});

function normalizeTenantFeatureFlags(
  value: unknown,
  base: TenantFeatureFlags = {},
): TenantFeatureFlags | string {
  if (value === undefined) return base;
  if (!isPlainObject(value)) return "featureFlags must be an object";

  const flags: TenantFeatureFlags = { ...base, ...value } as TenantFeatureFlags;
  const embeddedWallets = value.embeddedWallets;
  if (embeddedWallets !== undefined) {
    if (!isPlainObject(embeddedWallets)) {
      return "featureFlags.embeddedWallets must be an object";
    }
    const createOnLogin = embeddedWallets.createOnLogin;
    if (
      createOnLogin !== undefined &&
      (typeof createOnLogin !== "string" ||
        !EMBEDDED_WALLET_CREATE_ON_LOGIN.has(createOnLogin))
    ) {
      return "featureFlags.embeddedWallets.createOnLogin must be off, users-without-wallets, or all-users";
    }
    flags.embeddedWallets = {
      ...(isPlainObject(base.embeddedWallets) ? base.embeddedWallets : {}),
      ...embeddedWallets,
    } as TenantFeatureFlags["embeddedWallets"];
  }

  const legacyCreateOnLogin = value.embeddedWalletCreateOnLogin;
  if (
    legacyCreateOnLogin !== undefined &&
    (typeof legacyCreateOnLogin !== "string" ||
      !EMBEDDED_WALLET_CREATE_ON_LOGIN.has(legacyCreateOnLogin))
  ) {
    return "featureFlags.embeddedWalletCreateOnLogin must be off, users-without-wallets, or all-users";
  }

  return flags;
}

function normalizeTenantAppClientEmbeddedWallets(
  value: unknown,
  clientId: string,
): TenantAppClient["embeddedWallets"] | string {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    return `app client "${clientId}" embeddedWallets must be an object`;
  }
  const createOnLogin = value.createOnLogin;
  if (
    createOnLogin !== undefined &&
    (typeof createOnLogin !== "string" ||
      !EMBEDDED_WALLET_CREATE_ON_LOGIN.has(createOnLogin))
  ) {
    return `app client "${clientId}" embeddedWallets.createOnLogin must be off, users-without-wallets, or all-users`;
  }
  return { ...value } as TenantAppClient["embeddedWallets"];
}

async function readTenantAppClientSecretsForTenant(
  tenantId: string,
): Promise<TenantAppClientSecretRow[]> {
  return db
    .select()
    .from(tenantAppClientSecrets)
    .where(eq(tenantAppClientSecrets.tenantId, tenantId));
}

async function readTenantRequestSigningKeys(tenantId: string) {
  return db
    .select()
    .from(tenantRequestSigningKeys)
    .where(eq(tenantRequestSigningKeys.tenantId, tenantId));
}

async function readTenantSsoDomain(
  tenantId: string,
  domain: string,
): Promise<TenantSsoDomainRow | null> {
  const [row] = await db
    .select()
    .from(tenantSsoDomains)
    .where(
      and(
        eq(tenantSsoDomains.tenantId, tenantId),
        eq(tenantSsoDomains.domain, domain),
      ),
    );
  return row ?? null;
}

async function readTenantSamlSsoConfig(
  tenantId: string,
): Promise<TenantSamlSsoConfigRow | null> {
  const [row] = await db
    .select()
    .from(tenantSamlSsoConfigs)
    .where(eq(tenantSamlSsoConfigs.tenantId, tenantId));
  return row ?? null;
}

function parseDecimalToWei(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  const wei = BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, "0"));
  return wei.toString();
}

function parseDecimal(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeTemplateOverride(
  field: PolicyTemplate["customizableFields"][number],
  value: unknown,
): unknown | null {
  if (field.type === "toggle") {
    return typeof value === "boolean" ? value : null;
  }

  if (field.type === "number" || field.type === "chain-select") {
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    const min = parseDecimal(field.min);
    const max = parseDecimal(field.max);
    if (min !== null && value < min) return null;
    if (max !== null && value > max) return null;
    return value;
  }

  if (field.type === "currency") {
    const numeric = parseDecimal(value);
    const min = parseDecimal(field.min);
    const max = parseDecimal(field.max);
    if (numeric === null) return null;
    if (min !== null && numeric < min) return null;
    if (max !== null && numeric > max) return null;
    return parseDecimalToWei(value);
  }

  if (field.type === "address-list") {
    if (
      !Array.isArray(value) ||
      !value.every(
        (item) => typeof item === "string" && /^0x[a-fA-F0-9]{40}$/.test(item),
      )
    ) {
      return null;
    }
    return value;
  }

  return null;
}

function validatePolicyTemplates(templates: PolicyTemplate[]): string | null {
  if (templates.length > MAX_POLICY_TEMPLATES) {
    return `policyTemplates cannot contain more than ${MAX_POLICY_TEMPLATES} templates`;
  }
  if (JSON.stringify(templates).length > MAX_POLICY_TEMPLATES_BYTES) {
    return `policyTemplates cannot exceed ${MAX_POLICY_TEMPLATES_BYTES} bytes`;
  }

  for (const template of templates) {
    if (!template.id || !template.name || !Array.isArray(template.policies)) {
      return "Invalid policy template";
    }
    if (
      (template.customizableFields?.length ?? 0) >
      MAX_TEMPLATE_CUSTOMIZABLE_FIELDS
    ) {
      return `Template "${template.id}" cannot expose more than ${MAX_TEMPLATE_CUSTOMIZABLE_FIELDS} customizable fields`;
    }
    const policiesError = getPolicyRulesValidationError(template.policies);
    if (policiesError) return policiesError;
    const seenPolicyTypes = new Set<string>();
    const seenPolicyIds = new Set<string>();
    for (const policy of template.policies) {
      if (seenPolicyTypes.has(policy.type)) {
        return `Duplicate policy type in template "${template.id}": ${policy.type}`;
      }
      seenPolicyTypes.add(policy.type);
      if (policy.id) {
        if (seenPolicyIds.has(policy.id)) {
          return `Duplicate policy id in template "${template.id}": ${policy.id}`;
        }
        seenPolicyIds.add(policy.id);
      }
      try {
        toPersistedPolicyRule(policy);
      } catch (error) {
        return error instanceof Error
          ? error.message
          : "Invalid policy template policy";
      }
    }
    const policyTypes = new Set<string>(
      template.policies.map((policy) => policy.type),
    );
    for (const field of template.customizableFields ?? []) {
      const [policyType, configKey, ...rest] = field.path.split(".");
      if (
        !policyType ||
        !configKey ||
        rest.length > 0 ||
        !policyTypes.has(policyType)
      ) {
        return `Invalid customizable field path: ${field.path}`;
      }
    }
  }
  return null;
}

function requireTenantAdminSession(
  c: Parameters<typeof requireTenantLevel>[0],
): boolean {
  const authType = c.get("authType");
  const tenantRole = c.get("tenantRole");
  return (
    authType === "session-jwt" &&
    (tenantRole === "owner" || tenantRole === "admin")
  );
}

function hasRecentSessionMfa(
  c: Parameters<typeof requireTenantLevel>[0],
  maxAgeMs = 5 * 60_000,
) {
  return isRecentMfaTimestamp(c.get("sessionMfaVerifiedAt"), maxAgeMs);
}

type TenantMfaPolicyConfig = {
  maxAgeSeconds?: number;
  requireFor?: {
    tenantAdmin?: boolean;
  };
};

type TenantAuthAbuseConfigWithMfa = TenantAuthAbuseConfig & {
  mfa?: TenantMfaPolicyConfig;
};

async function readTenantMfaPolicy(
  tenantId: string,
): Promise<TenantMfaPolicyConfig> {
  const [row] = await db
    .select({ authAbuseConfig: tenantConfigsTable.authAbuseConfig })
    .from(tenantConfigsTable)
    .where(eq(tenantConfigsTable.tenantId, tenantId));
  return (
    (row?.authAbuseConfig as TenantAuthAbuseConfigWithMfa | undefined)?.mfa ??
    {}
  );
}

function tenantMfaMaxAgeMs(policy: TenantMfaPolicyConfig): number {
  const seconds = policy.maxAgeSeconds;
  return typeof seconds === "number" && Number.isFinite(seconds)
    ? Math.max(30, Math.min(3600, Math.floor(seconds))) * 1000
    : 5 * 60_000;
}

async function requireRecentTenantAdminMfa(
  c: Parameters<typeof requireTenantLevel>[0],
  reason: string,
): Promise<Response | null> {
  if (!requireTenantAdminSession(c)) {
    return c.json<ApiResponse>(
      { ok: false, error: `${reason} requires owner or admin session` },
      403,
    );
  }
  const tenantId = c.req.param("id") || c.get("tenantId");
  const policy = tenantId ? await readTenantMfaPolicy(tenantId) : {};
  if (policy.requireFor?.tenantAdmin === false) return null;
  if (hasRecentSessionMfa(c, tenantMfaMaxAgeMs(policy))) return null;
  return c.json<ApiResponse>(
    { ok: false, error: `${reason} requires recent MFA verification` },
    403,
  );
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function hasLocalhostUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname;
    return (
      hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1"
    );
  } catch {
    return false;
  }
}

function configuredRequestSigningSecrets(): string[] {
  return [
    ...(process.env.STEWARD_REQUEST_SIGNING_SECRETS ?? "").split(","),
    process.env.STEWARD_REQUEST_SIGNING_SECRET ?? "",
  ]
    .map((secret) => secret.trim())
    .filter(Boolean);
}

function checklistSummary(
  items: TenantSecurityChecklistItem[],
): TenantSecurityChecklist["summary"] {
  return items.reduce(
    (summary, item) => {
      summary[item.status] += 1;
      return summary;
    },
    { pass: 0, warning: 0, fail: 0 },
  );
}

function buildTenantSecurityChecklist(
  tenantId: string,
  row:
    | {
        allowedOrigins: string[] | null;
        allowedRedirectUrls: string[] | null;
      }
    | null
    | undefined,
  appClients: TenantAppClient[],
  appClientSecrets: TenantAppClientSecret[],
  requestSigningKeys: TenantRequestSigningKey[],
): TenantSecurityChecklist {
  const production = process.env.NODE_ENV === "production";
  // SEC-010: these mirror the ACTUAL enforcement posture of the mounted
  // guards (app.ts). Freshness/signature headers are always verified when
  // present; they are REQUIRED only via the explicit env opt-ins, so the
  // checklist must not claim production enforcement that does not exist.
  const requestExpiryRequired =
    process.env.STEWARD_REQUIRE_REQUEST_EXPIRY === "true";
  const authSignatureRequired =
    process.env.STEWARD_REQUIRE_AUTH_SIGNATURE === "true";
  const signingSecrets = configuredRequestSigningSecrets();
  const appClientSigningSecrets = appClientSecrets.filter(
    (secret) =>
      secret.status !== "revoked" &&
      (!secret.expiresAt || new Date(secret.expiresAt).getTime() > Date.now()),
  );
  const standaloneSigningKeys = requestSigningKeys.filter(
    (key) =>
      key.status !== "revoked" &&
      (!key.expiresAt || new Date(key.expiresAt).getTime() > Date.now()),
  );
  const allowedOrigins = row?.allowedOrigins ?? [];
  const allowedRedirectUrls = row?.allowedRedirectUrls ?? [];
  const productionClients = appClients.filter(
    (client) => client.enabled !== false && client.environment === "production",
  );
  const productionClientUrls = productionClients.flatMap((client) => [
    ...(client.allowedOrigins ?? []),
    ...(client.allowedRedirectUrls ?? []),
  ]);
  const productionNativeClientCount = productionClients.filter(
    (client) =>
      (client.allowedBundleIds ?? []).length > 0 ||
      (client.allowedPackageNames ?? []).length > 0,
  ).length;
  const browserUrls = [
    ...allowedOrigins,
    ...allowedRedirectUrls,
    ...productionClientUrls,
  ];
  const insecureBrowserUrls = browserUrls.filter(
    (url) => !isHttpsUrl(url) && !hasLocalhostUrl(url),
  );
  const missingProductionClientUrls =
    productionClients.length > 0 &&
    productionClients.some(
      (client) =>
        (client.allowedOrigins ?? []).length === 0 ||
        (client.allowedRedirectUrls ?? []).length === 0,
    );

  const items: TenantSecurityChecklistItem[] = [
    {
      id: "api-security-headers",
      label: "API security headers",
      status: "pass",
      description:
        "API responses set X-Frame-Options, X-Content-Type-Options, Referrer-Policy, and Permissions-Policy.",
    },
    {
      id: "api-hsts",
      label: "API HSTS",
      status: isHstsEnabled() ? "pass" : production ? "fail" : "warning",
      description: isHstsEnabled()
        ? "Strict-Transport-Security is enabled for non-local API hosts."
        : "Strict-Transport-Security is disabled by STEWARD_HSTS_DISABLED.",
      remediation: isHstsEnabled()
        ? undefined
        : "Remove STEWARD_HSTS_DISABLED=true before serving production traffic over HTTPS.",
    },
    {
      id: "request-expiry",
      label: "Request freshness",
      status: requestExpiryRequired ? "pass" : production ? "fail" : "warning",
      description: requestExpiryRequired
        ? "Sensitive mutating requests require an expiry or timestamp freshness header."
        : "Sensitive mutating requests validate freshness headers when present but do not require them.",
      remediation: requestExpiryRequired
        ? undefined
        : "Set STEWARD_REQUIRE_REQUEST_EXPIRY=true to require freshness headers on sensitive mutating requests.",
    },
    {
      id: "authorization-signatures",
      label: "Authorization signatures",
      status: authSignatureRequired
        ? signingSecrets.length > 0 ||
          appClientSigningSecrets.length > 0 ||
          standaloneSigningKeys.length > 0
          ? "pass"
          : "fail"
        : signingSecrets.length > 0 ||
            appClientSigningSecrets.length > 0 ||
            standaloneSigningKeys.length > 0
          ? "warning"
          : "fail",
      description:
        authSignatureRequired &&
        (signingSecrets.length > 0 ||
          appClientSigningSecrets.length > 0 ||
          standaloneSigningKeys.length > 0)
          ? "Sensitive mutating requests require X-Steward-Signature and have an env, app-client, or tenant signing key available."
          : "Sensitive mutating requests need enforced HMAC signatures and configured signing secrets.",
      remediation:
        authSignatureRequired &&
        (signingSecrets.length > 0 ||
          appClientSigningSecrets.length > 0 ||
          standaloneSigningKeys.length > 0)
          ? undefined
          : "Set STEWARD_REQUIRE_AUTH_SIGNATURE=true and configure STEWARD_REQUEST_SIGNING_SECRETS, rotate an app client secret, or rotate a request signing key.",
    },
    {
      id: "tenant-browser-allowlists",
      label: "Browser origin allowlists",
      status:
        allowedOrigins.length > 0 &&
        allowedRedirectUrls.length > 0 &&
        insecureBrowserUrls.length === 0
          ? "pass"
          : production
            ? "fail"
            : "warning",
      description:
        allowedOrigins.length > 0 &&
        allowedRedirectUrls.length > 0 &&
        insecureBrowserUrls.length === 0
          ? "Tenant CORS origins and auth redirect URLs are explicitly allowlisted with HTTPS-compatible URLs."
          : "Tenant CORS origins and auth redirect URLs are missing or include non-HTTPS production URLs.",
      remediation:
        allowedOrigins.length > 0 &&
        allowedRedirectUrls.length > 0 &&
        insecureBrowserUrls.length === 0
          ? undefined
          : "Add production HTTPS origins and redirect URLs under App Origins.",
    },
    {
      id: "production-app-clients",
      label: "Production app clients",
      status:
        productionClients.length > 0 &&
        !missingProductionClientUrls &&
        insecureBrowserUrls.length === 0
          ? "pass"
          : productionClients.length === 0
            ? "warning"
            : "fail",
      description:
        productionClients.length > 0 &&
        !missingProductionClientUrls &&
        insecureBrowserUrls.length === 0
          ? "At least one enabled production app client has scoped origins and redirect URLs."
          : "Production app clients should isolate production origins, redirects, login methods, and backend secrets.",
      remediation:
        productionClients.length > 0 &&
        !missingProductionClientUrls &&
        insecureBrowserUrls.length === 0
          ? undefined
          : "Create an enabled production app client with HTTPS origins and redirect URLs.",
    },
    {
      id: "native-app-allowlists",
      label: "Native app allowlists",
      status: productionNativeClientCount > 0 ? "pass" : "warning",
      description:
        productionNativeClientCount > 0
          ? "At least one production app client has explicit iOS bundle ID or Android package allowlists."
          : "Native mobile app clients should pin iOS bundle IDs and Android package names before using native callbacks.",
      remediation:
        productionNativeClientCount > 0
          ? undefined
          : "Add allowedBundleIds and allowedPackageNames to each production native app client.",
    },
    {
      id: "dashboard-csp",
      label: "Dashboard CSP",
      status: "pass",
      description:
        "The dashboard middleware emits a nonce-based Content-Security-Policy with frame-ancestors none and object-src none.",
    },
  ];

  return {
    tenantId,
    generatedAt: new Date().toISOString(),
    summary: checklistSummary(items),
    items,
  };
}

function redactPolicyTemplatesForTenantAuth(
  templates: PolicyTemplate[],
  exposure: PolicyExposureConfig,
): PolicyTemplate[] {
  return templates.map((template) => {
    const policies = template.policies.flatMap((policy) => {
      const policyExposure = exposure[policy.type] ?? "visible";
      if (policyExposure === "hidden") return [];
      if (policyExposure === "enforced") return [{ ...policy, config: {} }];
      return [policy];
    });
    const hasOnlyVisiblePolicies = template.policies.every(
      (policy) => (exposure[policy.type] ?? "visible") === "visible",
    );
    return {
      ...template,
      policies,
      customizableFields: hasOnlyVisiblePolicies
        ? template.customizableFields
        : [],
    };
  });
}

function redactPolicyExposureForTenantAuth(
  exposure: PolicyExposureConfig,
): PolicyExposureConfig {
  return Object.fromEntries(
    Object.entries(exposure).filter(
      ([, policyExposure]) => policyExposure === "visible",
    ),
  ) as PolicyExposureConfig;
}

function redactAdminOnlyConfigForTenantAuth(
  c: Parameters<typeof requireTenantLevel>[0],
  config: TenantControlPlaneConfig,
): TenantControlPlaneConfig {
  if (requireTenantAdminSession(c) && hasRecentSessionMfa(c)) return config;
  const {
    oidcProviders: _oidcProviders,
    samlSso: _samlSso,
    authAbuseConfig: _authAbuseConfig,
    testAccount: _testAccount,
    gasSponsorshipConfig: _gasSponsorshipConfig,
    allowedOrigins: _allowedOrigins,
    allowedRedirectUrls: _allowedRedirectUrls,
    appClients: _appClients,
    ...publicConfig
  } = config;
  const policyExposure = redactPolicyExposureForTenantAuth(
    publicConfig.policyExposure,
  );
  return {
    ...publicConfig,
    allowedOrigins: [],
    allowedRedirectUrls: [],
    appClients: [],
    policyExposure,
    policyTemplates: redactPolicyTemplatesForTenantAuth(
      publicConfig.policyTemplates,
      publicConfig.policyExposure,
    ),
    secretRoutePresets: [],
    approvalConfig: {},
  };
}

function normalizeAppClientId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{2,63}$/.test(id)) return null;
  return id;
}

function normalizeTenantAppClients(value: unknown): TenantAppClient[] | string {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return "appClients must be an array";
  if (value.length > MAX_APP_CLIENTS) {
    return `appClients cannot contain more than ${MAX_APP_CLIENTS} clients`;
  }

  const seen = new Set<string>();
  let defaultCount = 0;
  const clients: TenantAppClient[] = [];

  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return "appClients entries must be objects";
    }
    const raw = entry as Record<string, unknown>;
    const id = normalizeAppClientId(raw.id);
    if (!id) {
      return "appClients entries require an id matching /^[a-z0-9][a-z0-9_-]{2,63}$/";
    }
    if (seen.has(id)) return `Duplicate app client id: ${id}`;
    seen.add(id);

    const name = typeof raw.name === "string" ? raw.name.trim() : "";
    if (!name || name.length > 120) {
      return `app client "${id}" requires a non-empty name up to 120 characters`;
    }

    const environment =
      typeof raw.environment === "string"
        ? raw.environment.trim().toLowerCase()
        : "production";
    if (
      !APP_CLIENT_ENVIRONMENTS.has(environment as TenantAppClientEnvironment)
    ) {
      return `app client "${id}" environment must be development, preview, staging, or production`;
    }

    const allowedOrigins = normalizeAllowedOrigins(raw.allowedOrigins ?? []);
    if (typeof allowedOrigins === "string") {
      return `app client "${id}" ${allowedOrigins}`;
    }
    if (allowedOrigins.includes("*")) {
      return `app client "${id}" allowedOrigins cannot include wildcard`;
    }

    const allowedRedirectUrls = normalizeAllowedRedirectUrls(
      raw.allowedRedirectUrls ?? [],
    );
    if (typeof allowedRedirectUrls === "string") {
      return `app client "${id}" ${allowedRedirectUrls}`;
    }
    const allowedBundleIds = normalizeAllowedBundleIds(
      raw.allowedBundleIds ?? [],
    );
    if (typeof allowedBundleIds === "string") {
      return `app client "${id}" ${allowedBundleIds}`;
    }
    const allowedPackageNames = normalizeAllowedPackageNames(
      raw.allowedPackageNames ?? [],
    );
    if (typeof allowedPackageNames === "string") {
      return `app client "${id}" ${allowedPackageNames}`;
    }

    let loginMethods: TenantAppClient["loginMethods"] | undefined;
    if (raw.loginMethods !== undefined) {
      const normalizedAuth = normalizeAuthAbuseConfig({
        loginMethods: raw.loginMethods,
      });
      if (typeof normalizedAuth === "string") {
        return `app client "${id}" ${normalizedAuth}`;
      }
      loginMethods = normalizedAuth.loginMethods;
    }
    const embeddedWallets = normalizeTenantAppClientEmbeddedWallets(
      raw.embeddedWallets,
      id,
    );
    if (typeof embeddedWallets === "string") {
      return embeddedWallets;
    }

    const isDefault = raw.isDefault === true;
    if (isDefault) defaultCount += 1;
    const globalWalletAllowedScopes =
      raw.globalWalletAllowedScopes === undefined
        ? ["eth_accounts", "personal_sign"]
        : Array.isArray(raw.globalWalletAllowedScopes)
          ? raw.globalWalletAllowedScopes.filter(
              (scope): scope is string =>
                typeof scope === "string" && scope.trim().length > 0,
            )
          : null;
    if (!globalWalletAllowedScopes) {
      return `app client "${id}" globalWalletAllowedScopes must be an array of strings`;
    }

    clients.push({
      id,
      name,
      environment: environment as TenantAppClientEnvironment,
      enabled: raw.enabled !== false,
      isDefault,
      allowedOrigins,
      allowedRedirectUrls,
      allowedBundleIds,
      allowedPackageNames,
      ...(loginMethods ? { loginMethods } : {}),
      ...(embeddedWallets ? { embeddedWallets } : {}),
      globalWalletEnabled: raw.globalWalletEnabled === true,
      globalWalletAllowedScopes,
    });
  }

  if (defaultCount > 1) return "appClients can contain only one default client";
  if (clients.length > 0 && defaultCount === 0) {
    clients[0] = { ...clients[0], isDefault: true };
  }

  return clients;
}

function serializeTenantAppClient(
  row: typeof tenantAppClientsTable.$inferSelect,
): TenantAppClient {
  return {
    id: row.id,
    name: row.name,
    environment: row.environment as TenantAppClientEnvironment,
    enabled: row.enabled,
    isDefault: row.isDefault,
    allowedOrigins: row.allowedOrigins ?? [],
    allowedRedirectUrls: row.allowedRedirectUrls ?? [],
    allowedBundleIds: row.allowedBundleIds ?? [],
    allowedPackageNames: row.allowedPackageNames ?? [],
    ...(row.loginMethods ? { loginMethods: row.loginMethods } : {}),
    ...(row.embeddedWallets ? { embeddedWallets: row.embeddedWallets } : {}),
    globalWalletEnabled: row.globalWalletEnabled,
    globalWalletAllowedScopes: row.globalWalletAllowedScopes ?? [],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function appIdFor(tenantId: string, clientId: string): string {
  return `${tenantId}/${clientId}`;
}

function generateAppSecret(): { secret: string; hash: string; prefix: string } {
  const secret = `stw_app_${randomBytes(24).toString("hex")}`;
  return {
    secret,
    hash: hashSha256Hex(secret),
    prefix: `${secret.slice(0, 12)}...${secret.slice(-4)}`,
  };
}

function serializeTenantAppClientSecret(
  row: typeof tenantAppClientSecrets.$inferSelect,
): TenantAppClientSecret {
  return {
    id: row.id,
    tenantId: row.tenantId,
    clientId: row.clientId,
    appId: appIdFor(row.tenantId, row.clientId),
    secretPrefix: row.secretPrefix,
    status: row.status as TenantAppClientSecret["status"],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
  };
}

function requestSigningKeyStore(): KeyStore {
  return new KeyStore(MASTER_PASSWORD, undefined, "secret-vault");
}

function generateRequestSigningSecret(): { secret: string; prefix: string } {
  const secret = `stw_sig_${randomBytes(32).toString("hex")}`;
  return {
    secret,
    prefix: `${secret.slice(0, 12)}...${secret.slice(-4)}`,
  };
}

function normalizeRequestSigningKeyName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  return name ? name.slice(0, 120) : "Request signing key";
}

function serializeTenantRequestSigningKey(
  row: typeof tenantRequestSigningKeys.$inferSelect,
): TenantRequestSigningKey {
  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    secretPrefix: row.secretPrefix,
    status: row.status as TenantRequestSigningKey["status"],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
  };
}

function encryptRequestSigningSecret(
  tenantId: string,
  keyId: string,
  secret: string,
): EncryptedKey {
  return requestSigningKeyStore().encrypt(secret, {
    tenantId,
    name: `request-signing-key:${keyId}`,
    version: 1,
  });
}

function normalizeSsoDomain(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const domain = value.trim().toLowerCase();
  if (domain.length < 3 || domain.length > 253) return null;
  if (
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(
      domain,
    )
  ) {
    return null;
  }
  return domain;
}

function serializeTenantSsoDomain(
  row: typeof tenantSsoDomains.$inferSelect,
): TenantSsoDomain {
  return {
    id: row.id,
    tenantId: row.tenantId,
    domain: row.domain,
    verificationToken: row.verificationToken,
    status: row.status as TenantSsoDomain["status"],
    ssoRequired: row.ssoRequired,
    verifiedAt: row.verifiedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function serializeTenantSamlSsoConfig(
  row: TenantSamlSsoConfigRow,
): TenantSamlSsoConfig {
  return {
    tenantId: row.tenantId,
    enabled: row.enabled,
    status: row.status as TenantSamlSsoConfig["status"],
    idpEntityId: row.idpEntityId,
    idpSsoUrl: row.idpSsoUrl,
    idpCertPems: row.idpCertPems,
    spEntityId: row.spEntityId,
    acsUrl: row.acsUrl,
    nameIdFormat: row.nameIdFormat ?? undefined,
    emailAttribute: row.emailAttribute,
    groupsAttribute: row.groupsAttribute ?? undefined,
    groupRoleMappings:
      row.groupRoleMappings as TenantSamlSsoConfig["groupRoleMappings"],
    allowJitProvisioning: row.allowJitProvisioning,
    jitDefaultRole: "viewer",
    lastTestedAt: row.lastTestedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function hasSsoDomainVerificationTxt(
  domain: string,
  token: string,
): Promise<boolean> {
  try {
    const records = await resolveTxt(`_steward-sso.${domain}`);
    return records.some((chunks) => chunks.join("").trim() === token);
  } catch {
    return false;
  }
}

function normalizeAllowedRedirectUrls(value: unknown): string[] | string {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return "allowedRedirectUrls must be an array";
  if (value.length > MAX_ALLOWED_REDIRECT_URLS) {
    return `allowedRedirectUrls cannot contain more than ${MAX_ALLOWED_REDIRECT_URLS} URLs`;
  }

  const redirects = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string")
      return "allowedRedirectUrls entries must be strings";
    const trimmed = entry.trim();
    if (!trimmed)
      return "allowedRedirectUrls entries must be non-empty strings";
    if (trimmed === "*")
      return "allowedRedirectUrls entries cannot be wildcard";

    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return `Invalid allowed redirect URL: ${trimmed}`;
    }

    if (url.protocol === "http:") {
      const host = url.hostname.toLowerCase();
      const isLoopback =
        host === "localhost" || host === "127.0.0.1" || host === "::1";
      if (!isLoopback) {
        return "allowedRedirectUrls entries must use https except for loopback development URLs";
      }
    } else if (url.protocol !== "https:") {
      return "allowedRedirectUrls entries must use https";
    }
    if (url.username || url.password || url.hash) {
      return "allowedRedirectUrls entries must not contain credentials or fragments";
    }
    redirects.add(url.toString());
  }

  return [...redirects];
}

function normalizeAllowedOrigins(value: unknown): string[] | string {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return "allowedOrigins must be an array";
  if (value.length > MAX_ALLOWED_ORIGINS) {
    return `allowedOrigins cannot contain more than ${MAX_ALLOWED_ORIGINS} origins`;
  }

  const origins = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string")
      return "allowedOrigins entries must be strings";
    const trimmed = entry.trim();
    if (!trimmed) return "allowedOrigins entries must be non-empty strings";
    if (trimmed === "*") {
      return "allowedOrigins entries cannot be wildcard";
    }

    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return `Invalid allowed origin: ${trimmed}`;
    }
    if (url.protocol === "http:") {
      const host = url.hostname.toLowerCase();
      const isLoopback =
        host === "localhost" ||
        host === "127.0.0.1" ||
        host === "::1" ||
        host.endsWith(".localhost");
      if (!isLoopback) {
        return "allowedOrigins entries must use https except for loopback development origins";
      }
    } else if (url.protocol !== "https:") {
      return "allowedOrigins entries must use https";
    }
    if (
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      return "allowedOrigins entries must be origins only, without credentials, paths, query strings, or fragments";
    }
    origins.add(url.origin);
  }

  return [...origins];
}

function normalizeAllowedBundleIds(value: unknown): string[] | string {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return "allowedBundleIds must be an array";
  if (value.length > MAX_NATIVE_APP_IDENTIFIERS) {
    return `allowedBundleIds cannot contain more than ${MAX_NATIVE_APP_IDENTIFIERS} identifiers`;
  }

  const bundleIds = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string")
      return "allowedBundleIds entries must be strings";
    const bundleId = entry.trim();
    if (!bundleId) return "allowedBundleIds entries must be non-empty strings";
    if (bundleId === "*") return "allowedBundleIds entries cannot be wildcard";
    if (
      bundleId.length > 255 ||
      !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?)+$/.test(
        bundleId,
      )
    ) {
      return "allowedBundleIds entries must be explicit iOS bundle identifiers";
    }
    bundleIds.add(bundleId);
  }

  return [...bundleIds];
}

function normalizeAllowedPackageNames(value: unknown): string[] | string {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return "allowedPackageNames must be an array";
  if (value.length > MAX_NATIVE_APP_IDENTIFIERS) {
    return `allowedPackageNames cannot contain more than ${MAX_NATIVE_APP_IDENTIFIERS} identifiers`;
  }

  const packageNames = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string")
      return "allowedPackageNames entries must be strings";
    const packageName = entry.trim().toLowerCase();
    if (!packageName)
      return "allowedPackageNames entries must be non-empty strings";
    if (packageName === "*")
      return "allowedPackageNames entries cannot be wildcard";
    if (
      packageName.length > 255 ||
      !/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/.test(packageName)
    ) {
      return "allowedPackageNames entries must be explicit Android package names";
    }
    packageNames.add(packageName);
  }

  return [...packageNames];
}

function normalizeTenantTheme(value: unknown): TenantTheme | null | string {
  if (value === undefined) return null;
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "theme must be an object";
  }

  const input = value as Record<string, unknown>;
  const theme: TenantTheme = {};
  const colorPattern = /^#[0-9a-fA-F]{6}$/;
  for (const key of THEME_COLOR_KEYS) {
    const raw = input[key];
    if (raw === undefined) continue;
    if (typeof raw !== "string" || !colorPattern.test(raw.trim())) {
      return `theme.${key} must be a 6-digit hex color`;
    }
    theme[key] = raw.trim().toUpperCase();
  }

  if (input.borderRadius !== undefined) {
    const radius = Number(input.borderRadius);
    if (!Number.isFinite(radius) || radius < 0 || radius > 32) {
      return "theme.borderRadius must be a number between 0 and 32";
    }
    theme.borderRadius = radius;
  }

  if (input.fontFamily !== undefined) {
    if (typeof input.fontFamily !== "string")
      return "theme.fontFamily must be a string";
    const fontFamily = input.fontFamily.trim();
    if (fontFamily.length > 120 || !/^[\w\s'",.-]+$/.test(fontFamily)) {
      return "theme.fontFamily contains unsupported characters";
    }
    if (fontFamily) theme.fontFamily = fontFamily;
  }

  if (input.colorScheme !== undefined) {
    if (
      typeof input.colorScheme !== "string" ||
      !THEME_COLOR_SCHEMES.has(input.colorScheme as never)
    ) {
      return "theme.colorScheme must be light, dark, or system";
    }
    theme.colorScheme = input.colorScheme as TenantTheme["colorScheme"];
  }

  for (const key of THEME_ASSET_URL_KEYS) {
    const raw = input[key];
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== "string") return `theme.${key} must be a URL string`;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (trimmed.length > 2048)
      return `theme.${key} cannot exceed 2048 characters`;
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return `theme.${key} must be an absolute URL`;
    }
    if (url.username || url.password) {
      return `theme.${key} cannot include URL credentials`;
    }
    if (url.protocol === "http:") {
      const hostname = url.hostname.toLowerCase();
      const isLocal =
        hostname === "localhost" ||
        hostname === "127.0.0.1" ||
        hostname === "::1" ||
        hostname.endsWith(".localhost");
      if (!isLocal) return `theme.${key} must use HTTPS`;
    } else if (url.protocol !== "https:") {
      return `theme.${key} must use HTTPS`;
    }
    const pathname = url.pathname.toLowerCase();
    const allowedExtensions = THEME_ASSET_EXTENSIONS[key];
    if (!allowedExtensions.some((extension) => pathname.endsWith(extension))) {
      return `theme.${key} must end with ${allowedExtensions.join(" or ")}`;
    }
    theme[key] = url.toString();
  }

  return theme;
}

function accessAllowlistEntryId(
  type: AccessAllowlistEntryType,
  value: string,
): string {
  return `${type}_${hashSha256Hex(`${type}:${value}`).slice(0, 24)}`;
}

function toAccessAllowlistEntries(
  tenantId: string,
  config: TenantAuthAbuseConfig,
): AccessAllowlistEntry[] {
  const entries: AccessAllowlistEntry[] = [];
  const append = (
    type: AccessAllowlistEntryType,
    values: string[] | undefined,
  ) => {
    for (const value of values ?? []) {
      entries.push({
        id: accessAllowlistEntryId(type, value),
        tenantId,
        type,
        value,
        acceptedAt: null,
      });
    }
  };
  append("email", config.email?.allowedEmails);
  append("email_domain", config.email?.allowedDomains);
  append("wallet", config.wallet?.allowedWallets);
  append("phone", config.phone?.allowedPhoneNumbers);
  return entries;
}

function normalizeAccessAllowlistEntry(
  value: unknown,
): AccessAllowlistEntry | string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "allowlist entries must be objects";
  }
  const raw = value as { type?: unknown; value?: unknown };
  if (
    typeof raw.type !== "string" ||
    !ACCESS_ALLOWLIST_TYPES.has(raw.type as AccessAllowlistEntryType)
  ) {
    return "allowlist entry type must be email, email_domain, wallet, or phone";
  }
  if (typeof raw.value !== "string" || !raw.value.trim()) {
    return "allowlist entry value must be a non-empty string";
  }

  const type = raw.type as AccessAllowlistEntryType;
  const candidate =
    type === "email"
      ? { email: { allowedEmails: [raw.value] } }
      : type === "email_domain"
        ? { email: { allowedDomains: [raw.value] } }
        : type === "wallet"
          ? { wallet: { allowedWallets: [raw.value] } }
          : { phone: { allowedPhoneNumbers: [raw.value] } };
  const normalized = normalizeAuthAbuseConfig(candidate);
  if (typeof normalized === "string") return normalized;
  const normalizedValue =
    type === "email"
      ? normalized.email?.allowedEmails?.[0]
      : type === "email_domain"
        ? normalized.email?.allowedDomains?.[0]
        : type === "wallet"
          ? normalized.wallet?.allowedWallets?.[0]
          : normalized.phone?.allowedPhoneNumbers?.[0];
  if (!normalizedValue) return "allowlist entry value is invalid";
  return {
    id: accessAllowlistEntryId(type, normalizedValue),
    tenantId: "",
    type,
    value: normalizedValue,
    acceptedAt: null,
  };
}

function normalizeAccessAllowlistEntries(
  value: unknown,
): AccessAllowlistEntry[] | string {
  const values = Array.isArray(value) ? value : [value];
  const entries: AccessAllowlistEntry[] = [];
  for (const item of values) {
    const entry = normalizeAccessAllowlistEntry(item);
    if (typeof entry === "string") return entry;
    entries.push(entry);
  }
  return entries;
}

function addAccessAllowlistEntriesToConfig(
  config: TenantAuthAbuseConfig,
  entries: AccessAllowlistEntry[],
): TenantAuthAbuseConfig | string {
  const email = { ...config.email };
  const wallet = { ...config.wallet };
  const phone = { ...config.phone };
  for (const entry of entries) {
    if (entry.type === "email") {
      email.allowedEmails = [...(email.allowedEmails ?? []), entry.value];
    } else if (entry.type === "email_domain") {
      email.allowedDomains = [...(email.allowedDomains ?? []), entry.value];
    } else if (entry.type === "wallet") {
      wallet.allowedWallets = [...(wallet.allowedWallets ?? []), entry.value];
    } else {
      phone.allowedPhoneNumbers = [
        ...(phone.allowedPhoneNumbers ?? []),
        entry.value,
      ];
    }
  }
  return normalizeAuthAbuseConfig({ ...config, email, wallet, phone });
}

function removeAccessAllowlistEntriesFromConfig(
  tenantId: string,
  config: TenantAuthAbuseConfig,
  removals: { ids: Set<string>; entries: AccessAllowlistEntry[] },
): TenantAuthAbuseConfig | string {
  const removeByPair = new Set(
    removals.entries.map((entry) => `${entry.type}:${entry.value}`),
  );
  const shouldKeep = (type: AccessAllowlistEntryType, value: string) =>
    !removals.ids.has(accessAllowlistEntryId(type, value)) &&
    !removeByPair.has(`${type}:${value}`);
  const email = {
    ...config.email,
    allowedEmails: (config.email?.allowedEmails ?? []).filter((value) =>
      shouldKeep("email", value),
    ),
    allowedDomains: (config.email?.allowedDomains ?? []).filter((value) =>
      shouldKeep("email_domain", value),
    ),
  };
  const wallet = {
    ...config.wallet,
    allowedWallets: (config.wallet?.allowedWallets ?? []).filter((value) =>
      shouldKeep("wallet", value),
    ),
  };
  const phone = {
    ...config.phone,
    allowedPhoneNumbers: (config.phone?.allowedPhoneNumbers ?? []).filter(
      (value) => shouldKeep("phone", value),
    ),
  };
  const next = normalizeAuthAbuseConfig({ ...config, email, wallet, phone });
  if (typeof next === "string") return next;
  const currentIds = new Set(
    toAccessAllowlistEntries(tenantId, config).map((entry) => entry.id),
  );
  for (const id of removals.ids) {
    if (!currentIds.has(id)) return `allowlist entry id not found: ${id}`;
  }
  return next;
}

async function readAuthAbuseConfigForTenant(
  tenantId: string,
  executor: typeof db = db,
): Promise<TenantAuthAbuseConfig> {
  const [row] = await executor
    .select({ authAbuseConfig: tenantConfigsTable.authAbuseConfig })
    .from(tenantConfigsTable)
    .where(eq(tenantConfigsTable.tenantId, tenantId));
  return (
    (row?.authAbuseConfig as TenantAuthAbuseConfig | undefined) ??
    DEFAULT_TENANT_CONFIGS[tenantId]?.authAbuseConfig ??
    {}
  );
}

async function persistAuthAbuseConfigForTenant(
  tenantId: string,
  authAbuseConfig: TenantAuthAbuseConfig,
  executor: typeof db = db,
): Promise<TenantAuthAbuseConfig> {
  const [row] = await executor
    .insert(tenantConfigsTable)
    .values({ tenantId, authAbuseConfig })
    .onConflictDoUpdate({
      target: tenantConfigsTable.tenantId,
      set: { authAbuseConfig, updatedAt: new Date() },
    })
    .returning({ authAbuseConfig: tenantConfigsTable.authAbuseConfig });
  return (
    (row?.authAbuseConfig as TenantAuthAbuseConfig | undefined) ??
    authAbuseConfig
  );
}

async function readAllowedRedirectUrlsForTenant(
  tenantId: string,
  executor: typeof db = db,
): Promise<string[]> {
  const [row] = await executor
    .select({ allowedRedirectUrls: tenantConfigsTable.allowedRedirectUrls })
    .from(tenantConfigsTable)
    .where(eq(tenantConfigsTable.tenantId, tenantId));
  return (
    row?.allowedRedirectUrls ??
    DEFAULT_TENANT_CONFIGS[tenantId]?.allowedRedirectUrls ??
    []
  );
}

async function persistAllowedRedirectUrlsForTenant(
  tenantId: string,
  allowedRedirectUrls: string[],
  executor: typeof db = db,
): Promise<string[]> {
  const [row] = await executor
    .insert(tenantConfigsTable)
    .values({ tenantId, allowedRedirectUrls })
    .onConflictDoUpdate({
      target: tenantConfigsTable.tenantId,
      set: { allowedRedirectUrls, updatedAt: new Date() },
    })
    .returning({ allowedRedirectUrls: tenantConfigsTable.allowedRedirectUrls });
  return row.allowedRedirectUrls ?? [];
}

async function readAllowedOriginsForTenant(
  tenantId: string,
  executor: typeof db = db,
): Promise<string[]> {
  const [row] = await executor
    .select({ allowedOrigins: tenantConfigsTable.allowedOrigins })
    .from(tenantConfigsTable)
    .where(eq(tenantConfigsTable.tenantId, tenantId));
  return (
    row?.allowedOrigins ??
    DEFAULT_TENANT_CONFIGS[tenantId]?.allowedOrigins ??
    []
  );
}

async function persistAllowedOriginsForTenant(
  tenantId: string,
  allowedOrigins: string[],
  executor: typeof db = db,
): Promise<string[]> {
  const [row] = await executor
    .insert(tenantConfigsTable)
    .values({ tenantId, allowedOrigins })
    .onConflictDoUpdate({
      target: tenantConfigsTable.tenantId,
      set: { allowedOrigins, updatedAt: new Date() },
    })
    .returning({ allowedOrigins: tenantConfigsTable.allowedOrigins });
  return row.allowedOrigins ?? [];
}

async function readTenantAppClientsForTenant(
  tenantId: string,
  executor: typeof db = db,
): Promise<TenantAppClient[]> {
  const rows = await executor
    .select()
    .from(tenantAppClientsTable)
    .where(eq(tenantAppClientsTable.tenantId, tenantId));
  return rows
    .map(serializeTenantAppClient)
    .sort(
      (a, b) =>
        Number(b.isDefault === true) - Number(a.isDefault === true) ||
        a.id.localeCompare(b.id),
    );
}

async function persistTenantAppClientsForTenant(
  tenantId: string,
  appClients: TenantAppClient[],
  executor: typeof db = db,
): Promise<TenantAppClient[]> {
  const normalized = normalizeTenantAppClients(appClients);
  if (typeof normalized === "string") {
    throw new Error(normalized);
  }

  const existingSecrets = await executor
    .select()
    .from(tenantAppClientSecrets)
    .where(eq(tenantAppClientSecrets.tenantId, tenantId));
  const nextClientIds = new Set(normalized.map((client) => client.id));
  const secretsToPreserve = existingSecrets.filter((secret) =>
    nextClientIds.has(secret.clientId),
  );

  await executor
    .delete(tenantAppClientsTable)
    .where(eq(tenantAppClientsTable.tenantId, tenantId));
  if (normalized.length > 0) {
    await executor.insert(tenantAppClientsTable).values(
      normalized.map((client) => ({
        id: client.id,
        tenantId,
        name: client.name,
        environment: client.environment,
        enabled: client.enabled !== false,
        isDefault: client.isDefault === true,
        allowedOrigins: client.allowedOrigins ?? [],
        allowedRedirectUrls: client.allowedRedirectUrls ?? [],
        allowedBundleIds: client.allowedBundleIds ?? [],
        allowedPackageNames: client.allowedPackageNames ?? [],
        loginMethods: client.loginMethods ?? null,
        embeddedWallets: client.embeddedWallets ?? null,
        globalWalletEnabled: client.globalWalletEnabled === true,
        globalWalletAllowedScopes: client.globalWalletAllowedScopes ?? [
          "eth_accounts",
          "personal_sign",
        ],
      })),
    );
  }
  if (secretsToPreserve.length > 0) {
    await executor.insert(tenantAppClientSecrets).values(secretsToPreserve);
  }
  return readTenantAppClientsForTenant(tenantId, executor);
}

async function validatePolicyTemplatesForTenant(
  tenantId: string,
  templates: PolicyTemplate[],
): Promise<string | null> {
  const templatesError = validatePolicyTemplates(templates);
  if (templatesError) return templatesError;

  for (const template of templates) {
    const conditionSetError = await getConditionSetReferenceValidationError(
      tenantId,
      template.policies,
    );
    if (conditionSetError) return conditionSetError;
  }

  return null;
}

// ─── GET /tenants/config — public discovery for the default tenant ────────────

/**
 * GET /config (mounts at /tenants/config)
 * Public, no auth required. Used by the @elizaos/ui login provider to fetch the
 * default tenant's policy templates, theme, and feature flags before the user
 * signs in. Mirrors `/tenants/:id/config` but always resolves to the default
 * tenant id and never reads the database — this is pure discovery, never PII.
 *
 * Registered before the `/:id/config` handler below so Hono's matcher prefers
 * the literal segment over the parameterised one.
 */
tenantConfigRoutes.get("/config", async (c) => {
  return c.json<ApiResponse<TenantControlPlaneConfig>>({
    ok: true,
    data: redactAdminOnlyConfigForTenantAuth(
      c,
      DEFAULT_TENANT_CONFIGS.default ?? emptyTenantConfig("default"),
    ),
  });
});

// ─── GET /tenants/:id/config — get tenant control plane config ────────────────

tenantConfigRoutes.get("/:id/config", requireTenantId, async (c) => {
  if (!requireTenantLevel(c)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Tenant config access requires tenant-level authentication",
      },
      403,
    );
  }

  const tenantId = c.req.param("id") as string;

  // Try DB first
  const [row] = await db
    .select()
    .from(tenantConfigsTable)
    .where(eq(tenantConfigsTable.tenantId, tenantId));

  if (row) {
    const appClients = await readTenantAppClientsForTenant(tenantId);
    const samlSso = await readTenantSamlSsoConfig(tenantId);
    const config: TenantControlPlaneConfig = {
      tenantId: row.tenantId,
      displayName: row.displayName ?? undefined,
      policyExposure: row.policyExposure as PolicyExposureConfig,
      policyTemplates: row.policyTemplates as PolicyTemplate[],
      secretRoutePresets: row.secretRoutePresets as SecretRoutePreset[],
      approvalConfig: row.approvalConfig as ApprovalConfig,
      featureFlags: row.featureFlags as TenantFeatureFlags,
      theme: row.theme as TenantTheme | undefined,
      allowedOrigins: row.allowedOrigins ?? [],
      oidcProviders: row.oidcProviders ?? [],
      samlSso: samlSso ? serializeTenantSamlSsoConfig(samlSso) : undefined,
      authAbuseConfig: row.authAbuseConfig as TenantAuthAbuseConfig,
      appClients,
      testAccount: publicTestAccount(row.testAccount),
      gasSponsorshipConfig:
        row.gasSponsorshipConfig as TenantGasSponsorshipConfig,
      allowedRedirectUrls: row.allowedRedirectUrls ?? [],
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
    return c.json<ApiResponse<TenantControlPlaneConfig>>({
      ok: true,
      data: redactAdminOnlyConfigForTenantAuth(c, config),
    });
  }

  return c.json<ApiResponse<TenantControlPlaneConfig>>({
    ok: true,
    data: redactAdminOnlyConfigForTenantAuth(
      c,
      DEFAULT_TENANT_CONFIGS[tenantId] ?? emptyTenantConfig(tenantId),
    ),
  });
});

// ─── GET /tenants/:id/oidc-providers — tenant-admin OIDC config ──────────────

tenantConfigRoutes.get("/:id/oidc-providers", requireTenantId, async (c) => {
  const mfaResponse = await requireRecentTenantAdminMfa(
    c,
    "OIDC provider config access",
  );
  if (mfaResponse) return mfaResponse;

  const tenantId = c.req.param("id") as string;
  const [row] = await db
    .select({ oidcProviders: tenantConfigsTable.oidcProviders })
    .from(tenantConfigsTable)
    .where(eq(tenantConfigsTable.tenantId, tenantId));

  return c.json<ApiResponse<{ providers: TenantOidcProviderConfig[] }>>({
    ok: true,
    data: { providers: row?.oidcProviders ?? [] },
  });
});

// ─── PUT /tenants/:id/oidc-providers — tenant-admin OIDC config ──────────────

tenantConfigRoutes.put("/:id/oidc-providers", requireTenantId, async (c) => {
  const mfaResponse = await requireRecentTenantAdminMfa(
    c,
    "OIDC provider config updates",
  );
  if (mfaResponse) return mfaResponse;

  const tenantId = c.req.param("id") as string;
  const body = await safeJsonParse<{ providers?: unknown }>(c);
  if (!body)
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid JSON in request body" },
      400,
    );

  const providers = normalizeOidcProviders(body.providers, tenantId);
  if (typeof providers === "string") {
    return c.json<ApiResponse>({ ok: false, error: providers }, 400);
  }

  await writeAuditEvent({
    tenantId,
    actorType: "user",
    actorId: c.get("userId") ?? null,
    action: "tenant.oidc_providers.update.authorized",
    resourceType: "tenant",
    resourceId: tenantId,
    metadata: { providerIds: providers.map((provider) => provider.id) },
    ipAddress: c.req.header("x-forwarded-for") ?? null,
    userAgent: c.req.header("user-agent") ?? null,
    requestId: c.req.header("x-request-id") ?? null,
  });

  const row = await withTenantAuditedTransaction(
    tenantId,
    async (txRaw, appendRequiredAudit) => {
      const tx = txRaw as typeof db;
      const [updated] = await tx
        .insert(tenantConfigsTable)
        .values({ tenantId, oidcProviders: providers })
        .onConflictDoUpdate({
          target: tenantConfigsTable.tenantId,
          set: { oidcProviders: providers, updatedAt: new Date() },
        })
        .returning({ oidcProviders: tenantConfigsTable.oidcProviders });
      await appendRequiredAudit({
        tenantId,
        actorType: "user",
        actorId: c.get("userId") ?? null,
        action: "tenant.oidc_providers.update",
        resourceType: "tenant",
        resourceId: tenantId,
        metadata: { providerIds: providers.map((provider) => provider.id) },
        ipAddress: c.req.header("x-forwarded-for") ?? null,
        userAgent: c.req.header("user-agent") ?? null,
        requestId: c.req.header("x-request-id") ?? null,
      });
      return updated;
    },
  );

  return c.json<ApiResponse<{ providers: TenantOidcProviderConfig[] }>>({
    ok: true,
    data: { providers: row?.oidcProviders ?? providers },
  });
});

// ─── Tenant-admin SAML dashboard/team SSO config ────────────────────────────

tenantConfigRoutes.get("/:id/saml-sso", requireTenantId, async (c) => {
  const mfaResponse = await requireRecentTenantAdminMfa(
    c,
    "SAML SSO config access",
  );
  if (mfaResponse) return mfaResponse;

  const tenantId = c.req.param("id") as string;
  const row = await readTenantSamlSsoConfig(tenantId);
  const serviceProvider = buildSamlServiceProviderUrls(tenantId);
  return c.json<
    ApiResponse<{
      config: TenantSamlSsoConfig | null;
      serviceProvider: typeof serviceProvider;
    }>
  >({
    ok: true,
    data: {
      config: row ? serializeTenantSamlSsoConfig(row) : null,
      serviceProvider,
    },
  });
});

tenantConfigRoutes.put("/:id/saml-sso", requireTenantId, async (c) => {
  const mfaResponse = await requireRecentTenantAdminMfa(
    c,
    "SAML SSO config updates",
  );
  if (mfaResponse) return mfaResponse;

  const tenantId = c.req.param("id") as string;
  const body = await safeJsonParse<unknown>(c);
  if (!body)
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid JSON in request body" },
      400,
    );

  const config = normalizeSamlSsoUpdate(tenantId, body);
  if (typeof config === "string") {
    return c.json<ApiResponse>({ ok: false, error: config }, 400);
  }

  await writeAuditEvent({
    tenantId,
    actorType: "user",
    actorId: c.get("userId") ?? null,
    action: "tenant.saml_sso.update.authorized",
    resourceType: "tenant_saml_sso_config",
    resourceId: tenantId,
    metadata: {
      enabled: config.enabled,
      idpEntityId: config.idpEntityId,
      allowJitProvisioning: config.allowJitProvisioning,
      groupRoleMappings: config.groupRoleMappings.length,
    },
    ipAddress: c.req.header("x-forwarded-for") ?? null,
    userAgent: c.req.header("user-agent") ?? null,
    requestId: c.req.header("x-request-id") ?? null,
  });

  const row = await withTenantAuditedTransaction(
    tenantId,
    async (txRaw, appendRequiredAudit) => {
      const tx = txRaw as typeof db;
      const [updated] = await tx
        .insert(tenantSamlSsoConfigs)
        .values({
          tenantId,
          enabled: config.enabled,
          status: config.status,
          idpEntityId: config.idpEntityId,
          idpSsoUrl: config.idpSsoUrl,
          idpCertPems: config.idpCertPems,
          spEntityId: config.spEntityId,
          acsUrl: config.acsUrl,
          nameIdFormat: config.nameIdFormat,
          emailAttribute: config.emailAttribute,
          groupsAttribute: config.groupsAttribute,
          groupRoleMappings: config.groupRoleMappings,
          allowJitProvisioning: config.allowJitProvisioning,
          jitDefaultRole: "viewer",
        })
        .onConflictDoUpdate({
          target: tenantSamlSsoConfigs.tenantId,
          set: {
            enabled: config.enabled,
            status: config.status,
            idpEntityId: config.idpEntityId,
            idpSsoUrl: config.idpSsoUrl,
            idpCertPems: config.idpCertPems,
            spEntityId: config.spEntityId,
            acsUrl: config.acsUrl,
            nameIdFormat: config.nameIdFormat,
            emailAttribute: config.emailAttribute,
            groupsAttribute: config.groupsAttribute,
            groupRoleMappings: config.groupRoleMappings,
            allowJitProvisioning: config.allowJitProvisioning,
            jitDefaultRole: "viewer",
            updatedAt: new Date(),
          },
        })
        .returning();

      await appendRequiredAudit({
        tenantId,
        actorType: "user",
        actorId: c.get("userId") ?? null,
        action: "tenant.saml_sso.update",
        resourceType: "tenant_saml_sso_config",
        resourceId: tenantId,
        metadata: {
          enabled: config.enabled,
          idpEntityId: config.idpEntityId,
          allowJitProvisioning: config.allowJitProvisioning,
          groupRoleMappings: config.groupRoleMappings.length,
        },
        ipAddress: c.req.header("x-forwarded-for") ?? null,
        userAgent: c.req.header("user-agent") ?? null,
        requestId: c.req.header("x-request-id") ?? null,
      });
      return updated;
    },
  );

  return c.json<ApiResponse<{ config: TenantSamlSsoConfig }>>({
    ok: true,
    data: { config: serializeTenantSamlSsoConfig(row) },
  });
});

tenantConfigRoutes.delete("/:id/saml-sso", requireTenantId, async (c) => {
  const mfaResponse = await requireRecentTenantAdminMfa(
    c,
    "SAML SSO config updates",
  );
  if (mfaResponse) return mfaResponse;

  const tenantId = c.req.param("id") as string;
  await writeAuditEvent({
    tenantId,
    actorType: "user",
    actorId: c.get("userId") ?? null,
    action: "tenant.saml_sso.delete.authorized",
    resourceType: "tenant_saml_sso_config",
    resourceId: tenantId,
    metadata: {},
    ipAddress: c.req.header("x-forwarded-for") ?? null,
    userAgent: c.req.header("user-agent") ?? null,
    requestId: c.req.header("x-request-id") ?? null,
  });

  const row = await withTenantAuditedTransaction(
    tenantId,
    async (txRaw, appendRequiredAudit) => {
      const tx = txRaw as typeof db;
      const [deleted] = await tx
        .delete(tenantSamlSsoConfigs)
        .where(eq(tenantSamlSsoConfigs.tenantId, tenantId))
        .returning();
      await appendRequiredAudit({
        tenantId,
        actorType: "user",
        actorId: c.get("userId") ?? null,
        action: "tenant.saml_sso.delete",
        resourceType: "tenant_saml_sso_config",
        resourceId: tenantId,
        metadata: {},
        ipAddress: c.req.header("x-forwarded-for") ?? null,
        userAgent: c.req.header("user-agent") ?? null,
        requestId: c.req.header("x-request-id") ?? null,
      });
      return deleted;
    },
  );

  return c.json<ApiResponse<{ deleted: boolean }>>({
    ok: true,
    data: { deleted: Boolean(row) },
  });
});

// ─── Tenant-admin SSO verified domains ───────────────────────────────────────

tenantConfigRoutes.get("/:id/sso-domains", requireTenantId, async (c) => {
  const mfaResponse = await requireRecentTenantAdminMfa(c, "SSO domain access");
  if (mfaResponse) return mfaResponse;

  const tenantId = c.req.param("id") as string;
  const rows = await db
    .select()
    .from(tenantSsoDomains)
    .where(eq(tenantSsoDomains.tenantId, tenantId));
  return c.json<ApiResponse<{ domains: TenantSsoDomain[] }>>({
    ok: true,
    data: { domains: rows.map(serializeTenantSsoDomain) },
  });
});

tenantConfigRoutes.post("/:id/sso-domains", requireTenantId, async (c) => {
  const mfaResponse = await requireRecentTenantAdminMfa(
    c,
    "SSO domain updates",
  );
  if (mfaResponse) return mfaResponse;

  const tenantId = c.req.param("id") as string;
  const body = await safeJsonParse<{ domain?: unknown; ssoRequired?: unknown }>(
    c,
  );
  if (!body)
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid JSON in request body" },
      400,
    );
  const domain = normalizeSsoDomain(body.domain);
  if (!domain)
    return c.json<ApiResponse>({ ok: false, error: "Invalid SSO domain" }, 400);

  const verificationToken = `steward-sso-${randomBytes(16).toString("hex")}`;
  await writeAuditEvent({
    tenantId,
    actorType: "user",
    actorId: c.get("userId") ?? tenantId,
    action: "tenant.sso_domain.upsert.authorized",
    resourceType: "tenant_sso_domain",
    resourceId: domain,
    metadata: { domain, ssoRequired: body.ssoRequired === true },
    ipAddress: c.req.header("x-forwarded-for") ?? null,
    userAgent: c.req.header("user-agent") ?? null,
    requestId: c.get("requestId") ?? null,
  });

  const row = await withTenantAuditedTransaction(
    tenantId,
    async (txRaw, appendRequiredAudit) => {
      const tx = txRaw as typeof db;
      const [updated] = await tx
        .insert(tenantSsoDomains)
        .values({
          tenantId,
          domain,
          verificationToken,
          ssoRequired: body.ssoRequired === true,
        })
        .onConflictDoUpdate({
          target: [tenantSsoDomains.tenantId, tenantSsoDomains.domain],
          set: {
            verificationToken,
            status: "pending",
            ssoRequired: body.ssoRequired === true,
            verifiedAt: null,
            updatedAt: new Date(),
          },
        })
        .returning();

      await appendRequiredAudit({
        tenantId,
        actorType: "user",
        actorId: c.get("userId") ?? tenantId,
        action: "tenant.sso_domain.upsert",
        resourceType: "tenant_sso_domain",
        resourceId: updated.id,
        metadata: { domain, ssoRequired: updated.ssoRequired },
        ipAddress: c.req.header("x-forwarded-for") ?? null,
        userAgent: c.req.header("user-agent") ?? null,
        requestId: c.get("requestId") ?? null,
      });
      return updated;
    },
  );

  return c.json<ApiResponse<{ domain: TenantSsoDomain }>>(
    { ok: true, data: { domain: serializeTenantSsoDomain(row) } },
    201,
  );
});

tenantConfigRoutes.post(
  "/:id/sso-domains/:domain/verify",
  requireTenantId,
  async (c) => {
    const mfaResponse = await requireRecentTenantAdminMfa(
      c,
      "SSO domain verification",
    );
    if (mfaResponse) return mfaResponse;

    const tenantId = c.req.param("id") as string;
    const domain = normalizeSsoDomain(c.req.param("domain"));
    if (!domain)
      return c.json<ApiResponse>(
        { ok: false, error: "Invalid SSO domain" },
        400,
      );

    await writeAuditEvent({
      tenantId,
      actorType: "user",
      actorId: c.get("userId") ?? tenantId,
      action: "tenant.sso_domain.verify.authorized",
      resourceType: "tenant_sso_domain",
      resourceId: domain,
      metadata: { domain },
      ipAddress: c.req.header("x-forwarded-for") ?? null,
      userAgent: c.req.header("user-agent") ?? null,
      requestId: c.get("requestId") ?? null,
    });

    const previousDomain = await readTenantSsoDomain(tenantId, domain);
    if (!previousDomain) {
      return c.json<ApiResponse>(
        { ok: false, error: "SSO domain not found" },
        404,
      );
    }
    const [existingVerifiedDomain] = await db
      .select({ tenantId: tenantSsoDomains.tenantId })
      .from(tenantSsoDomains)
      .where(
        and(
          eq(tenantSsoDomains.domain, domain),
          eq(tenantSsoDomains.status, "verified"),
        ),
      )
      .limit(1);
    if (
      existingVerifiedDomain &&
      existingVerifiedDomain.tenantId !== tenantId
    ) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error: "SSO domain is already verified by another tenant",
        },
        409,
      );
    }
    if (
      !(await hasSsoDomainVerificationTxt(
        domain,
        previousDomain.verificationToken,
      ))
    ) {
      return c.json<ApiResponse>(
        { ok: false, error: `Missing DNS TXT record _steward-sso.${domain}` },
        409,
      );
    }
    const row = await withTenantAuditedTransaction(
      tenantId,
      async (txRaw, appendRequiredAudit) => {
        const tx = txRaw as typeof db;
        const [updated] = await tx
          .update(tenantSsoDomains)
          .set({
            status: "verified",
            verifiedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(tenantSsoDomains.tenantId, tenantId),
              eq(tenantSsoDomains.domain, domain),
              eq(
                tenantSsoDomains.verificationToken,
                previousDomain.verificationToken,
              ),
            ),
          )
          .returning();
        if (!updated) return null;
        await appendRequiredAudit({
          tenantId,
          actorType: "user",
          actorId: c.get("userId") ?? tenantId,
          action: "tenant.sso_domain.verify",
          resourceType: "tenant_sso_domain",
          resourceId: updated.id,
          metadata: { domain },
          ipAddress: c.req.header("x-forwarded-for") ?? null,
          userAgent: c.req.header("user-agent") ?? null,
          requestId: c.get("requestId") ?? null,
        });
        return updated;
      },
    );
    if (!row) {
      return c.json<ApiResponse>(
        { ok: false, error: "SSO domain changed during verification" },
        409,
      );
    }

    return c.json<ApiResponse<{ domain: TenantSsoDomain }>>({
      ok: true,
      data: { domain: serializeTenantSsoDomain(row) },
    });
  },
);

tenantConfigRoutes.delete(
  "/:id/sso-domains/:domain",
  requireTenantId,
  async (c) => {
    const mfaResponse = await requireRecentTenantAdminMfa(
      c,
      "SSO domain updates",
    );
    if (mfaResponse) return mfaResponse;

    const tenantId = c.req.param("id") as string;
    const domain = normalizeSsoDomain(c.req.param("domain"));
    if (!domain)
      return c.json<ApiResponse>(
        { ok: false, error: "Invalid SSO domain" },
        400,
      );

    await writeAuditEvent({
      tenantId,
      actorType: "user",
      actorId: c.get("userId") ?? tenantId,
      action: "tenant.sso_domain.delete.authorized",
      resourceType: "tenant_sso_domain",
      resourceId: domain,
      metadata: { domain },
      ipAddress: c.req.header("x-forwarded-for") ?? null,
      userAgent: c.req.header("user-agent") ?? null,
      requestId: c.get("requestId") ?? null,
    });
    const row = await withTenantAuditedTransaction(
      tenantId,
      async (txRaw, appendRequiredAudit) => {
        const tx = txRaw as typeof db;
        const [deleted] = await tx
          .delete(tenantSsoDomains)
          .where(
            and(
              eq(tenantSsoDomains.tenantId, tenantId),
              eq(tenantSsoDomains.domain, domain),
            ),
          )
          .returning();
        if (!deleted) return null;
        await appendRequiredAudit({
          tenantId,
          actorType: "user",
          actorId: c.get("userId") ?? tenantId,
          action: "tenant.sso_domain.delete",
          resourceType: "tenant_sso_domain",
          resourceId: deleted.id,
          metadata: { domain },
          ipAddress: c.req.header("x-forwarded-for") ?? null,
          userAgent: c.req.header("user-agent") ?? null,
          requestId: c.get("requestId") ?? null,
        });
        return deleted;
      },
    );
    if (!row)
      return c.json<ApiResponse>(
        { ok: false, error: "SSO domain not found" },
        404,
      );

    return c.json<ApiResponse<{ deleted: boolean }>>({
      ok: true,
      data: { deleted: true },
    });
  },
);

// ─── Tenant-admin auth abuse / login controls ────────────────────────────────

tenantConfigRoutes.get("/:id/auth-abuse-config", requireTenantId, async (c) => {
  const mfaResponse = await requireRecentTenantAdminMfa(
    c,
    "Auth abuse config access",
  );
  if (mfaResponse) return mfaResponse;

  const tenantId = c.req.param("id") as string;
  const [row] = await db
    .select({ authAbuseConfig: tenantConfigsTable.authAbuseConfig })
    .from(tenantConfigsTable)
    .where(eq(tenantConfigsTable.tenantId, tenantId));

  return c.json<ApiResponse<{ authAbuseConfig: TenantAuthAbuseConfig }>>({
    ok: true,
    data: {
      authAbuseConfig:
        (row?.authAbuseConfig as TenantAuthAbuseConfig | undefined) ?? {},
    },
  });
});

tenantConfigRoutes.put("/:id/auth-abuse-config", requireTenantId, async (c) => {
  const mfaResponse = await requireRecentTenantAdminMfa(
    c,
    "Auth abuse config updates",
  );
  if (mfaResponse) return mfaResponse;

  const tenantId = c.req.param("id") as string;
  const body = await safeJsonParse<{ authAbuseConfig?: unknown }>(c);
  if (!body)
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid JSON in request body" },
      400,
    );

  const authAbuseConfig = normalizeAuthAbuseConfig(body.authAbuseConfig);
  if (typeof authAbuseConfig === "string") {
    return c.json<ApiResponse>({ ok: false, error: authAbuseConfig }, 400);
  }

  await writeAuditEvent({
    tenantId,
    actorType: "user",
    actorId: c.get("userId") ?? null,
    action: "tenant.auth_abuse_config.update.authorized",
    resourceType: "tenant",
    resourceId: tenantId,
    metadata: {
      captchaEnabled: authAbuseConfig.captcha?.enabled === true,
      hasEmailPolicy: Boolean(authAbuseConfig.email),
      hasWalletPolicy: Boolean(authAbuseConfig.wallet),
      hasPhonePolicy: Boolean(authAbuseConfig.phone),
    },
    ipAddress: c.req.header("x-forwarded-for") ?? null,
    userAgent: c.req.header("user-agent") ?? null,
    requestId: c.get("requestId") ?? null,
  });

  const row = await withTenantAuditedTransaction(
    tenantId,
    async (txRaw, appendRequiredAudit) => {
      const tx = txRaw as typeof db;
      const [updated] = await tx
        .insert(tenantConfigsTable)
        .values({ tenantId, authAbuseConfig })
        .onConflictDoUpdate({
          target: tenantConfigsTable.tenantId,
          set: { authAbuseConfig, updatedAt: new Date() },
        })
        .returning({ authAbuseConfig: tenantConfigsTable.authAbuseConfig });
      await appendRequiredAudit({
        tenantId,
        actorType: "user",
        actorId: c.get("userId") ?? null,
        action: "tenant.auth_abuse_config.update",
        resourceType: "tenant",
        resourceId: tenantId,
        metadata: {
          captchaEnabled: authAbuseConfig.captcha?.enabled === true,
          hasEmailPolicy: Boolean(authAbuseConfig.email),
          hasWalletPolicy: Boolean(authAbuseConfig.wallet),
          hasPhonePolicy: Boolean(authAbuseConfig.phone),
        },
        ipAddress: c.req.header("x-forwarded-for") ?? null,
        userAgent: c.req.header("user-agent") ?? null,
        requestId: c.get("requestId") ?? null,
      });
      return updated;
    },
  );

  return c.json<ApiResponse<{ authAbuseConfig: TenantAuthAbuseConfig }>>({
    ok: true,
    data: {
      authAbuseConfig:
        (row?.authAbuseConfig as TenantAuthAbuseConfig | undefined) ?? {},
    },
  });
});

// ─── Tenant-admin security checklist ────────────────────────────────────────

tenantConfigRoutes.get(
  "/:id/security-checklist",
  requireTenantId,
  async (c) => {
    const mfaResponse = await requireRecentTenantAdminMfa(
      c,
      "Security checklist access",
    );
    if (mfaResponse) return mfaResponse;

    const tenantId = c.req.param("id") as string;
    const [row] = await db
      .select({
        allowedOrigins: tenantConfigsTable.allowedOrigins,
        allowedRedirectUrls: tenantConfigsTable.allowedRedirectUrls,
      })
      .from(tenantConfigsTable)
      .where(eq(tenantConfigsTable.tenantId, tenantId));
    const appClients = await readTenantAppClientsForTenant(tenantId);
    const appClientSecretRows =
      await readTenantAppClientSecretsForTenant(tenantId);
    const requestSigningKeyRows = await readTenantRequestSigningKeys(tenantId);

    return c.json<ApiResponse<TenantSecurityChecklist>>({
      ok: true,
      data: buildTenantSecurityChecklist(
        tenantId,
        row,
        appClients,
        appClientSecretRows.map(serializeTenantAppClientSecret),
        requestSigningKeyRows.map(serializeTenantRequestSigningKey),
      ),
    });
  },
);

tenantConfigRoutes.get(
  "/:id/idempotency-metrics",
  requireTenantId,
  async (c) => {
    const mfaResponse = await requireRecentTenantAdminMfa(
      c,
      "Idempotency metrics access",
    );
    if (mfaResponse) return mfaResponse;

    const tenantId = c.req.param("id") as string;
    return c.json<ApiResponse<TenantIdempotencyMetricsSnapshot>>({
      ok: true,
      data: await getTenantIdempotencyMetrics(tenantId),
    });
  },
);

function idempotencyCsvCell(value: string): string {
  const safeValue = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${safeValue.replaceAll('"', '""')}"`;
}

function idempotencyMetricsFilename(tenantId: string): string {
  return `${tenantId.replace(/[^A-Za-z0-9._-]/g, "_") || "tenant"}-idempotency-metrics.csv`;
}

tenantConfigRoutes.get(
  "/:id/idempotency-metrics/export",
  requireTenantId,
  async (c) => {
    const mfaResponse = await requireRecentTenantAdminMfa(
      c,
      "Idempotency metrics export",
    );
    if (mfaResponse) return mfaResponse;

    const tenantId = c.req.param("id") as string;
    const metrics = await getTenantIdempotencyMetrics(tenantId);
    const headers = [
      "tenant_id",
      "generated_at",
      "window_started_at",
      "last_seen_at",
      "ttl_ms",
      "observed",
      "reserved",
      "completed",
      "replayed",
      "conflicts",
      "in_flight_conflicts",
      "suppressed_auth_responses",
      "invalid_keys",
      "store_errors",
      "skipped_unsafe_context",
      "released_on_error",
    ];
    const row = [
      metrics.tenantId,
      metrics.generatedAt,
      metrics.windowStartedAt,
      metrics.lastSeenAt ?? "",
      String(metrics.ttlMs),
      String(metrics.counters.observed),
      String(metrics.counters.reserved),
      String(metrics.counters.completed),
      String(metrics.counters.replayed),
      String(metrics.counters.conflicts),
      String(metrics.counters.inFlightConflicts),
      String(metrics.counters.suppressedAuthResponses),
      String(metrics.counters.invalidKeys),
      String(metrics.counters.storeErrors),
      String(metrics.counters.skippedUnsafeContext),
      String(metrics.counters.releasedOnError),
    ].map(idempotencyCsvCell);

    c.header("Content-Type", "text/csv; charset=utf-8");
    c.header(
      "Content-Disposition",
      `attachment; filename="${idempotencyMetricsFilename(tenantId)}"`,
    );
    return c.body(`${headers.join(",")}\n${row.join(",")}\n`);
  },
);

// ─── Tenant-admin request signing keys ──────────────────────────────────────

tenantConfigRoutes.get(
  "/:id/request-signing-keys",
  requireTenantId,
  async (c) => {
    const mfaResponse = await requireRecentTenantAdminMfa(
      c,
      "Request signing key access",
    );
    if (mfaResponse) return mfaResponse;

    const tenantId = c.req.param("id") as string;
    const rows = await db
      .select()
      .from(tenantRequestSigningKeys)
      .where(eq(tenantRequestSigningKeys.tenantId, tenantId));
    return c.json<ApiResponse<{ keys: TenantRequestSigningKey[] }>>({
      ok: true,
      data: { keys: rows.map(serializeTenantRequestSigningKey) },
    });
  },
);

tenantConfigRoutes.post(
  "/:id/request-signing-keys",
  requireTenantId,
  async (c) => {
    const mfaResponse = await requireRecentTenantAdminMfa(
      c,
      "Request signing key rotation",
    );
    if (mfaResponse) return mfaResponse;

    const tenantId = c.req.param("id") as string;
    const body = await safeJsonParse<{ name?: unknown }>(c);
    if (!body)
      return c.json<ApiResponse>(
        { ok: false, error: "Invalid JSON in request body" },
        400,
      );

    const keyId = randomUUID();
    const generated = generateRequestSigningSecret();
    const encrypted = encryptRequestSigningSecret(
      tenantId,
      keyId,
      generated.secret,
    );
    const retiringExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await writeAuditEvent({
      tenantId,
      actorType: "user",
      actorId: c.get("userId") ?? tenantId,
      action: "tenant.request_signing_key.rotate.authorized",
      resourceType: "tenant_request_signing_key",
      resourceId: keyId,
      metadata: { name: normalizeRequestSigningKeyName(body.name) },
      ipAddress: c.req.header("x-forwarded-for") ?? null,
      userAgent: c.req.header("user-agent") ?? null,
      requestId: c.get("requestId") ?? null,
    });

    const inserted = await withTenantAuditedTransaction(
      tenantId,
      async (txRaw, appendRequiredAudit) => {
        const tx = txRaw as typeof db;
        await tx
          .update(tenantRequestSigningKeys)
          .set({
            status: "retiring",
            expiresAt: retiringExpiresAt,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(tenantRequestSigningKeys.tenantId, tenantId),
              eq(tenantRequestSigningKeys.status, "active"),
            ),
          );
        const [created] = await tx
          .insert(tenantRequestSigningKeys)
          .values({
            id: keyId,
            tenantId,
            name: normalizeRequestSigningKeyName(body.name),
            secretCiphertext: encrypted.ciphertext,
            secretIv: encrypted.iv,
            secretAuthTag: encrypted.tag,
            secretSalt: encrypted.salt,
            secretPrefix: generated.prefix,
            status: "active",
          })
          .returning();
        await appendRequiredAudit({
          tenantId,
          actorType: "user",
          actorId: c.get("userId") ?? tenantId,
          action: "tenant.request_signing_key.rotate",
          resourceType: "tenant_request_signing_key",
          resourceId: created.id,
          metadata: { previousKeysRetireAt: retiringExpiresAt },
          ipAddress: c.req.header("x-forwarded-for") ?? null,
          userAgent: c.req.header("user-agent") ?? null,
          requestId: c.get("requestId") ?? null,
        });
        return created;
      },
    );

    return c.json<ApiResponse<TenantRequestSigningKeyCreateResult>>(
      {
        ok: true,
        data: {
          key: serializeTenantRequestSigningKey(inserted),
          signingSecret: generated.secret,
        },
      },
      201,
    );
  },
);

tenantConfigRoutes.delete(
  "/:id/request-signing-keys/:keyId",
  requireTenantId,
  async (c) => {
    const mfaResponse = await requireRecentTenantAdminMfa(
      c,
      "Request signing key revocation",
    );
    if (mfaResponse) return mfaResponse;

    const tenantId = c.req.param("id") as string;
    const keyId = c.req.param("keyId");
    if (!keyId)
      return c.json<ApiResponse>(
        { ok: false, error: "Invalid signing key id" },
        400,
      );

    await writeAuditEvent({
      tenantId,
      actorType: "user",
      actorId: c.get("userId") ?? tenantId,
      action: "tenant.request_signing_key.revoke.authorized",
      resourceType: "tenant_request_signing_key",
      resourceId: keyId,
      metadata: {},
      ipAddress: c.req.header("x-forwarded-for") ?? null,
      userAgent: c.req.header("user-agent") ?? null,
      requestId: c.get("requestId") ?? null,
    });

    const row = await withTenantAuditedTransaction(
      tenantId,
      async (txRaw, appendRequiredAudit) => {
        const tx = txRaw as typeof db;
        const [updated] = await tx
          .update(tenantRequestSigningKeys)
          .set({
            status: "revoked",
            revokedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(tenantRequestSigningKeys.tenantId, tenantId),
              eq(tenantRequestSigningKeys.id, keyId),
            ),
          )
          .returning();
        if (!updated) return null;
        await appendRequiredAudit({
          tenantId,
          actorType: "user",
          actorId: c.get("userId") ?? tenantId,
          action: "tenant.request_signing_key.revoke",
          resourceType: "tenant_request_signing_key",
          resourceId: updated.id,
          metadata: {},
          ipAddress: c.req.header("x-forwarded-for") ?? null,
          userAgent: c.req.header("user-agent") ?? null,
          requestId: c.get("requestId") ?? null,
        });
        return updated;
      },
    );
    if (!row)
      return c.json<ApiResponse>(
        { ok: false, error: "request signing key not found" },
        404,
      );

    return c.json<ApiResponse<{ key: TenantRequestSigningKey }>>({
      ok: true,
      data: { key: serializeTenantRequestSigningKey(row) },
    });
  },
);

// ─── Tenant-admin gas sponsorship / paymaster config ────────────────────────

tenantConfigRoutes.get("/:id/gas-sponsorship", requireTenantId, async (c) => {
  const mfaResponse = await requireRecentTenantAdminMfa(
    c,
    "Gas sponsorship config access",
  );
  if (mfaResponse) return mfaResponse;

  const tenantId = c.req.param("id") as string;
  const [row] = await db
    .select({ gasSponsorshipConfig: tenantConfigsTable.gasSponsorshipConfig })
    .from(tenantConfigsTable)
    .where(eq(tenantConfigsTable.tenantId, tenantId));

  return c.json<
    ApiResponse<{ gasSponsorshipConfig: TenantGasSponsorshipConfig }>
  >({
    ok: true,
    data: {
      gasSponsorshipConfig:
        (row?.gasSponsorshipConfig as TenantGasSponsorshipConfig | undefined) ??
        {},
    },
  });
});

tenantConfigRoutes.patch("/:id/gas-sponsorship", requireTenantId, async (c) => {
  const mfaResponse = await requireRecentTenantAdminMfa(
    c,
    "Gas sponsorship config updates",
  );
  if (mfaResponse) return mfaResponse;

  const tenantId = c.req.param("id") as string;
  const body = await safeJsonParse<{ gasSponsorshipConfig?: unknown }>(c);
  if (!body)
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid JSON in request body" },
      400,
    );

  const gasSponsorshipConfig = normalizeGasSponsorshipConfig(
    body.gasSponsorshipConfig,
  );
  if (typeof gasSponsorshipConfig === "string") {
    return c.json<ApiResponse>({ ok: false, error: gasSponsorshipConfig }, 400);
  }

  if (gasSponsorshipConfig.enabled) {
    if (!gasSponsorshipConfig.provider || !gasSponsorshipConfig.mode) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error: "Enabled gas sponsorship requires provider and mode",
        },
        400,
      );
    }
    if (
      gasSponsorshipConfig.allowedChainIds?.length === 0 &&
      gasSponsorshipConfig.allowedCaip2?.length === 0
    ) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error: "Enabled gas sponsorship requires an allowed chain",
        },
        400,
      );
    }
    if (gasSponsorshipConfig.maxPerTxUsd === undefined) {
      return c.json<ApiResponse>(
        { ok: false, error: "Enabled gas sponsorship requires maxPerTxUsd" },
        400,
      );
    }
  }

  await writeAuditEvent({
    tenantId,
    actorType: "user",
    actorId: c.get("userId") ?? null,
    action: "tenant.gas_sponsorship.update.authorized",
    resourceType: "tenant_config",
    resourceId: tenantId,
    metadata: {
      enabled: gasSponsorshipConfig.enabled === true,
      provider: gasSponsorshipConfig.provider ?? null,
      mode: gasSponsorshipConfig.mode ?? null,
      circuitBreakerEnabled:
        gasSponsorshipConfig.circuitBreakerEnabled === true,
    },
    ipAddress: c.req.header("x-forwarded-for") ?? null,
    userAgent: c.req.header("user-agent") ?? null,
    requestId: c.get("requestId") ?? null,
  });

  const row = await withTenantAuditedTransaction(
    tenantId,
    async (txRaw, appendRequiredAudit) => {
      const tx = txRaw as typeof db;
      const [updated] = await tx
        .insert(tenantConfigsTable)
        .values({ tenantId, gasSponsorshipConfig })
        .onConflictDoUpdate({
          target: tenantConfigsTable.tenantId,
          set: { gasSponsorshipConfig, updatedAt: new Date() },
        })
        .returning({
          gasSponsorshipConfig: tenantConfigsTable.gasSponsorshipConfig,
        });
      await appendRequiredAudit({
        tenantId,
        actorType: "user",
        actorId: c.get("userId") ?? null,
        action: "tenant.gas_sponsorship.update",
        resourceType: "tenant_config",
        resourceId: tenantId,
        metadata: {
          enabled: gasSponsorshipConfig.enabled === true,
          provider: gasSponsorshipConfig.provider ?? null,
          mode: gasSponsorshipConfig.mode ?? null,
          circuitBreakerEnabled:
            gasSponsorshipConfig.circuitBreakerEnabled === true,
        },
        ipAddress: c.req.header("x-forwarded-for") ?? null,
        userAgent: c.req.header("user-agent") ?? null,
        requestId: c.get("requestId") ?? null,
      });
      return updated;
    },
  );

  return c.json<
    ApiResponse<{ gasSponsorshipConfig: TenantGasSponsorshipConfig }>
  >({
    ok: true,
    data: {
      gasSponsorshipConfig:
        (row?.gasSponsorshipConfig as TenantGasSponsorshipConfig | undefined) ??
        {},
    },
  });
});

// ─── App access allowlist aliases for tenant login controls ─────────────────

tenantConfigRoutes.get("/:id/access-allowlist", requireTenantId, async (c) => {
  const mfaResponse = await requireRecentTenantAdminMfa(
    c,
    "Access allowlist access",
  );
  if (mfaResponse) return mfaResponse;

  const tenantId = c.req.param("id") as string;
  const authAbuseConfig = await readAuthAbuseConfigForTenant(tenantId);
  return c.json<ApiResponse<{ entries: AccessAllowlistEntry[] }>>({
    ok: true,
    data: { entries: toAccessAllowlistEntries(tenantId, authAbuseConfig) },
  });
});

tenantConfigRoutes.post("/:id/access-allowlist", requireTenantId, async (c) => {
  const mfaResponse = await requireRecentTenantAdminMfa(
    c,
    "Access allowlist updates",
  );
  if (mfaResponse) return mfaResponse;

  const tenantId = c.req.param("id") as string;
  const body = await safeJsonParse<{
    entry?: unknown;
    entries?: unknown;
    type?: unknown;
    value?: unknown;
  }>(c);
  if (!body)
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid JSON in request body" },
      400,
    );

  const rawEntries =
    body.entries !== undefined
      ? body.entries
      : body.entry !== undefined
        ? body.entry
        : body.type !== undefined || body.value !== undefined
          ? { type: body.type, value: body.value }
          : undefined;
  if (rawEntries === undefined) {
    return c.json<ApiResponse>(
      { ok: false, error: "entry or entries is required" },
      400,
    );
  }

  const additions = normalizeAccessAllowlistEntries(rawEntries);
  if (typeof additions === "string") {
    return c.json<ApiResponse>({ ok: false, error: additions }, 400);
  }

  const current = await readAuthAbuseConfigForTenant(tenantId);
  const next = addAccessAllowlistEntriesToConfig(current, additions);
  if (typeof next === "string") {
    return c.json<ApiResponse>({ ok: false, error: next }, 400);
  }

  await writeAuditEvent({
    tenantId,
    actorType: "user",
    actorId: c.get("userId") ?? null,
    action: "tenant.access_allowlist.add.authorized",
    resourceType: "tenant_config",
    resourceId: tenantId,
    metadata: { added: additions.map(({ type, value }) => ({ type, value })) },
    ipAddress: c.req.header("x-forwarded-for") ?? null,
    userAgent: c.req.header("user-agent") ?? null,
    requestId: c.get("requestId") ?? null,
  });

  const entries = await withTenantAuditedTransaction(
    tenantId,
    async (txRaw, appendRequiredAudit) => {
      const tx = txRaw as typeof db;
      const latest = await readAuthAbuseConfigForTenant(tenantId, tx);
      const transactionNext = addAccessAllowlistEntriesToConfig(
        latest,
        additions,
      );
      if (typeof transactionNext === "string") throw new Error(transactionNext);
      const persisted = await persistAuthAbuseConfigForTenant(
        tenantId,
        transactionNext,
        tx,
      );
      const updatedEntries = toAccessAllowlistEntries(tenantId, persisted);
      await appendRequiredAudit({
        tenantId,
        actorType: "user",
        actorId: c.get("userId") ?? null,
        action: "tenant.access_allowlist.add",
        resourceType: "tenant_config",
        resourceId: tenantId,
        metadata: {
          added: additions.map(({ type, value }) => ({ type, value })),
          count: updatedEntries.length,
        },
        ipAddress: c.req.header("x-forwarded-for") ?? null,
        userAgent: c.req.header("user-agent") ?? null,
        requestId: c.get("requestId") ?? null,
      });
      return updatedEntries;
    },
  );

  return c.json<ApiResponse<{ entries: AccessAllowlistEntry[] }>>({
    ok: true,
    data: { entries },
  });
});

tenantConfigRoutes.delete(
  "/:id/access-allowlist",
  requireTenantId,
  async (c) => {
    const mfaResponse = await requireRecentTenantAdminMfa(
      c,
      "Access allowlist updates",
    );
    if (mfaResponse) return mfaResponse;

    const tenantId = c.req.param("id") as string;
    const body = await safeJsonParse<{
      entry?: unknown;
      entries?: unknown;
      id?: unknown;
      ids?: unknown;
      type?: unknown;
      value?: unknown;
    }>(c);
    if (!body)
      return c.json<ApiResponse>(
        { ok: false, error: "Invalid JSON in request body" },
        400,
      );

    const idsInput =
      body.ids !== undefined
        ? body.ids
        : body.id !== undefined
          ? [body.id]
          : undefined;
    const ids: string[] = [];
    if (idsInput !== undefined) {
      if (
        !Array.isArray(idsInput) ||
        !idsInput.every((id) => typeof id === "string" && id.trim())
      ) {
        return c.json<ApiResponse>(
          { ok: false, error: "id or ids must be non-empty strings" },
          400,
        );
      }
      ids.push(...idsInput.map((id) => id.trim()));
    }

    const rawEntries =
      body.entries !== undefined
        ? body.entries
        : body.entry !== undefined
          ? body.entry
          : body.type !== undefined || body.value !== undefined
            ? { type: body.type, value: body.value }
            : undefined;
    const removals =
      rawEntries === undefined
        ? []
        : normalizeAccessAllowlistEntries(rawEntries);
    if (typeof removals === "string") {
      return c.json<ApiResponse>({ ok: false, error: removals }, 400);
    }
    if (ids.length === 0 && removals.length === 0) {
      return c.json<ApiResponse>(
        { ok: false, error: "id, ids, entry, or entries is required" },
        400,
      );
    }

    const current = await readAuthAbuseConfigForTenant(tenantId);
    const next = removeAccessAllowlistEntriesFromConfig(tenantId, current, {
      ids: new Set(ids),
      entries: removals,
    });
    if (typeof next === "string") {
      return c.json<ApiResponse>({ ok: false, error: next }, 400);
    }

    await writeAuditEvent({
      tenantId,
      actorType: "user",
      actorId: c.get("userId") ?? null,
      action: "tenant.access_allowlist.remove.authorized",
      resourceType: "tenant_config",
      resourceId: tenantId,
      metadata: {
        ids,
        removed: removals.map(({ type, value }) => ({ type, value })),
      },
      ipAddress: c.req.header("x-forwarded-for") ?? null,
      userAgent: c.req.header("user-agent") ?? null,
      requestId: c.get("requestId") ?? null,
    });

    const entries = await withTenantAuditedTransaction(
      tenantId,
      async (txRaw, appendRequiredAudit) => {
        const tx = txRaw as typeof db;
        const latest = await readAuthAbuseConfigForTenant(tenantId, tx);
        const transactionNext = removeAccessAllowlistEntriesFromConfig(
          tenantId,
          latest,
          {
            ids: new Set(ids),
            entries: removals,
          },
        );
        if (typeof transactionNext === "string")
          throw new Error(transactionNext);
        const persisted = await persistAuthAbuseConfigForTenant(
          tenantId,
          transactionNext,
          tx,
        );
        const updatedEntries = toAccessAllowlistEntries(tenantId, persisted);
        await appendRequiredAudit({
          tenantId,
          actorType: "user",
          actorId: c.get("userId") ?? null,
          action: "tenant.access_allowlist.remove",
          resourceType: "tenant_config",
          resourceId: tenantId,
          metadata: {
            ids,
            removed: removals.map(({ type, value }) => ({ type, value })),
            count: updatedEntries.length,
          },
          ipAddress: c.req.header("x-forwarded-for") ?? null,
          userAgent: c.req.header("user-agent") ?? null,
          requestId: c.get("requestId") ?? null,
        });
        return updatedEntries;
      },
    );

    return c.json<ApiResponse<{ entries: AccessAllowlistEntry[] }>>({
      ok: true,
      data: { entries },
    });
  },
);

// ─── Redirect URL aliases for tenant OAuth/email callback allowlists ─────────

tenantConfigRoutes.get("/:id/redirect-urls", requireTenantId, async (c) => {
  const mfaResponse = await requireRecentTenantAdminMfa(
    c,
    "Redirect URL access",
  );
  if (mfaResponse) return mfaResponse;

  const tenantId = c.req.param("id") as string;
  const entries = await readAllowedRedirectUrlsForTenant(tenantId);
  return c.json<ApiResponse<{ entries: string[] }>>({
    ok: true,
    data: { entries },
  });
});

tenantConfigRoutes.post("/:id/redirect-urls", requireTenantId, async (c) => {
  const mfaResponse = await requireRecentTenantAdminMfa(
    c,
    "Redirect URL updates",
  );
  if (mfaResponse) return mfaResponse;

  const tenantId = c.req.param("id") as string;
  const body = await safeJsonParse<{ url?: unknown; urls?: unknown }>(c);
  if (!body) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid JSON in request body" },
      400,
    );
  }
  const additions = Array.isArray(body.urls)
    ? body.urls
    : body.url !== undefined
      ? [body.url]
      : [];
  if (additions.length === 0) {
    return c.json<ApiResponse>(
      { ok: false, error: "url or urls is required" },
      400,
    );
  }

  const normalizedAdditions = normalizeAllowedRedirectUrls(additions);
  if (typeof normalizedAdditions === "string") {
    return c.json<ApiResponse>({ ok: false, error: normalizedAdditions }, 400);
  }
  const current = await readAllowedRedirectUrlsForTenant(tenantId);
  const next = normalizeAllowedRedirectUrls([
    ...current,
    ...normalizedAdditions,
  ]);
  if (typeof next === "string") {
    return c.json<ApiResponse>({ ok: false, error: next }, 400);
  }
  await writeAuditEvent({
    tenantId,
    actorType: "user",
    actorId: c.get("userId") ?? tenantId,
    action: "tenant.redirect_url.add.authorized",
    resourceType: "tenant_config",
    resourceId: tenantId,
    metadata: { added: normalizedAdditions },
    ipAddress: c.req.header("x-forwarded-for") ?? null,
    userAgent: c.req.header("user-agent") ?? null,
    requestId: c.get("requestId") ?? null,
  });
  const entries = await withTenantAuditedTransaction(
    tenantId,
    async (txRaw, appendRequiredAudit) => {
      const tx = txRaw as typeof db;
      const latest = await readAllowedRedirectUrlsForTenant(tenantId, tx);
      const transactionNext = normalizeAllowedRedirectUrls([
        ...latest,
        ...normalizedAdditions,
      ]);
      if (typeof transactionNext === "string") throw new Error(transactionNext);
      const updated = await persistAllowedRedirectUrlsForTenant(
        tenantId,
        transactionNext,
        tx,
      );
      await appendRequiredAudit({
        tenantId,
        actorType: "user",
        actorId: c.get("userId") ?? tenantId,
        action: "tenant.redirect_url.add",
        resourceType: "tenant_config",
        resourceId: tenantId,
        metadata: {
          added: normalizedAdditions,
          allowedRedirectUrlsCount: updated.length,
        },
        ipAddress: c.req.header("x-forwarded-for") ?? null,
        userAgent: c.req.header("user-agent") ?? null,
        requestId: c.get("requestId") ?? null,
      });
      return updated;
    },
  );

  return c.json<ApiResponse<{ entries: string[] }>>({
    ok: true,
    data: { entries },
  });
});

tenantConfigRoutes.delete("/:id/redirect-urls", requireTenantId, async (c) => {
  const mfaResponse = await requireRecentTenantAdminMfa(
    c,
    "Redirect URL updates",
  );
  if (mfaResponse) return mfaResponse;

  const tenantId = c.req.param("id") as string;
  const body = await safeJsonParse<{ url?: unknown; urls?: unknown }>(c);
  if (!body) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid JSON in request body" },
      400,
    );
  }
  const removals = Array.isArray(body.urls)
    ? body.urls
    : body.url !== undefined
      ? [body.url]
      : [];
  if (removals.length === 0) {
    return c.json<ApiResponse>(
      { ok: false, error: "url or urls is required" },
      400,
    );
  }

  const normalizedRemovals = normalizeAllowedRedirectUrls(removals);
  if (typeof normalizedRemovals === "string") {
    return c.json<ApiResponse>({ ok: false, error: normalizedRemovals }, 400);
  }
  const removalSet = new Set(normalizedRemovals);
  await writeAuditEvent({
    tenantId,
    actorType: "user",
    actorId: c.get("userId") ?? tenantId,
    action: "tenant.redirect_url.remove.authorized",
    resourceType: "tenant_config",
    resourceId: tenantId,
    metadata: { removed: normalizedRemovals },
    ipAddress: c.req.header("x-forwarded-for") ?? null,
    userAgent: c.req.header("user-agent") ?? null,
    requestId: c.get("requestId") ?? null,
  });
  const entries = await withTenantAuditedTransaction(
    tenantId,
    async (txRaw, appendRequiredAudit) => {
      const tx = txRaw as typeof db;
      const latest = await readAllowedRedirectUrlsForTenant(tenantId, tx);
      const transactionNext = latest.filter((url) => !removalSet.has(url));
      const updated = await persistAllowedRedirectUrlsForTenant(
        tenantId,
        transactionNext,
        tx,
      );
      await appendRequiredAudit({
        tenantId,
        actorType: "user",
        actorId: c.get("userId") ?? tenantId,
        action: "tenant.redirect_url.remove",
        resourceType: "tenant_config",
        resourceId: tenantId,
        metadata: {
          removed: normalizedRemovals,
          allowedRedirectUrlsCount: updated.length,
        },
        ipAddress: c.req.header("x-forwarded-for") ?? null,
        userAgent: c.req.header("user-agent") ?? null,
        requestId: c.get("requestId") ?? null,
      });
      return updated;
    },
  );

  return c.json<ApiResponse<{ entries: string[] }>>({
    ok: true,
    data: { entries },
  });
});

// ─── App origin aliases for tenant allowed origins ────────────────────────

tenantConfigRoutes.get("/:id/app-origins", requireTenantId, async (c) => {
  const mfaResponse = await requireRecentTenantAdminMfa(c, "App origin access");
  if (mfaResponse) return mfaResponse;

  const tenantId = c.req.param("id") as string;
  const entries = await readAllowedOriginsForTenant(tenantId);
  return c.json<ApiResponse<{ entries: string[] }>>({
    ok: true,
    data: { entries },
  });
});

tenantConfigRoutes.post("/:id/app-origins", requireTenantId, async (c) => {
  const mfaResponse = await requireRecentTenantAdminMfa(
    c,
    "App origin updates",
  );
  if (mfaResponse) return mfaResponse;

  const tenantId = c.req.param("id") as string;
  const body = await safeJsonParse<{ origin?: unknown; origins?: unknown }>(c);
  if (!body) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid JSON in request body" },
      400,
    );
  }
  const additions = Array.isArray(body.origins)
    ? body.origins
    : body.origin !== undefined
      ? [body.origin]
      : [];
  if (additions.length === 0) {
    return c.json<ApiResponse>(
      { ok: false, error: "origin or origins is required" },
      400,
    );
  }

  const normalizedAdditions = normalizeAllowedOrigins(additions);
  if (typeof normalizedAdditions === "string") {
    return c.json<ApiResponse>({ ok: false, error: normalizedAdditions }, 400);
  }
  const current = await readAllowedOriginsForTenant(tenantId);
  const next = normalizeAllowedOrigins([...current, ...normalizedAdditions]);
  if (typeof next === "string") {
    return c.json<ApiResponse>({ ok: false, error: next }, 400);
  }
  await writeAuditEvent({
    tenantId,
    actorType: "user",
    actorId: c.get("userId") ?? tenantId,
    action: "tenant.app_origin.add.authorized",
    resourceType: "tenant_config",
    resourceId: tenantId,
    metadata: { added: normalizedAdditions },
    ipAddress: c.req.header("x-forwarded-for") ?? null,
    userAgent: c.req.header("user-agent") ?? null,
    requestId: c.get("requestId") ?? null,
  });
  const entries = await withTenantAuditedTransaction(
    tenantId,
    async (txRaw, appendRequiredAudit) => {
      const tx = txRaw as typeof db;
      const latest = await readAllowedOriginsForTenant(tenantId, tx);
      const transactionNext = normalizeAllowedOrigins([
        ...latest,
        ...normalizedAdditions,
      ]);
      if (typeof transactionNext === "string") throw new Error(transactionNext);
      const updated = await persistAllowedOriginsForTenant(
        tenantId,
        transactionNext,
        tx,
      );
      await appendRequiredAudit({
        tenantId,
        actorType: "user",
        actorId: c.get("userId") ?? tenantId,
        action: "tenant.app_origin.add",
        resourceType: "tenant_config",
        resourceId: tenantId,
        metadata: {
          added: normalizedAdditions,
          allowedOriginsCount: updated.length,
        },
        ipAddress: c.req.header("x-forwarded-for") ?? null,
        userAgent: c.req.header("user-agent") ?? null,
        requestId: c.get("requestId") ?? null,
      });
      return updated;
    },
  );
  invalidateTenantCorsCache(tenantId);

  return c.json<ApiResponse<{ entries: string[] }>>({
    ok: true,
    data: { entries },
  });
});

tenantConfigRoutes.delete("/:id/app-origins", requireTenantId, async (c) => {
  const mfaResponse = await requireRecentTenantAdminMfa(
    c,
    "App origin updates",
  );
  if (mfaResponse) return mfaResponse;

  const tenantId = c.req.param("id") as string;
  const body = await safeJsonParse<{ origin?: unknown; origins?: unknown }>(c);
  if (!body) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid JSON in request body" },
      400,
    );
  }
  const removals = Array.isArray(body.origins)
    ? body.origins
    : body.origin !== undefined
      ? [body.origin]
      : [];
  if (removals.length === 0) {
    return c.json<ApiResponse>(
      { ok: false, error: "origin or origins is required" },
      400,
    );
  }

  const normalizedRemovals = normalizeAllowedOrigins(removals);
  if (typeof normalizedRemovals === "string") {
    return c.json<ApiResponse>({ ok: false, error: normalizedRemovals }, 400);
  }
  const removalSet = new Set(normalizedRemovals);
  await writeAuditEvent({
    tenantId,
    actorType: "user",
    actorId: c.get("userId") ?? tenantId,
    action: "tenant.app_origin.remove.authorized",
    resourceType: "tenant_config",
    resourceId: tenantId,
    metadata: { removed: normalizedRemovals },
    ipAddress: c.req.header("x-forwarded-for") ?? null,
    userAgent: c.req.header("user-agent") ?? null,
    requestId: c.get("requestId") ?? null,
  });
  const entries = await withTenantAuditedTransaction(
    tenantId,
    async (txRaw, appendRequiredAudit) => {
      const tx = txRaw as typeof db;
      const latest = await readAllowedOriginsForTenant(tenantId, tx);
      const transactionNext = latest.filter(
        (origin) => !removalSet.has(origin),
      );
      const updated = await persistAllowedOriginsForTenant(
        tenantId,
        transactionNext,
        tx,
      );
      await appendRequiredAudit({
        tenantId,
        actorType: "user",
        actorId: c.get("userId") ?? tenantId,
        action: "tenant.app_origin.remove",
        resourceType: "tenant_config",
        resourceId: tenantId,
        metadata: {
          removed: normalizedRemovals,
          allowedOriginsCount: updated.length,
        },
        ipAddress: c.req.header("x-forwarded-for") ?? null,
        userAgent: c.req.header("user-agent") ?? null,
        requestId: c.get("requestId") ?? null,
      });
      return updated;
    },
  );
  invalidateTenantCorsCache(tenantId);

  return c.json<ApiResponse<{ entries: string[] }>>({
    ok: true,
    data: { entries },
  });
});

// ─── App clients / environments ─────────────────────────────────────────────

tenantConfigRoutes.get("/:id/app-clients", requireTenantId, async (c) => {
  const mfaResponse = await requireRecentTenantAdminMfa(c, "App client access");
  if (mfaResponse) return mfaResponse;

  const tenantId = c.req.param("id") as string;
  const clients = await readTenantAppClientsForTenant(tenantId);
  return c.json<ApiResponse<{ clients: TenantAppClient[] }>>({
    ok: true,
    data: { clients },
  });
});

tenantConfigRoutes.put("/:id/app-clients", requireTenantId, async (c) => {
  const mfaResponse = await requireRecentTenantAdminMfa(
    c,
    "App client updates",
  );
  if (mfaResponse) return mfaResponse;

  const tenantId = c.req.param("id") as string;
  const body = await safeJsonParse<{ clients?: unknown; appClients?: unknown }>(
    c,
  );
  if (!body) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid JSON in request body" },
      400,
    );
  }
  const normalized = normalizeTenantAppClients(body.clients ?? body.appClients);
  if (typeof normalized === "string") {
    return c.json<ApiResponse>({ ok: false, error: normalized }, 400);
  }

  await writeAuditEvent({
    tenantId,
    actorType: "user",
    actorId: c.get("userId") ?? tenantId,
    action: "tenant.app_client.replace.authorized",
    resourceType: "tenant_app_client",
    resourceId: tenantId,
    metadata: { appClientsCount: normalized.length },
    ipAddress: c.req.header("x-forwarded-for") ?? null,
    userAgent: c.req.header("user-agent") ?? null,
    requestId: c.get("requestId") ?? null,
  });

  const clients = await withTenantAuditedTransaction(
    tenantId,
    async (txRaw, appendRequiredAudit) => {
      const tx = txRaw as typeof db;
      const persisted = await persistTenantAppClientsForTenant(
        tenantId,
        normalized,
        tx,
      );
      await appendRequiredAudit({
        tenantId,
        actorType: "user",
        actorId: c.get("userId") ?? tenantId,
        action: "tenant.app_client.replace",
        resourceType: "tenant_app_client",
        resourceId: tenantId,
        metadata: { appClientsCount: persisted.length },
        ipAddress: c.req.header("x-forwarded-for") ?? null,
        userAgent: c.req.header("user-agent") ?? null,
        requestId: c.get("requestId") ?? null,
      });
      return persisted;
    },
  );
  invalidateTenantCorsCache(tenantId);

  return c.json<ApiResponse<{ clients: TenantAppClient[] }>>({
    ok: true,
    data: { clients },
  });
});

tenantConfigRoutes.post("/:id/app-clients", requireTenantId, async (c) => {
  const mfaResponse = await requireRecentTenantAdminMfa(
    c,
    "App client updates",
  );
  if (mfaResponse) return mfaResponse;

  const tenantId = c.req.param("id") as string;
  const body = await safeJsonParse<{ client?: unknown }>(c);
  if (!body) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid JSON in request body" },
      400,
    );
  }
  const normalized = normalizeTenantAppClients(
    body.client ? [body.client] : undefined,
  );
  if (typeof normalized === "string") {
    return c.json<ApiResponse>({ ok: false, error: normalized }, 400);
  }
  if (normalized.length !== 1) {
    return c.json<ApiResponse>({ ok: false, error: "client is required" }, 400);
  }

  const current = await readTenantAppClientsForTenant(tenantId);
  if (current.some((client) => client.id === normalized[0].id)) {
    return c.json<ApiResponse>(
      { ok: false, error: "app client already exists" },
      409,
    );
  }
  const requestedDefault =
    body.client &&
    typeof body.client === "object" &&
    !Array.isArray(body.client)
      ? (body.client as Record<string, unknown>).isDefault === true
      : false;
  const currentForInsert = requestedDefault
    ? current.map((client) => ({ ...client, isDefault: false }))
    : current;
  const clientForInsert =
    current.some((client) => client.isDefault === true) && !requestedDefault
      ? { ...normalized[0], isDefault: false }
      : normalized[0];
  const clients = normalizeTenantAppClients([
    ...currentForInsert,
    clientForInsert,
  ]);
  if (typeof clients === "string") {
    return c.json<ApiResponse>({ ok: false, error: clients }, 400);
  }
  await writeAuditEvent({
    tenantId,
    actorType: "user",
    actorId: c.get("userId") ?? tenantId,
    action: "tenant.app_client.create.authorized",
    resourceType: "tenant_app_client",
    resourceId: normalized[0].id,
    metadata: { appClientsCount: clients.length },
    ipAddress: c.req.header("x-forwarded-for") ?? null,
    userAgent: c.req.header("user-agent") ?? null,
    requestId: c.get("requestId") ?? null,
  });
  const persisted = await withTenantAuditedTransaction(
    tenantId,
    async (txRaw, appendRequiredAudit) => {
      const tx = txRaw as typeof db;
      const latest = await readTenantAppClientsForTenant(tenantId, tx);
      if (latest.some((client) => client.id === normalized[0].id)) return null;
      const latestForInsert = requestedDefault
        ? latest.map((client) => ({ ...client, isDefault: false }))
        : latest;
      const latestClientForInsert =
        latest.some((client) => client.isDefault === true) && !requestedDefault
          ? { ...normalized[0], isDefault: false }
          : normalized[0];
      const transactionClients = normalizeTenantAppClients([
        ...latestForInsert,
        latestClientForInsert,
      ]);
      if (typeof transactionClients === "string")
        throw new Error(transactionClients);
      const updated = await persistTenantAppClientsForTenant(
        tenantId,
        transactionClients,
        tx,
      );
      await appendRequiredAudit({
        tenantId,
        actorType: "user",
        actorId: c.get("userId") ?? tenantId,
        action: "tenant.app_client.create",
        resourceType: "tenant_app_client",
        resourceId: normalized[0].id,
        metadata: { appClientsCount: updated.length },
        ipAddress: c.req.header("x-forwarded-for") ?? null,
        userAgent: c.req.header("user-agent") ?? null,
        requestId: c.get("requestId") ?? null,
      });
      return updated;
    },
  );
  if (!persisted) {
    return c.json<ApiResponse>(
      { ok: false, error: "app client already exists" },
      409,
    );
  }
  invalidateTenantCorsCache(tenantId);

  return c.json<
    ApiResponse<{ clients: TenantAppClient[]; client: TenantAppClient }>
  >(
    {
      ok: true,
      data: {
        clients: persisted,
        client:
          persisted.find((client) => client.id === normalized[0].id) ??
          normalized[0],
      },
    },
    201,
  );
});

tenantConfigRoutes.get(
  "/:id/app-clients/:clientId/secrets",
  requireTenantId,
  async (c) => {
    const mfaResponse = await requireRecentTenantAdminMfa(
      c,
      "App client secret access",
    );
    if (mfaResponse) return mfaResponse;

    const tenantId = c.req.param("id") as string;
    const clientId = normalizeAppClientId(c.req.param("clientId"));
    if (!clientId)
      return c.json<ApiResponse>(
        { ok: false, error: "Invalid app client id" },
        400,
      );

    const rows = await db
      .select()
      .from(tenantAppClientSecrets)
      .where(
        and(
          eq(tenantAppClientSecrets.tenantId, tenantId),
          eq(tenantAppClientSecrets.clientId, clientId),
        ),
      );
    return c.json<
      ApiResponse<{ secrets: TenantAppClientSecret[]; appId: string }>
    >({
      ok: true,
      data: {
        appId: appIdFor(tenantId, clientId),
        secrets: rows.map(serializeTenantAppClientSecret),
      },
    });
  },
);

tenantConfigRoutes.post(
  "/:id/app-clients/:clientId/secrets",
  requireTenantId,
  async (c) => {
    const mfaResponse = await requireRecentTenantAdminMfa(
      c,
      "App client secret rotation",
    );
    if (mfaResponse) return mfaResponse;

    const tenantId = c.req.param("id") as string;
    const clientId = normalizeAppClientId(c.req.param("clientId"));
    if (!clientId)
      return c.json<ApiResponse>(
        { ok: false, error: "Invalid app client id" },
        400,
      );

    const [client] = await db
      .select({ id: tenantAppClientsTable.id })
      .from(tenantAppClientsTable)
      .where(
        and(
          eq(tenantAppClientsTable.tenantId, tenantId),
          eq(tenantAppClientsTable.id, clientId),
        ),
      );
    if (!client)
      return c.json<ApiResponse>(
        { ok: false, error: "app client not found" },
        404,
      );

    const generated = generateAppSecret();
    const retiringExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await writeAuditEvent({
      tenantId,
      actorType: "user",
      actorId: c.get("userId") ?? tenantId,
      action: "tenant.app_client_secret.rotate.authorized",
      resourceType: "tenant_app_client",
      resourceId: clientId,
      metadata: { appId: appIdFor(tenantId, clientId) },
      ipAddress: c.req.header("x-forwarded-for") ?? null,
      userAgent: c.req.header("user-agent") ?? null,
      requestId: c.get("requestId") ?? null,
    });

    const inserted = await withTenantAuditedTransaction(
      tenantId,
      async (txRaw, appendRequiredAudit) => {
        const tx = txRaw as typeof db;
        await tx
          .update(tenantAppClientSecrets)
          .set({
            status: "retiring",
            expiresAt: retiringExpiresAt,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(tenantAppClientSecrets.tenantId, tenantId),
              eq(tenantAppClientSecrets.clientId, clientId),
              eq(tenantAppClientSecrets.status, "active"),
            ),
          );
        const [created] = await tx
          .insert(tenantAppClientSecrets)
          .values({
            tenantId,
            clientId,
            secretHash: generated.hash,
            secretPrefix: generated.prefix,
            status: "active",
          })
          .returning();
        await appendRequiredAudit({
          tenantId,
          actorType: "user",
          actorId: c.get("userId") ?? tenantId,
          action: "tenant.app_client_secret.rotate",
          resourceType: "tenant_app_client_secret",
          resourceId: created.id,
          metadata: {
            appId: appIdFor(tenantId, clientId),
            previousSecretsRetireAt: retiringExpiresAt,
          },
          ipAddress: c.req.header("x-forwarded-for") ?? null,
          userAgent: c.req.header("user-agent") ?? null,
          requestId: c.get("requestId") ?? null,
        });
        return created;
      },
    );

    setNoStoreHeaders(c);
    return c.json<ApiResponse<TenantAppClientSecretCreateResult>>(
      {
        ok: true,
        data: {
          secret: serializeTenantAppClientSecret(inserted),
          appId: appIdFor(tenantId, clientId),
          appSecret: generated.secret,
        },
      },
      201,
    );
  },
);

tenantConfigRoutes.delete(
  "/:id/app-clients/:clientId/secrets/:secretId",
  requireTenantId,
  async (c) => {
    const mfaResponse = await requireRecentTenantAdminMfa(
      c,
      "App client secret revocation",
    );
    if (mfaResponse) return mfaResponse;

    const tenantId = c.req.param("id") as string;
    const clientId = normalizeAppClientId(c.req.param("clientId"));
    const secretId = c.req.param("secretId");
    if (!clientId)
      return c.json<ApiResponse>(
        { ok: false, error: "Invalid app client id" },
        400,
      );
    if (!secretId)
      return c.json<ApiResponse>(
        { ok: false, error: "Invalid app client secret id" },
        400,
      );

    await writeAuditEvent({
      tenantId,
      actorType: "user",
      actorId: c.get("userId") ?? tenantId,
      action: "tenant.app_client_secret.revoke.authorized",
      resourceType: "tenant_app_client_secret",
      resourceId: secretId,
      metadata: { appId: appIdFor(tenantId, clientId) },
      ipAddress: c.req.header("x-forwarded-for") ?? null,
      userAgent: c.req.header("user-agent") ?? null,
      requestId: c.get("requestId") ?? null,
    });

    const row = await withTenantAuditedTransaction(
      tenantId,
      async (txRaw, appendRequiredAudit) => {
        const tx = txRaw as typeof db;
        const [updated] = await tx
          .update(tenantAppClientSecrets)
          .set({
            status: "revoked",
            revokedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(tenantAppClientSecrets.tenantId, tenantId),
              eq(tenantAppClientSecrets.clientId, clientId),
              eq(tenantAppClientSecrets.id, secretId),
            ),
          )
          .returning();
        if (!updated) return null;
        await appendRequiredAudit({
          tenantId,
          actorType: "user",
          actorId: c.get("userId") ?? tenantId,
          action: "tenant.app_client_secret.revoke",
          resourceType: "tenant_app_client_secret",
          resourceId: updated.id,
          metadata: { appId: appIdFor(tenantId, clientId) },
          ipAddress: c.req.header("x-forwarded-for") ?? null,
          userAgent: c.req.header("user-agent") ?? null,
          requestId: c.get("requestId") ?? null,
        });
        return updated;
      },
    );
    if (!row)
      return c.json<ApiResponse>(
        { ok: false, error: "app client secret not found" },
        404,
      );

    return c.json<ApiResponse<{ secret: TenantAppClientSecret }>>({
      ok: true,
      data: { secret: serializeTenantAppClientSecret(row) },
    });
  },
);

tenantConfigRoutes.delete(
  "/:id/app-clients/:clientId",
  requireTenantId,
  async (c) => {
    const mfaResponse = await requireRecentTenantAdminMfa(
      c,
      "App client updates",
    );
    if (mfaResponse) return mfaResponse;

    const tenantId = c.req.param("id") as string;
    const clientId = normalizeAppClientId(c.req.param("clientId"));
    if (!clientId) {
      return c.json<ApiResponse>(
        { ok: false, error: "Invalid app client id" },
        400,
      );
    }
    const current = await readTenantAppClientsForTenant(tenantId);
    const next = current.filter((client) => client.id !== clientId);
    if (next.length === current.length) {
      return c.json<ApiResponse>(
        { ok: false, error: "app client not found" },
        404,
      );
    }
    await writeAuditEvent({
      tenantId,
      actorType: "user",
      actorId: c.get("userId") ?? tenantId,
      action: "tenant.app_client.delete.authorized",
      resourceType: "tenant_app_client",
      resourceId: clientId,
      metadata: { appClientsCount: next.length },
      ipAddress: c.req.header("x-forwarded-for") ?? null,
      userAgent: c.req.header("user-agent") ?? null,
      requestId: c.get("requestId") ?? null,
    });
    const clients = await withTenantAuditedTransaction(
      tenantId,
      async (txRaw, appendRequiredAudit) => {
        const tx = txRaw as typeof db;
        const latest = await readTenantAppClientsForTenant(tenantId, tx);
        const transactionNext = latest.filter(
          (client) => client.id !== clientId,
        );
        if (transactionNext.length === latest.length) return null;
        const updated = await persistTenantAppClientsForTenant(
          tenantId,
          transactionNext,
          tx,
        );
        await appendRequiredAudit({
          tenantId,
          actorType: "user",
          actorId: c.get("userId") ?? tenantId,
          action: "tenant.app_client.delete",
          resourceType: "tenant_app_client",
          resourceId: clientId,
          metadata: { appClientsCount: updated.length },
          ipAddress: c.req.header("x-forwarded-for") ?? null,
          userAgent: c.req.header("user-agent") ?? null,
          requestId: c.get("requestId") ?? null,
        });
        return updated;
      },
    );
    if (!clients)
      return c.json<ApiResponse>(
        { ok: false, error: "app client not found" },
        404,
      );
    invalidateTenantCorsCache(tenantId);

    return c.json<ApiResponse<{ clients: TenantAppClient[] }>>({
      ok: true,
      data: { clients },
    });
  },
);

// ─── Tenant-admin test account credentials ──────────────────────────────────

tenantConfigRoutes.get("/:id/test-account", requireTenantId, async (c) => {
  const mfaResponse = await requireRecentTenantAdminMfa(
    c,
    "Test account access",
  );
  if (mfaResponse) return mfaResponse;

  const tenantId = c.req.param("id") as string;
  const [row] = await db
    .select({ testAccount: tenantConfigsTable.testAccount })
    .from(tenantConfigsTable)
    .where(eq(tenantConfigsTable.tenantId, tenantId));

  return c.json<ApiResponse<{ testAccount: TenantTestAccountConfig }>>({
    ok: true,
    data: { testAccount: publicTestAccount(row?.testAccount) },
  });
});

tenantConfigRoutes.post("/:id/test-account", requireTenantId, async (c) => {
  const mfaResponse = await requireRecentTenantAdminMfa(
    c,
    "Test account updates",
  );
  if (mfaResponse) return mfaResponse;

  const tenantId = c.req.param("id") as string;
  const { testAccount, otp } = createTenantTestAccountConfig();
  await writeAuditEvent({
    tenantId,
    actorType: "user",
    actorId: c.get("userId") ?? null,
    action: "tenant.test_account.enable.authorized",
    resourceType: "tenant",
    resourceId: tenantId,
    metadata: {
      email: testAccount.email,
      phone: testAccount.phone,
      rotated: true,
    },
    ipAddress: c.req.header("x-forwarded-for") ?? null,
    userAgent: c.req.header("user-agent") ?? null,
    requestId: c.get("requestId") ?? null,
  });
  const row = await withTenantAuditedTransaction(
    tenantId,
    async (txRaw, appendRequiredAudit) => {
      const tx = txRaw as typeof db;
      const [updated] = await tx
        .insert(tenantConfigsTable)
        .values({ tenantId, testAccount })
        .onConflictDoUpdate({
          target: tenantConfigsTable.tenantId,
          set: { testAccount, updatedAt: new Date() },
        })
        .returning({ testAccount: tenantConfigsTable.testAccount });
      await appendRequiredAudit({
        tenantId,
        actorType: "user",
        actorId: c.get("userId") ?? null,
        action: "tenant.test_account.enable",
        resourceType: "tenant",
        resourceId: tenantId,
        metadata: {
          email: testAccount.email,
          phone: testAccount.phone,
          rotated: true,
        },
        ipAddress: c.req.header("x-forwarded-for") ?? null,
        userAgent: c.req.header("user-agent") ?? null,
        requestId: c.get("requestId") ?? null,
      });
      return updated;
    },
  );

  return c.json<ApiResponse<{ testAccount: TenantTestAccountConfig }>>({
    ok: true,
    data: { testAccount: publicTestAccount(row?.testAccount, otp) },
  });
});

tenantConfigRoutes.delete("/:id/test-account", requireTenantId, async (c) => {
  const mfaResponse = await requireRecentTenantAdminMfa(
    c,
    "Test account updates",
  );
  if (mfaResponse) return mfaResponse;

  const tenantId = c.req.param("id") as string;
  const disabled = { enabled: false, updatedAt: new Date().toISOString() };
  await writeAuditEvent({
    tenantId,
    actorType: "user",
    actorId: c.get("userId") ?? null,
    action: "tenant.test_account.disable.authorized",
    resourceType: "tenant",
    resourceId: tenantId,
    metadata: {},
    ipAddress: c.req.header("x-forwarded-for") ?? null,
    userAgent: c.req.header("user-agent") ?? null,
    requestId: c.get("requestId") ?? null,
  });
  await withTenantAuditedTransaction(
    tenantId,
    async (txRaw, appendRequiredAudit) => {
      const tx = txRaw as typeof db;
      await tx
        .insert(tenantConfigsTable)
        .values({ tenantId, testAccount: disabled })
        .onConflictDoUpdate({
          target: tenantConfigsTable.tenantId,
          set: { testAccount: disabled, updatedAt: new Date() },
        });
      await appendRequiredAudit({
        tenantId,
        actorType: "user",
        actorId: c.get("userId") ?? null,
        action: "tenant.test_account.disable",
        resourceType: "tenant",
        resourceId: tenantId,
        metadata: {},
        ipAddress: c.req.header("x-forwarded-for") ?? null,
        userAgent: c.req.header("user-agent") ?? null,
        requestId: c.get("requestId") ?? null,
      });
    },
  );

  return c.json<ApiResponse<{ testAccount: TenantTestAccountConfig }>>({
    ok: true,
    data: { testAccount: { enabled: false } },
  });
});

// ─── PUT /tenants/:id/config — update tenant control plane config ─────────────

tenantConfigRoutes.put("/:id/config", requireTenantId, async (c) => {
  const mfaResponse = await requireRecentTenantAdminMfa(
    c,
    "Tenant config updates",
  );
  if (mfaResponse) return mfaResponse;

  const tenantId = c.req.param("id") as string;
  const body = await safeJsonParse<Partial<TenantControlPlaneConfig>>(c);

  if (!body) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid JSON in request body" },
      400,
    );
  }

  const touchesSecurityConfig =
    body.allowedOrigins !== undefined ||
    body.allowedRedirectUrls !== undefined ||
    body.appClients !== undefined ||
    body.gasSponsorshipConfig !== undefined ||
    body.authAbuseConfig !== undefined ||
    body.featureFlags !== undefined;
  if (touchesSecurityConfig && !requireTenantAdminSession(c)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          "allowedOrigins, allowedRedirectUrls, appClients, featureFlags, gasSponsorshipConfig, and authAbuseConfig updates require an owner or admin user session",
      },
      403,
    );
  }

  const authAbuseConfig = normalizeAuthAbuseConfig(body.authAbuseConfig);
  if (typeof authAbuseConfig === "string") {
    return c.json<ApiResponse>({ ok: false, error: authAbuseConfig }, 400);
  }
  const gasSponsorshipConfig = normalizeGasSponsorshipConfig(
    body.gasSponsorshipConfig,
  );
  if (typeof gasSponsorshipConfig === "string") {
    return c.json<ApiResponse>({ ok: false, error: gasSponsorshipConfig }, 400);
  }

  const allowedOrigins = normalizeAllowedOrigins(body.allowedOrigins);
  if (typeof allowedOrigins === "string") {
    return c.json<ApiResponse>({ ok: false, error: allowedOrigins }, 400);
  }
  const allowedRedirectUrls = normalizeAllowedRedirectUrls(
    body.allowedRedirectUrls,
  );
  if (typeof allowedRedirectUrls === "string") {
    return c.json<ApiResponse>({ ok: false, error: allowedRedirectUrls }, 400);
  }
  const appClients = normalizeTenantAppClients(body.appClients);
  if (typeof appClients === "string") {
    return c.json<ApiResponse>({ ok: false, error: appClients }, 400);
  }
  const theme = normalizeTenantTheme(body.theme);
  if (typeof theme === "string") {
    return c.json<ApiResponse>({ ok: false, error: theme }, 400);
  }

  const [existingConfig] = await db
    .select({
      displayName: tenantConfigsTable.displayName,
      policyExposure: tenantConfigsTable.policyExposure,
      policyTemplates: tenantConfigsTable.policyTemplates,
      secretRoutePresets: tenantConfigsTable.secretRoutePresets,
      approvalConfig: tenantConfigsTable.approvalConfig,
      featureFlags: tenantConfigsTable.featureFlags,
      theme: tenantConfigsTable.theme,
      allowedOrigins: tenantConfigsTable.allowedOrigins,
      allowedRedirectUrls: tenantConfigsTable.allowedRedirectUrls,
      authAbuseConfig: tenantConfigsTable.authAbuseConfig,
      gasSponsorshipConfig: tenantConfigsTable.gasSponsorshipConfig,
    })
    .from(tenantConfigsTable)
    .where(eq(tenantConfigsTable.tenantId, tenantId));

  const defaultConfig =
    DEFAULT_TENANT_CONFIGS[tenantId] ?? emptyTenantConfig(tenantId);
  const existingFeatureFlags =
    (existingConfig?.featureFlags as TenantFeatureFlags | undefined) ??
    defaultConfig.featureFlags ??
    {};
  const featureFlags = normalizeTenantFeatureFlags(
    body.featureFlags,
    existingFeatureFlags,
  );
  if (typeof featureFlags === "string") {
    return c.json<ApiResponse>({ ok: false, error: featureFlags }, 400);
  }
  const values = {
    tenantId,
    displayName:
      body.displayName !== undefined
        ? body.displayName
        : (existingConfig?.displayName ?? defaultConfig.displayName ?? null),
    policyExposure:
      body.policyExposure !== undefined
        ? body.policyExposure
        : ((existingConfig?.policyExposure as
            | PolicyExposureConfig
            | undefined) ??
          defaultConfig.policyExposure ??
          {}),
    policyTemplates:
      body.policyTemplates !== undefined
        ? body.policyTemplates
        : ((existingConfig?.policyTemplates as PolicyTemplate[] | undefined) ??
          defaultConfig.policyTemplates ??
          []),
    secretRoutePresets:
      body.secretRoutePresets !== undefined
        ? body.secretRoutePresets
        : ((existingConfig?.secretRoutePresets as
            | SecretRoutePreset[]
            | undefined) ??
          defaultConfig.secretRoutePresets ??
          []),
    approvalConfig:
      body.approvalConfig !== undefined
        ? body.approvalConfig
        : ((existingConfig?.approvalConfig as ApprovalConfig | undefined) ??
          defaultConfig.approvalConfig ??
          {}),
    featureFlags:
      body.featureFlags !== undefined ? featureFlags : existingFeatureFlags,
    theme:
      body.theme !== undefined
        ? theme
        : ((existingConfig?.theme as TenantTheme | undefined) ??
          defaultConfig.theme ??
          null),
    allowedOrigins:
      body.allowedOrigins !== undefined
        ? allowedOrigins
        : (existingConfig?.allowedOrigins ?? []),
    allowedRedirectUrls:
      body.allowedRedirectUrls !== undefined
        ? allowedRedirectUrls
        : (existingConfig?.allowedRedirectUrls ??
          defaultConfig.allowedRedirectUrls ??
          []),
    authAbuseConfig:
      body.authAbuseConfig !== undefined
        ? authAbuseConfig
        : (existingConfig?.authAbuseConfig ?? {}),
    gasSponsorshipConfig:
      body.gasSponsorshipConfig !== undefined
        ? gasSponsorshipConfig
        : (existingConfig?.gasSponsorshipConfig ??
          defaultConfig.gasSponsorshipConfig ??
          {}),
  };

  const templateValidationError = await validatePolicyTemplatesForTenant(
    tenantId,
    values.policyTemplates,
  );
  if (templateValidationError) {
    return c.json<ApiResponse>(
      { ok: false, error: templateValidationError },
      400,
    );
  }

  await writeAuditEvent({
    tenantId,
    actorType: "user",
    actorId: c.get("userId") ?? tenantId,
    action: "tenant.config.update.authorized",
    resourceType: "tenant_config",
    resourceId: tenantId,
    metadata: {
      templatesCount: values.policyTemplates.length,
      presetsCount: values.secretRoutePresets.length,
      allowedOriginsCount: values.allowedOrigins.length,
      allowedRedirectUrlsCount: values.allowedRedirectUrls.length,
      appClientsCount:
        body.appClients !== undefined ? appClients.length : undefined,
      hasAuthAbuseConfig: Object.keys(values.authAbuseConfig).length > 0,
      gasSponsorshipEnabled: values.gasSponsorshipConfig.enabled === true,
      embeddedWalletCreateOnLogin:
        values.featureFlags.embeddedWallets?.createOnLogin,
      hasTheme: !!values.theme,
    },
    ipAddress: c.req.header("x-forwarded-for") ?? null,
    userAgent: c.req.header("user-agent") ?? null,
    requestId: c.get("requestId") ?? null,
  });

  const mutation = await withTenantAuditedTransaction(
    tenantId,
    async (txRaw, appendRequiredAudit) => {
      const tx = txRaw as typeof db;
      const [latest] = await tx
        .select({
          displayName: tenantConfigsTable.displayName,
          policyExposure: tenantConfigsTable.policyExposure,
          policyTemplates: tenantConfigsTable.policyTemplates,
          secretRoutePresets: tenantConfigsTable.secretRoutePresets,
          approvalConfig: tenantConfigsTable.approvalConfig,
          featureFlags: tenantConfigsTable.featureFlags,
          theme: tenantConfigsTable.theme,
          allowedOrigins: tenantConfigsTable.allowedOrigins,
          allowedRedirectUrls: tenantConfigsTable.allowedRedirectUrls,
          authAbuseConfig: tenantConfigsTable.authAbuseConfig,
          gasSponsorshipConfig: tenantConfigsTable.gasSponsorshipConfig,
        })
        .from(tenantConfigsTable)
        .where(eq(tenantConfigsTable.tenantId, tenantId));
      const transactionFeatureFlags =
        body.featureFlags !== undefined
          ? featureFlags
          : ((latest?.featureFlags as TenantFeatureFlags | undefined) ??
            defaultConfig.featureFlags ??
            {});
      const transactionValues = {
        ...values,
        displayName:
          body.displayName !== undefined
            ? values.displayName
            : (latest?.displayName ?? defaultConfig.displayName ?? null),
        policyExposure:
          body.policyExposure !== undefined
            ? values.policyExposure
            : ((latest?.policyExposure as PolicyExposureConfig | undefined) ??
              defaultConfig.policyExposure ??
              {}),
        policyTemplates:
          body.policyTemplates !== undefined
            ? values.policyTemplates
            : ((latest?.policyTemplates as PolicyTemplate[] | undefined) ??
              defaultConfig.policyTemplates ??
              []),
        secretRoutePresets:
          body.secretRoutePresets !== undefined
            ? values.secretRoutePresets
            : ((latest?.secretRoutePresets as
                | SecretRoutePreset[]
                | undefined) ??
              defaultConfig.secretRoutePresets ??
              []),
        approvalConfig:
          body.approvalConfig !== undefined
            ? values.approvalConfig
            : ((latest?.approvalConfig as ApprovalConfig | undefined) ??
              defaultConfig.approvalConfig ??
              {}),
        featureFlags: transactionFeatureFlags,
        theme:
          body.theme !== undefined
            ? values.theme
            : ((latest?.theme as TenantTheme | undefined) ??
              defaultConfig.theme ??
              null),
        allowedOrigins:
          body.allowedOrigins !== undefined
            ? allowedOrigins
            : (latest?.allowedOrigins ?? []),
        allowedRedirectUrls:
          body.allowedRedirectUrls !== undefined
            ? allowedRedirectUrls
            : (latest?.allowedRedirectUrls ??
              defaultConfig.allowedRedirectUrls ??
              []),
        authAbuseConfig:
          body.authAbuseConfig !== undefined
            ? authAbuseConfig
            : (latest?.authAbuseConfig ?? {}),
        gasSponsorshipConfig:
          body.gasSponsorshipConfig !== undefined
            ? gasSponsorshipConfig
            : (latest?.gasSponsorshipConfig ??
              defaultConfig.gasSponsorshipConfig ??
              {}),
      };
      const [row] = await tx
        .insert(tenantConfigsTable)
        .values(transactionValues)
        .onConflictDoUpdate({
          target: tenantConfigsTable.tenantId,
          set: {
            displayName: transactionValues.displayName,
            policyExposure: transactionValues.policyExposure,
            policyTemplates: transactionValues.policyTemplates,
            secretRoutePresets: transactionValues.secretRoutePresets,
            approvalConfig: transactionValues.approvalConfig,
            featureFlags: transactionValues.featureFlags,
            theme: transactionValues.theme,
            allowedOrigins: transactionValues.allowedOrigins,
            allowedRedirectUrls: transactionValues.allowedRedirectUrls,
            authAbuseConfig: transactionValues.authAbuseConfig,
            gasSponsorshipConfig: transactionValues.gasSponsorshipConfig,
            updatedAt: new Date(),
          },
        })
        .returning();

      const persistedAppClients =
        body.appClients !== undefined
          ? await persistTenantAppClientsForTenant(tenantId, appClients, tx)
          : await readTenantAppClientsForTenant(tenantId, tx);
      await appendRequiredAudit({
        tenantId,
        actorType: "user",
        actorId: c.get("userId") ?? tenantId,
        action: "tenant.config.update",
        resourceType: "tenant_config",
        resourceId: tenantId,
        metadata: {
          templatesCount: transactionValues.policyTemplates.length,
          presetsCount: transactionValues.secretRoutePresets.length,
          allowedOriginsCount: transactionValues.allowedOrigins.length,
          allowedRedirectUrlsCount:
            transactionValues.allowedRedirectUrls.length,
          appClientsCount: persistedAppClients.length,
          hasAuthAbuseConfig:
            Object.keys(transactionValues.authAbuseConfig).length > 0,
          gasSponsorshipEnabled:
            transactionValues.gasSponsorshipConfig.enabled === true,
          embeddedWalletCreateOnLogin:
            transactionValues.featureFlags.embeddedWallets?.createOnLogin,
          hasTheme: !!transactionValues.theme,
        },
        ipAddress: c.req.header("x-forwarded-for") ?? null,
        userAgent: c.req.header("user-agent") ?? null,
        requestId: c.get("requestId") ?? null,
      });
      return { row, persistedAppClients };
    },
  );
  const { row, persistedAppClients } = mutation;
  invalidateTenantCorsCache(tenantId);

  const config: TenantControlPlaneConfig = {
    tenantId: row.tenantId,
    displayName: row.displayName ?? undefined,
    policyExposure: row.policyExposure as PolicyExposureConfig,
    policyTemplates: row.policyTemplates as PolicyTemplate[],
    secretRoutePresets: row.secretRoutePresets as SecretRoutePreset[],
    approvalConfig: row.approvalConfig as ApprovalConfig,
    featureFlags: row.featureFlags as TenantFeatureFlags,
    theme: row.theme as TenantTheme | undefined,
    allowedOrigins: row.allowedOrigins ?? [],
    allowedRedirectUrls: row.allowedRedirectUrls ?? [],
    appClients: persistedAppClients,
    oidcProviders: row.oidcProviders ?? [],
    authAbuseConfig: row.authAbuseConfig as TenantAuthAbuseConfig,
    gasSponsorshipConfig:
      row.gasSponsorshipConfig as TenantGasSponsorshipConfig,
    testAccount: publicTestAccount(row.testAccount),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };

  return c.json<ApiResponse<TenantControlPlaneConfig>>({
    ok: true,
    data: redactAdminOnlyConfigForTenantAuth(c, config),
  });
});

// ─── GET /tenants/:id/config/templates — list policy templates ────────────────

tenantConfigRoutes.get("/:id/config/templates", requireTenantId, async (c) => {
  if (!requireTenantLevel(c)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Policy template access requires tenant-level authentication",
      },
      403,
    );
  }

  const tenantId = c.req.param("id") as string;

  const [row] = await db
    .select({
      policyExposure: tenantConfigsTable.policyExposure,
      policyTemplates: tenantConfigsTable.policyTemplates,
    })
    .from(tenantConfigsTable)
    .where(eq(tenantConfigsTable.tenantId, tenantId));

  if (row) {
    return c.json<ApiResponse<PolicyTemplate[]>>({
      ok: true,
      data:
        requireTenantAdminSession(c) && hasRecentSessionMfa(c)
          ? (row.policyTemplates as PolicyTemplate[])
          : redactPolicyTemplatesForTenantAuth(
              row.policyTemplates as PolicyTemplate[],
              row.policyExposure as PolicyExposureConfig,
            ),
    });
  }

  // Fall back to defaults
  const defaultConfig = DEFAULT_TENANT_CONFIGS[tenantId];
  return c.json<ApiResponse<PolicyTemplate[]>>({
    ok: true,
    data:
      requireTenantAdminSession(c) && hasRecentSessionMfa(c)
        ? (defaultConfig?.policyTemplates ?? [])
        : redactPolicyTemplatesForTenantAuth(
            defaultConfig?.policyTemplates ?? [],
            defaultConfig?.policyExposure ?? {},
          ),
  });
});

// ─── POST /tenants/:id/config/templates/:name/apply — apply template to agent ─

tenantConfigRoutes.post(
  "/:id/config/templates/:name/apply",
  requireTenantId,
  async (c) => {
    const mfaResponse = await requireRecentTenantAdminMfa(
      c,
      "Policy template application",
    );
    if (mfaResponse) return mfaResponse;

    const tenantId = c.req.param("id") as string;
    const templateName = c.req.param("name");

    const body = await safeJsonParse<{
      agentId: string;
      overrides?: Record<string, unknown>;
    }>(c);

    if (!body?.agentId) {
      return c.json<ApiResponse>(
        { ok: false, error: "agentId is required" },
        400,
      );
    }

    const agent = await ensureAgentForTenant(tenantId, body.agentId);
    if (!agent) {
      return c.json<ApiResponse>({ ok: false, error: "Agent not found" }, 404);
    }

    // Get templates from DB or defaults
    let templates: PolicyTemplate[] = [];
    const [row] = await db
      .select({ policyTemplates: tenantConfigsTable.policyTemplates })
      .from(tenantConfigsTable)
      .where(eq(tenantConfigsTable.tenantId, tenantId));

    if (row) {
      templates = row.policyTemplates as PolicyTemplate[];
    } else {
      const defaultConfig = DEFAULT_TENANT_CONFIGS[tenantId];
      templates = defaultConfig?.policyTemplates ?? [];
    }

    const templatesError = await validatePolicyTemplatesForTenant(
      tenantId,
      templates,
    );
    if (templatesError) {
      return c.json<ApiResponse>({ ok: false, error: templatesError }, 400);
    }

    const template = templates.find(
      (t) => t.id === templateName || t.name === templateName,
    );
    if (!template) {
      return c.json<ApiResponse>(
        { ok: false, error: `Template "${templateName}" not found` },
        404,
      );
    }

    // Apply overrides to template policies
    const policiesToApply = structuredClone(template.policies);

    if (body.overrides) {
      const customizableFields = new Map(
        (template.customizableFields ?? []).map((field) => [field.path, field]),
      );
      for (const [path, value] of Object.entries(body.overrides)) {
        const field = customizableFields.get(path);
        if (!field) {
          return c.json<ApiResponse>(
            { ok: false, error: `Override not allowed: ${path}` },
            400,
          );
        }
        const [policyType, configKey] = path.split(".");
        const policy = policiesToApply.find((p) => p.type === policyType);
        if (!policy || !configKey) {
          return c.json<ApiResponse>(
            { ok: false, error: `Invalid override path: ${path}` },
            400,
          );
        }
        const normalized = normalizeTemplateOverride(field, value);
        if (normalized === null) {
          return c.json<ApiResponse>(
            { ok: false, error: `Invalid override value: ${path}` },
            400,
          );
        }
        (policy.config as Record<string, unknown>)[configKey] = normalized;
      }
    }

    const policiesValidationError =
      getPolicyRulesValidationError(policiesToApply);
    if (policiesValidationError) {
      return c.json<ApiResponse>(
        { ok: false, error: policiesValidationError },
        400,
      );
    }
    const conditionSetValidationError =
      await getConditionSetReferenceValidationError(
        tenantId,
        policiesToApply as PolicyRule[],
      );
    if (conditionSetValidationError) {
      return c.json<ApiResponse>(
        { ok: false, error: conditionSetValidationError },
        400,
      );
    }

    const persistedPolicies = policiesToApply.map(toPersistedPolicyRule);
    await writeAuditEvent({
      tenantId,
      actorType: "user",
      actorId: c.get("userId") ?? tenantId,
      action: "policy.template.apply.authorized",
      resourceType: "agent",
      resourceId: body.agentId,
      metadata: {
        templateId: template.id,
        templateName: template.name,
        policiesToApply: persistedPolicies.length,
        hasOverrides: !!body.overrides,
      },
      ipAddress: c.req.header("x-forwarded-for") ?? null,
      userAgent: c.req.header("user-agent") ?? null,
      requestId: c.get("requestId") ?? null,
    });

    const insertedPolicies = await withTenantAuditedTransaction(
      tenantId,
      async (txRaw, appendRequiredAudit) => {
        const tx = txRaw as typeof db;
        await tx.delete(policies).where(eq(policies.agentId, body.agentId));

        const insertedRows = [];
        for (const p of persistedPolicies) {
          const [inserted] = await tx
            .insert(policies)
            .values({
              id: crypto.randomUUID(),
              agentId: body.agentId,
              type: p.type,
              enabled: p.enabled,
              config: p.config,
            })
            .returning();
          if (inserted) insertedRows.push(inserted);
        }
        if (insertedRows.length !== persistedPolicies.length) {
          throw new Error("Failed to apply all policy template rules");
        }
        await appendRequiredAudit({
          tenantId,
          actorType: "user",
          actorId: c.get("userId") ?? tenantId,
          action: "policy.template.apply",
          resourceType: "agent",
          resourceId: body.agentId,
          metadata: {
            templateId: template.id,
            templateName: template.name,
            policiesApplied: insertedRows.length,
            hasOverrides: !!body.overrides,
          },
          ipAddress: c.req.header("x-forwarded-for") ?? null,
          userAgent: c.req.header("user-agent") ?? null,
          requestId: c.get("requestId") ?? null,
        });
        return insertedRows;
      },
    );

    return c.json<ApiResponse>({
      ok: true,
      data: {
        templateId: template.id,
        templateName: template.name,
        agentId: body.agentId,
        policiesApplied: insertedPolicies.length,
        policies: policiesToApply,
      },
    });
  },
);
