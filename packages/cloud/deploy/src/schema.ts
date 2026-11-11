/**
 * Product deployment file: the identity and Cloudflare resources of one
 * Cloud, per environment. It holds no secret values, only the names of the
 * secrets the operator must set on the Worker.
 *
 * `validateDeployment` returns the typed deployment or throws
 * `DeploymentFileError` listing every problem it found.
 */

export const ELIZA_DEPLOYMENT_ID = "eliza";
export const DEPLOYMENT_ENVIRONMENTS = ["staging", "production"] as const;
export type DeploymentEnvironmentName =
  (typeof DEPLOYMENT_ENVIRONMENTS)[number];

export interface DeploymentRoute {
  /** Worker route pattern, for example `api.example.org/*`. */
  readonly pattern: string;
  /** Cloudflare zone that owns the pattern's host. */
  readonly zone: string;
}

export interface DeploymentOrigins {
  /** Public site origin. */
  readonly web: string;
  /** Cloud web app origin. */
  readonly app: string;
  /** Cloud API origin. */
  readonly api: string;
  /** Further browser origins treated as first-party. */
  readonly firstParty?: readonly string[];
}

export interface DeploymentResources {
  readonly hyperdriveId: string;
  readonly kvNamespaceId: string;
  readonly r2Bucket: string;
  /** Rate Limiting namespace id per binding name the Worker declares. */
  readonly rateLimitNamespaceIds: Readonly<Record<string, string>>;
}

export interface DeploymentPlacement {
  readonly mode: string;
  readonly region?: string;
}

export interface DeploymentEnvironment {
  readonly workerName: string;
  readonly accountId: string;
  readonly routes: readonly DeploymentRoute[];
  readonly origins: DeploymentOrigins;
  readonly tenantId: string;
  readonly serviceName: string;
  /** Public blob host (`host[:port]`, no scheme). */
  readonly blobHost: string;
  readonly assetsBase: string;
  readonly mailFrom: string;
  readonly billingUrl: string;
  readonly entitlement: { readonly issuer: string; readonly audience: string };
  readonly resources: DeploymentResources;
  readonly placement?: DeploymentPlacement;
  /**
   * Durable Object classes owned by another Worker of this deployment:
   * class name to that Worker's name.
   */
  readonly durableObjectTransfers?: Readonly<Record<string, string>>;
  /** Further non-secret Worker variables. */
  readonly vars?: Readonly<Record<string, string>>;
  /** Names of the secrets the Worker needs. Never values. */
  readonly secrets: readonly string[];
}

export interface Deployment {
  readonly id: string;
  readonly environments: Partial<
    Record<DeploymentEnvironmentName, DeploymentEnvironment>
  >;
}

export class DeploymentFileError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(
      `Invalid deployment file:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`,
    );
    this.name = "DeploymentFileError";
    this.problems = problems;
  }
}

/** Worker variables the renderer derives from typed fields. `vars` may not set them. */
export const DERIVED_VARS = [
  "CLOUD_DEPLOYMENT_ID",
  "ENVIRONMENT",
  "NODE_ENV",
  "CLOUD_WEB_ORIGIN",
  "NEXT_PUBLIC_APP_URL",
  "NEXT_PUBLIC_API_URL",
  "ELIZA_CLOUD_URL",
  "CLOUD_FIRST_PARTY_ORIGINS",
  "STEWARD_TENANT_ID",
  "NEXT_PUBLIC_STEWARD_TENANT_ID",
  "CLOUD_PUBLIC_SERVICE_NAME",
  "R2_PUBLIC_HOST",
  "NEXT_PUBLIC_ASSETS_CDN_URL",
  "SENDGRID_FROM_EMAIL",
  "CLOUD_BILLING_URL",
  "ELIZA_ENTITLEMENT_ISSUER",
  "ELIZA_ENTITLEMENT_AUDIENCE",
] as const;

const DEPLOYMENT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const WORKER_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/;
const RESOURCE_ID_PATTERN = /^[0-9a-f]{32}$/;
const BUCKET_PATTERN = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const RATE_LIMIT_ID_PATTERN = /^[1-9][0-9]{0,9}$/;
const BINDING_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const CLASS_NAME_PATTERN = /^[A-Z][A-Za-z0-9]*$/;
const HOSTNAME_PATTERN =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const BLOB_HOST_PATTERN = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/;
const MAIL_FROM_PATTERN = /^[^\s@]+@[^\s@]+$|<[^\s@]+@[^\s@]+>$/;

/** A host on, or under, a zone the eliza.app deployment owns. */
const ELIZA_HOST_PATTERN =
  /(?<![a-z0-9-])(?:[a-z0-9-]+\.)*(?:eliza\.app|elizacloud\.ai)(?![a-z0-9-])/i;

