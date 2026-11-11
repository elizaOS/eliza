/**
 * Typed identity of one Cloud deployment: its public origins, the browser
 * origins it treats as first-party, its Steward tenant, its blob and asset
 * hosts, its mail sender, and its billing page.
 *
 * `CLOUD_DEPLOYMENT_ID` selects the deployment. Unset or `eliza` is the
 * eliza.app deployment and resolves to the values this code has always used
 * (the domain contract plus the historical per-setting defaults), so that
 * deployment's behaviour does not change. Any other id is an independent
 * product Cloud: every identity value must be configured explicitly and a
 * missing or malformed one throws `CloudDeploymentConfigError` naming the
 * setting. A product Cloud never inherits an Eliza host, tenant, or sender.
 */

import {
  ELIZA_DOMAIN_CONTRACTS,
  type ElizaCloudEnvironment,
  LEGACY_ELIZA_DOMAIN_CONTRACTS,
} from "@elizaos/plugin-elizacloud/cloud-config/domain-contract";
import { getCloudAwareEnv } from "../runtime/cloud-bindings";

export const ELIZA_CLOUD_DEPLOYMENT_ID = "eliza";
export const ELIZA_DEFAULT_STEWARD_TENANT_ID = "elizacloud";
const ELIZA_DEFAULT_BLOB_HOST = "blob.eliza.app";

/** Settings that describe a deployment. All are plain, non-secret strings. */
export const CLOUD_DEPLOYMENT_SETTINGS = [
  "CLOUD_DEPLOYMENT_ID",
  "CLOUD_WEB_ORIGIN",
  "NEXT_PUBLIC_APP_URL",
  "NEXT_PUBLIC_API_URL",
  "CLOUD_FIRST_PARTY_ORIGINS",
  "STEWARD_TENANT_ID",
  "NEXT_PUBLIC_STEWARD_TENANT_ID",
  "CLOUD_PUBLIC_SERVICE_NAME",
  "R2_PUBLIC_HOST",
  "NEXT_PUBLIC_ASSETS_CDN_URL",
  "SENDGRID_FROM_EMAIL",
  "SMTP_FROM",
  "CLOUD_BILLING_URL",
  "ENVIRONMENT",
] as const;

export type CloudDeploymentSetting = (typeof CLOUD_DEPLOYMENT_SETTINGS)[number];
export type CloudDeploymentEnv = Readonly<Record<string, string | undefined>>;

export class CloudDeploymentConfigError extends Error {
  readonly setting: string;
  readonly deploymentId: string;

  constructor(deploymentId: string, setting: string, problem: "missing" | "invalid") {
    super(
      problem === "missing"
        ? `Cloud deployment "${deploymentId}" requires ${setting}`
        : `Cloud deployment "${deploymentId}" has an invalid ${setting}`,
    );
    this.name = "CloudDeploymentConfigError";
    this.setting = setting;
    this.deploymentId = deploymentId;
  }
}

export interface CloudDeployment {
  /** Deployment id; `eliza` for the eliza.app deployment. */
  readonly id: string;
  readonly isEliza: boolean;
  /** Public site origin. */
  readonly webOrigin: string;
  /** Cloud web app origin (`NEXT_PUBLIC_APP_URL`); base for user-facing links. */
  readonly appOrigin: string;
  /** Cloud API origin. */
  readonly apiOrigin: string;
  /** Browser origins that may receive credentialed (cookie) CORS responses. */
  readonly firstPartyOrigins: ReadonlySet<string>;
  /** Browser hostnames accepted by the session-mutation CSRF check. */
  readonly browserOriginHosts: ReadonlySet<string>;
  /** Origins reflected by the public auth-route CORS helper. */
  readonly authCorsOrigins: ReadonlySet<string>;
  /** Absolute redirect origins accepted after platform OAuth and checkout. */
  readonly platformRedirectOrigins: readonly string[];
  /** Origins a Stripe checkout may return to. */
  readonly checkoutReturnOrigins: readonly string[];
  /** Default Steward tenant. */
  readonly tenantId: string;
  /** Public service name. */
  readonly serviceName: string;
  /** Public blob host (`host[:port]`, no scheme). */
  readonly blobHost: string;
  /** Base URL of static assets, without a trailing slash. */
  readonly assetsBase: string;
  /** Sender address for transactional mail. */
  readonly mailFrom: string;
  /** Page a user is sent to when credits run out. */
  readonly billingUrl: string;
  /**
   * Origin that namespaces derived speech-consent session ids. It is an
   * identity seed, never fetched; changing it changes every derived id.
   */
  readonly speechConsentOrigin: string;
}

function setting(env: CloudDeploymentEnv, name: string): string | undefined {
  const value = env[name];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/** Parse an exact https origin (http only on loopback); null when it is not one. */
function parseOrigin(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const secure =
    url.protocol === "https:" || (url.protocol === "http:" && isLoopbackHostname(url.hostname));
  if (!secure || url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== "/" && url.pathname !== "") return null;
  // An origin is one exact host: no wildcard or other pattern syntax.
  if (!/^(\[[0-9a-f:]+\]|[a-z0-9]([a-z0-9.-]*[a-z0-9])?)$/.test(url.hostname)) return null;
  return url.origin;
}

function parseHttpsUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    const secure =
      url.protocol === "https:" || (url.protocol === "http:" && isLoopbackHostname(url.hostname));
    return secure && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

/** Canonical HTTPS authority, including a non-default port when configured. */
function normalizeBlobHost(value: string, deploymentId: string): string {
  const host = value.trim().toLowerCase();
  if (/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/.test(host)) {
    try {
      return new URL(`https://${host}`).host;
    } catch {
      // A syntactically numeric port must also be valid for a URL.
    }
  }
  throw new CloudDeploymentConfigError(deploymentId, "R2_PUBLIC_HOST", "invalid");
}

const ELIZA_PRODUCTION = ELIZA_DOMAIN_CONTRACTS.production;

// The lists below are the allowlists each boundary carried before deployments
// existed. They differ from one another on purpose and are kept verbatim.

const ELIZA_FIRST_PARTY_ORIGINS: readonly string[] = [
  ...Object.values(ELIZA_DOMAIN_CONTRACTS).flatMap((contract) => [
    contract.marketingOrigin,
    contract.cloudAppOrigin,
    contract.cloudApiOrigin,
  ]),
  `https://www.${new URL(ELIZA_PRODUCTION.marketingOrigin).hostname}`,
  ...Object.values(LEGACY_ELIZA_DOMAIN_CONTRACTS).flatMap((contract) => [
    ...contract.marketingHostnames.map((host) => `https://${host}`),
    ...contract.cloudAppHostnames.map((host) => `https://${host}`),
    ...contract.cloudApiHostnames.map((host) => `https://${host}`),
  ]),
  // Exact develop branch alias for staging QA. Do not add a broad *.pages.dev
  // wildcard here; session-capable routes must remain first-party-only.
  "https://develop.eliza-app.pages.dev",
  "https://staging.eliza-app.pages.dev",
  "https://elizaos.ai",
  "https://www.elizaos.ai",
  "https://os.elizacloud.ai",
  "https://os.eliza.app",
  "https://eliza.ai",
  "https://www.eliza.ai",
];

const ELIZA_BROWSER_ORIGIN_HOSTS: readonly string[] = [
  ...Object.values(ELIZA_DOMAIN_CONTRACTS).flatMap((contract) => [
    new URL(contract.marketingOrigin).hostname,
    new URL(contract.cloudAppOrigin).hostname,
  ]),
  `www.${new URL(ELIZA_PRODUCTION.marketingOrigin).hostname}`,
  ...Object.values(LEGACY_ELIZA_DOMAIN_CONTRACTS).flatMap((contract) => [
    ...contract.marketingHostnames,
    ...contract.cloudAppHostnames,
  ]),
  "elizaos.ai",
  "www.elizaos.ai",
];

const ELIZA_AUTH_CORS_ORIGINS: readonly string[] = [
  "https://eliza.app",
  "https://cloud.eliza.app",
  "https://staging.eliza.app",
  "https://cloud-staging.eliza.app",
  "https://eliza.ai",
  "https://www.eliza.ai",
  // Legacy origins are accepted only during the redirect migration window.
  "https://elizacloud.ai",
  "https://www.elizacloud.ai",
  "https://app.elizacloud.ai",
  "https://app-staging.elizacloud.ai",
  // Exact develop branch alias for staging QA. Do not add a broad *.pages.dev
  // wildcard here; these auth routes can return API keys after login.
  "https://develop.eliza-app.pages.dev",
  "https://staging.eliza-app.pages.dev",
];

const ELIZA_PLATFORM_REDIRECT_ORIGINS: readonly string[] = [
  "http://localhost:3000",
  "http://localhost:3001",
  "http://127.0.0.1:3000",
  "http://127.0.0.1:3001",
  "https://eliza.ai",
  "https://www.eliza.ai",
  "https://eliza.app",
  "https://cloud.eliza.app",
  "https://staging.eliza.app",
  "https://cloud-staging.eliza.app",
];

const ELIZA_CHECKOUT_RETURN_ORIGINS: readonly string[] = [
  "http://localhost:3000",
  "http://localhost:3001",
  "http://localhost:4455",
  "https://elizaos.ai",
  "https://www.elizaos.ai",
  "https://os.eliza.app",
  // Transitional legacy storefront origin.
  "https://os.elizacloud.ai",
  "https://eliza.ai",
  "https://www.eliza.ai",
];

/**
 * Capacitor's iOS WebView origin. A browser page cannot mint it, so the
 * public auth-route CORS helper accepts it on every deployment.
 */
const CAPACITOR_SCHEME_ORIGIN = "capacitor://localhost";

function withConfigured(configured: string | undefined, origins: readonly string[]): string[] {
  return configured ? [configured, ...origins] : [...origins];
}

function elizaEnvironment(env: CloudDeploymentEnv): ElizaCloudEnvironment {
  return setting(env, "ENVIRONMENT") === "staging" ? "staging" : "production";
}

function resolveElizaDeployment(env: CloudDeploymentEnv): CloudDeployment {
  const contract = ELIZA_DOMAIN_CONTRACTS[elizaEnvironment(env)];
  // Callers have always compared and concatenated the configured app URL as
  // written, so it is passed through rather than normalised to an origin.
  const configuredAppUrl = setting(env, "NEXT_PUBLIC_APP_URL");
  // Historical behaviour: an unset app URL means the production app, even on
  // staging, and the top-up link is the production billing page.
  const appOrigin = configuredAppUrl ?? ELIZA_PRODUCTION.cloudAppOrigin;
  return Object.freeze({
    id: ELIZA_CLOUD_DEPLOYMENT_ID,
    isEliza: true,
    webOrigin: contract.marketingOrigin,
    appOrigin,
    apiOrigin: setting(env, "NEXT_PUBLIC_API_URL") ?? contract.cloudApiOrigin,
    firstPartyOrigins: new Set(ELIZA_FIRST_PARTY_ORIGINS),
    browserOriginHosts: new Set(ELIZA_BROWSER_ORIGIN_HOSTS),
    authCorsOrigins: new Set([
      ...withConfigured(configuredAppUrl, ELIZA_AUTH_CORS_ORIGINS),
      CAPACITOR_SCHEME_ORIGIN,
    ]),
    platformRedirectOrigins: Object.freeze(
      withConfigured(configuredAppUrl, ELIZA_PLATFORM_REDIRECT_ORIGINS),
    ),
    checkoutReturnOrigins: Object.freeze(
      withConfigured(configuredAppUrl, ELIZA_CHECKOUT_RETURN_ORIGINS),
    ),
    tenantId:
      setting(env, "NEXT_PUBLIC_STEWARD_TENANT_ID") ??
      setting(env, "STEWARD_TENANT_ID") ??
      ELIZA_DEFAULT_STEWARD_TENANT_ID,
    serviceName: setting(env, "CLOUD_PUBLIC_SERVICE_NAME") ?? "Eliza Cloud",
    blobHost: setting(env, "R2_PUBLIC_HOST") ?? ELIZA_DEFAULT_BLOB_HOST,
    assetsBase: (
      setting(env, "NEXT_PUBLIC_ASSETS_CDN_URL") ?? `https://${ELIZA_DEFAULT_BLOB_HOST}`
    ).replace(/\/+$/, ""),
    mailFrom:
      setting(env, "SENDGRID_FROM_EMAIL") ?? setting(env, "SMTP_FROM") ?? "noreply@eliza.app",
    billingUrl: `${ELIZA_PRODUCTION.cloudAppOrigin}/cloud/billing`,
    // Fixed to production on every Eliza environment, as it always was.
    speechConsentOrigin: ELIZA_PRODUCTION.cloudApiOrigin,
  });
}

function resolveProductDeployment(id: string, env: CloudDeploymentEnv): CloudDeployment {
  const required = (name: string): string => {
    const value = setting(env, name);
    if (value === undefined) throw new CloudDeploymentConfigError(id, name, "missing");
    return value;
  };
  const origin = (name: string): string => {
    const parsed = parseOrigin(required(name));
    if (!parsed) throw new CloudDeploymentConfigError(id, name, "invalid");
    return parsed;
  };

  const webOrigin = origin("CLOUD_WEB_ORIGIN");
  const appOrigin = origin("NEXT_PUBLIC_APP_URL");
  const apiOrigin = origin("NEXT_PUBLIC_API_URL");

  const extraOrigins = (setting(env, "CLOUD_FIRST_PARTY_ORIGINS") ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const parsed = parseOrigin(entry);
      if (!parsed) {
        throw new CloudDeploymentConfigError(id, "CLOUD_FIRST_PARTY_ORIGINS", "invalid");
      }
      return parsed;
    });

  const tenantId =
    setting(env, "STEWARD_TENANT_ID") ?? setting(env, "NEXT_PUBLIC_STEWARD_TENANT_ID");
  if (!tenantId) throw new CloudDeploymentConfigError(id, "STEWARD_TENANT_ID", "missing");

  const serviceName = required("CLOUD_PUBLIC_SERVICE_NAME");

  const blobHost = normalizeBlobHost(required("R2_PUBLIC_HOST"), id);

  const assetsUrl = parseHttpsUrl(required("NEXT_PUBLIC_ASSETS_CDN_URL"));
  if (!assetsUrl || assetsUrl.search || assetsUrl.hash) {
    throw new CloudDeploymentConfigError(id, "NEXT_PUBLIC_ASSETS_CDN_URL", "invalid");
  }
  const assetsBase = `${assetsUrl.origin}${assetsUrl.pathname}`.replace(/\/+$/, "");

  const mailFrom = setting(env, "SENDGRID_FROM_EMAIL") ?? setting(env, "SMTP_FROM");
  if (!mailFrom) throw new CloudDeploymentConfigError(id, "SENDGRID_FROM_EMAIL", "missing");
  if (!/^[^\s@]+@[^\s@]+$|<[^\s@]+@[^\s@]+>$/.test(mailFrom)) {
    throw new CloudDeploymentConfigError(id, "SENDGRID_FROM_EMAIL", "invalid");
  }

  const billing = parseHttpsUrl(required("CLOUD_BILLING_URL"));
  if (!billing) throw new CloudDeploymentConfigError(id, "CLOUD_BILLING_URL", "invalid");

  const webOrigins = [...new Set([webOrigin, appOrigin, ...extraOrigins])];
  return Object.freeze({
    id,
    isEliza: false,
    webOrigin,
    appOrigin,
    apiOrigin,
    firstPartyOrigins: new Set([...webOrigins, apiOrigin]),
    browserOriginHosts: new Set(webOrigins.map((entry) => new URL(entry).hostname)),
    authCorsOrigins: new Set([...webOrigins, CAPACITOR_SCHEME_ORIGIN]),
    platformRedirectOrigins: Object.freeze([...webOrigins]),
    checkoutReturnOrigins: Object.freeze([...webOrigins]),
    tenantId,
    serviceName,
    blobHost,
    assetsBase,
    mailFrom,
    billingUrl: billing.toString(),
    speechConsentOrigin: apiOrigin,
  });
}