const SECRET_NAME_PATTERN =
  /(_SECRET|_SECRETS|_KEY|_TOKEN|_PASSWORD|_PEPPER|_JWKS|_DSN)$|^(DATABASE_URL|REDIS_URL)$/;

const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b[sr]k_(live|test)_[A-Za-z0-9]{8,}/,
  /\bwhsec_[A-Za-z0-9]{8,}/,
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\./,
  /^0x[0-9a-fA-F]{64}$/,
  // Credentials embedded in a URL.
  /:\/\/[^/\s:@]+:[^/\s@]+@/,
];

/** True when a value has the shape of a credential rather than configuration. */
export function looksLikeSecretValue(value: string): boolean {
  return SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

/** True when a variable name is one that conventionally carries a credential. */
export function looksLikeSecretName(name: string): boolean {
  return SECRET_NAME_PATTERN.test(name);
}

export function mentionsElizaHost(value: string): boolean {
  return ELIZA_HOST_PATTERN.test(value);
}

function isLoopback(hostname: string): boolean {
  return (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]"
  );
}

/** An exact https origin (http only on loopback), as the Cloud resolver requires. */
function isOrigin(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const secure =
    url.protocol === "https:" ||
    (url.protocol === "http:" && isLoopback(url.hostname));
  if (!secure || url.username || url.password || url.search || url.hash)
    return false;
  if (url.pathname !== "/" && url.pathname !== "") return false;
  return url.origin === value;
}