const DEPLOYMENT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const resolved = new Map<string, CloudDeployment>();

/**
 * Resolve the deployment described by `env`. Throws
 * `CloudDeploymentConfigError` when a product deployment is incomplete.
 */
export function resolveCloudDeployment(env: CloudDeploymentEnv): CloudDeployment {
  const key = CLOUD_DEPLOYMENT_SETTINGS.map((name) => env[name] ?? "").join("\u0000");
  const cached = resolved.get(key);
  if (cached) return cached;

  const id = setting(env, "CLOUD_DEPLOYMENT_ID") ?? ELIZA_CLOUD_DEPLOYMENT_ID;
  if (!DEPLOYMENT_ID_PATTERN.test(id)) {
    throw new CloudDeploymentConfigError(id, "CLOUD_DEPLOYMENT_ID", "invalid");
  }
  const deployment =
    id === ELIZA_CLOUD_DEPLOYMENT_ID
      ? resolveElizaDeployment(env)
      : resolveProductDeployment(id, env);

  // Bounded: a process serves one deployment; tests cycle through a handful.
  if (resolved.size >= 32) resolved.clear();
  resolved.set(key, deployment);
  return deployment;
}

/** The deployment of the current Worker request, or of the process outside one. */
export function getCloudDeployment(): CloudDeployment {
  return resolveCloudDeployment(getCloudAwareEnv());
}

export interface CloudCallbackOrigins {
  readonly webOrigin: string;
  readonly appOrigin: string;
  readonly apiOrigin: string;
}

/**
 * Origins a native sign-in callback may name when a Pages project is prepared
 * for `environment`. Eliza keeps one contract per environment; a product
 * deployment is described by its own settings, which the operator supplies per
 * environment.
 */
export function resolveCloudCallbackOrigins(
  env: CloudDeploymentEnv,
  environment: ElizaCloudEnvironment,
): CloudCallbackOrigins {
  const id = setting(env, "CLOUD_DEPLOYMENT_ID") ?? ELIZA_CLOUD_DEPLOYMENT_ID;
  if (id === ELIZA_CLOUD_DEPLOYMENT_ID) {
    const contract = ELIZA_DOMAIN_CONTRACTS[environment];
    return {
      webOrigin: contract.marketingOrigin,
      appOrigin: contract.cloudAppOrigin,
      apiOrigin: contract.cloudApiOrigin,
    };
  }
  const { webOrigin, appOrigin, apiOrigin } = resolveCloudDeployment(env);
  return { webOrigin, appOrigin, apiOrigin };
}

/** Join a path onto the deployment's asset base. */
export function cloudAssetUrl(deployment: CloudDeployment, path: string): string {
  return `${deployment.assetsBase}/${path.replace(/^\/+/, "")}`;
}