function isHttpsUrl(value: string, allowQuery: boolean): boolean {
  try {
    const url = new URL(value);
    const secure =
      url.protocol === "https:" ||
      (url.protocol === "http:" && isLoopback(url.hostname));
    if (!secure || url.username || url.password) return false;
    return allowQuery || (!url.search && !url.hash);
  } catch {
    return false;
  }
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fieldPath(path: string, key: string): string {
  return `${path}.${looksLikeSecretValue(key) ? "[redacted field]" : key}`;
}

class Checker {
  readonly problems: string[] = [];

  fail(path: string, problem: string): void {
    this.problems.push(`${path}: ${problem}`);
  }

  object(value: unknown, path: string, known: readonly string[]): Json | null {
    if (!isObject(value)) {
      this.fail(path, "must be an object");
      return null;
    }
    for (const key of Object.keys(value)) {
      if (!known.includes(key))
        this.fail(fieldPath(path, key), "is not a known field");
    }
    return value;
  }

  string(
    value: unknown,
    path: string,
    test?: RegExp | ((value: string) => boolean),
  ): string {
    if (
      typeof value !== "string" ||
      value.trim() === "" ||
      value !== value.trim()
    ) {
      this.fail(path, "must be a non-empty string without surrounding space");
      return "";
    }
    const ok =
      !test || (test instanceof RegExp ? test.test(value) : test(value));
    if (!ok) this.fail(path, "has an invalid value");
    return value;
  }

  stringMap(
    value: unknown,
    path: string,
    keyPattern: RegExp,
    test?: RegExp,
  ): Record<string, string> {
    const out: Record<string, string> = {};
    if (!isObject(value)) {
      this.fail(path, "must be an object of strings");
      return out;
    }
    for (const [key, entry] of Object.entries(value)) {
      if (!keyPattern.test(key))
        this.fail(fieldPath(path, key), "is not a valid name");
      if (typeof entry !== "string") {
        this.fail(fieldPath(path, key), "must be a string");
        continue;
      }
      if (test && !test.test(entry)) {
        this.fail(fieldPath(path, key), "has an invalid value");
      }
      out[key] = entry;
    }
    return out;
  }
}

const ENVIRONMENT_FIELDS = [
  "workerName",
  "accountId",
  "routes",
  "origins",
  "tenantId",
  "serviceName",
  "blobHost",
  "assetsBase",
  "mailFrom",
  "billingUrl",
  "entitlement",
  "resources",
  "placement",
  "durableObjectTransfers",
  "vars",
  "secrets",
] as const;

function routeHost(pattern: string): string {
  return pattern.split("/")[0].replace(/^\*\.?/, "");
}

function checkEnvironment(
  check: Checker,
  value: unknown,
  path: string,
): DeploymentEnvironment {
  const env = check.object(value, path, ENVIRONMENT_FIELDS) ?? {};

  const workerName = check.string(
    env.workerName,
    `${path}.workerName`,
    WORKER_NAME_PATTERN,
  );
  const accountId = check.string(
    env.accountId,
    `${path}.accountId`,
    ACCOUNT_ID_PATTERN,
  );

  const routes: DeploymentRoute[] = [];
  if (!Array.isArray(env.routes) || env.routes.length === 0) {
    check.fail(`${path}.routes`, "must be a non-empty array");
  } else {
    env.routes.forEach((entry, index) => {
      const at = `${path}.routes[${index}]`;
      const route = check.object(entry, at, ["pattern", "zone"]) ?? {};
      const zone = check.string(route.zone, `${at}.zone`, HOSTNAME_PATTERN);
      const pattern = check.string(
        route.pattern,
        `${at}.pattern`,
        /^(\*\.?)?[a-z0-9]([a-z0-9.-]*[a-z0-9])?\/\S*$/,
      );
      if (zone && pattern) {
        const host = routeHost(pattern);
        if (host !== zone && !host.endsWith(`.${zone}`)) {
          check.fail(`${at}.pattern`, `host ${host} is not in zone ${zone}`);
        }
      }
      routes.push({ pattern, zone });
    });
  }

  const originsIn =
    check.object(env.origins, `${path}.origins`, [
      "web",
      "app",
      "api",
      "firstParty",
    ]) ?? {};
  const firstParty: string[] = [];
  if (originsIn.firstParty !== undefined) {
    if (!Array.isArray(originsIn.firstParty)) {
      check.fail(`${path}.origins.firstParty`, "must be an array of origins");
    } else {
      originsIn.firstParty.forEach((entry, index) => {
        firstParty.push(
          check.string(entry, `${path}.origins.firstParty[${index}]`, isOrigin),
        );
      });
    }
  }
  const origins: DeploymentOrigins = {
    web: check.string(originsIn.web, `${path}.origins.web`, isOrigin),
    app: check.string(originsIn.app, `${path}.origins.app`, isOrigin),
    api: check.string(originsIn.api, `${path}.origins.api`, isOrigin),
    ...(originsIn.firstParty !== undefined ? { firstParty } : {}),
  };

  const tenantId = check.string(
    env.tenantId,
    `${path}.tenantId`,
    /^[A-Za-z0-9][A-Za-z0-9_-]*$/,
  );
  const serviceName = check.string(env.serviceName, `${path}.serviceName`);
  const blobHost = check.string(
    env.blobHost,
    `${path}.blobHost`,
    BLOB_HOST_PATTERN,
  );
  const assetsBase = check.string(
    env.assetsBase,
    `${path}.assetsBase`,
    (entry) => isHttpsUrl(entry, false),
  );
  const mailFrom = check.string(
    env.mailFrom,
    `${path}.mailFrom`,
    MAIL_FROM_PATTERN,
  );
  const billingUrl = check.string(
    env.billingUrl,
    `${path}.billingUrl`,
    (entry) => isHttpsUrl(entry, true),
  );

  const entitlementIn =
    check.object(env.entitlement, `${path}.entitlement`, [
      "issuer",
      "audience",
    ]) ?? {};
  const entitlement = {
    issuer: check.string(
      entitlementIn.issuer,
      `${path}.entitlement.issuer`,
      isOrigin,
    ),
    audience: check.string(
      entitlementIn.audience,
      `${path}.entitlement.audience`,
      /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/,
    ),
  };

  const resourcesIn =
    check.object(env.resources, `${path}.resources`, [
      "hyperdriveId",
      "kvNamespaceId",
      "r2Bucket",
      "rateLimitNamespaceIds",
    ]) ?? {};
  const resources: DeploymentResources = {
    hyperdriveId: check.string(
      resourcesIn.hyperdriveId,
      `${path}.resources.hyperdriveId`,
      RESOURCE_ID_PATTERN,
    ),
    kvNamespaceId: check.string(
      resourcesIn.kvNamespaceId,
      `${path}.resources.kvNamespaceId`,
      RESOURCE_ID_PATTERN,
    ),
    r2Bucket: check.string(
      resourcesIn.r2Bucket,
      `${path}.resources.r2Bucket`,
      BUCKET_PATTERN,
    ),
    rateLimitNamespaceIds: check.stringMap(
      resourcesIn.rateLimitNamespaceIds,
      `${path}.resources.rateLimitNamespaceIds`,
      BINDING_NAME_PATTERN,
      RATE_LIMIT_ID_PATTERN,
    ),
  };
  const rateIds = Object.values(resources.rateLimitNamespaceIds);
  if (new Set(rateIds).size !== rateIds.length) {
    check.fail(
      `${path}.resources.rateLimitNamespaceIds`,
      "namespace ids must be distinct",
    );
  }

  let placement: DeploymentPlacement | undefined;
  if (env.placement !== undefined) {
    const placementIn =
      check.object(env.placement, `${path}.placement`, ["mode", "region"]) ??
      {};
    placement = {
      mode: check.string(
        placementIn.mode,
        `${path}.placement.mode`,
        /^(smart|targeted|off)$/,
      ),
      ...(placementIn.region !== undefined
        ? {
            region: check.string(
              placementIn.region,
              `${path}.placement.region`,
              /^[a-z]+:[a-z0-9-]+$/,
            ),
          }
        : {}),
    };
  }

  const durableObjectTransfers =
    env.durableObjectTransfers === undefined
      ? undefined
      : check.stringMap(
          env.durableObjectTransfers,
          `${path}.durableObjectTransfers`,
          CLASS_NAME_PATTERN,
          WORKER_NAME_PATTERN,
        );

  let vars: Record<string, string> | undefined;
  if (env.vars !== undefined) {
    vars = check.stringMap(env.vars, `${path}.vars`, BINDING_NAME_PATTERN);
    for (const name of Object.keys(vars)) {
      if ((DERIVED_VARS as readonly string[]).includes(name)) {
        check.fail(
          `${path}.vars.${name}`,
          "is set from a typed field and may not be repeated",
        );
      }
      if (looksLikeSecretName(name)) {
        check.fail(
          `${path}.vars.${name}`,
          "is a secret name; list it under secrets instead",
        );
      }
    }
  }

  const secrets: string[] = [];
  if (!Array.isArray(env.secrets)) {
    check.fail(`${path}.secrets`, "must be an array of secret names");
  } else {
    env.secrets.forEach((entry, index) => {
      const name = check.string(
        entry,
        `${path}.secrets[${index}]`,
        BINDING_NAME_PATTERN,
      );
      if (!name) return;
      if (secrets.includes(name))
        check.fail(`${path}.secrets[${index}]`, "is repeated");
      if (
        (DERIVED_VARS as readonly string[]).includes(name) ||
        (vars && name in vars)
      ) {
        check.fail(
          `${path}.secrets[${index}]`,
          `${name} is also a plain variable`,
        );
      }
      secrets.push(name);
    });
  }

  return {
    workerName,
    accountId,
    routes,
    origins,
    tenantId,
    serviceName,
    blobHost,
    assetsBase,
    mailFrom,
    billingUrl,
    entitlement,
    resources,
    ...(placement ? { placement } : {}),
    ...(durableObjectTransfers ? { durableObjectTransfers } : {}),
    ...(vars ? { vars } : {}),
    secrets,
  };
}

/** Visit every string in a JSON value with its path. */
function eachString(
  value: unknown,
  path: string,
  visit: (value: string, path: string) => void,
) {
  if (typeof value === "string") {
    visit(value, path);
  } else if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      eachString(entry, `${path}[${index}]`, visit);
    });
  } else if (isObject(value)) {
    for (const [key, entry] of Object.entries(value)) {
      visit(key, `${fieldPath(path, key)} (name)`);
      eachString(entry, fieldPath(path, key), visit);
    }
  }
}