/**
 * Public blob host for code that is handed Worker bindings directly. An
 * explicit `R2_PUBLIC_HOST` binding wins. Without one the Eliza deployment
 * uses its default, and a product deployment uses the host configured for the
 * current request or process, failing closed when there is none.
 */
export function resolveCloudBlobHost(bindings: {
  R2_PUBLIC_HOST?: unknown;
  CLOUD_DEPLOYMENT_ID?: unknown;
}): string {
  const explicit =
    typeof bindings.R2_PUBLIC_HOST === "string" ? bindings.R2_PUBLIC_HOST.trim() : "";
  const bound =
    typeof bindings.CLOUD_DEPLOYMENT_ID === "string" ? bindings.CLOUD_DEPLOYMENT_ID.trim() : "";
  const ambient = getCloudAwareEnv();
  const id = bound || setting(ambient, "CLOUD_DEPLOYMENT_ID") || ELIZA_CLOUD_DEPLOYMENT_ID;
  if (explicit) return normalizeBlobHost(explicit, id);
  // Eliza callers that pass bindings have never consulted the ambient host.
  if (id === ELIZA_CLOUD_DEPLOYMENT_ID) return ELIZA_DEFAULT_BLOB_HOST;
  const configured = setting(ambient, "R2_PUBLIC_HOST");
  if (!configured) throw new CloudDeploymentConfigError(id, "R2_PUBLIC_HOST", "missing");
  return normalizeBlobHost(configured, id);
}