export function validateDeployment(input: unknown): Deployment {
  const check = new Checker();
  const root = check.object(input, "deployment", ["id", "environments"]);
  if (!root) throw new DeploymentFileError(check.problems);
  const id = check.string(root.id, "deployment.id", DEPLOYMENT_ID_PATTERN);

  const environments: Partial<
    Record<DeploymentEnvironmentName, DeploymentEnvironment>
  > = {};
  const environmentsIn = check.object(
    root.environments,
    "deployment.environments",
    DEPLOYMENT_ENVIRONMENTS,
  );
  if (environmentsIn) {
    if (Object.keys(environmentsIn).length === 0) {
      check.fail(
        "deployment.environments",
        "must define staging, production or both",
      );
    }
    for (const name of DEPLOYMENT_ENVIRONMENTS) {
      if (environmentsIn[name] === undefined) continue;
      environments[name] = checkEnvironment(
        check,
        environmentsIn[name],
        `deployment.environments.${name}`,
      );
    }
    const workerNames = Object.values(environments).map(
      (env) => env.workerName,
    );
    if (
      workerNames.length === 2 &&
      workerNames[0] &&
      workerNames[0] === workerNames[1]
    ) {
      check.fail(
        "deployment.environments",
        "staging and production share a workerName",
      );
    }
  }

  eachString(input, "deployment", (value, path) => {
    if (id !== ELIZA_DEPLOYMENT_ID && mentionsElizaHost(value)) {
      check.fail(path, "names a host of the eliza deployment");
    }
    if (looksLikeSecretValue(value)) {
      // The value is deliberately not echoed.
      check.fail(
        path,
        "looks like a secret value; a deployment file holds names only",
      );
    }
  });

  if (check.problems.length > 0) throw new DeploymentFileError(check.problems);
  return { id, environments };
}
