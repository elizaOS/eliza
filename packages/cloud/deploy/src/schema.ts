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

export const DEPLOYMENT_COMPONENTS = [
  "api",
  "login",
  "speech",
  "admission",
  "web",
] as const;
export type DeploymentComponentName = (typeof DEPLOYMENT_COMPONENTS)[number];

/** Steward login Worker and its container. */
export interface LoginComponent {
  readonly workerName: string;
  /** Custom domain the login Worker is served on. */
  readonly host: string;
  /** Rendered as `LOGIN_ENABLED`; a disabled login Worker answers 503. */
  readonly enabled: boolean;
  readonly container: {
    readonly maxInstances: number;
    readonly instanceType: string;
    /**
     * A pushed image (`registry.cloudflare.com/<account>/<name>:<tag>`).
     * When omitted, upstream's Dockerfile is built at deploy time.
     */
    readonly image?: string;
  };
  readonly vars?: Readonly<Record<string, string>>;
  readonly secrets: readonly string[];
}

/** Lean host for speech session objects. */
export interface SpeechComponent {
  readonly workerName: string;
  readonly routes?: readonly DeploymentRoute[];
  /**
   * When true the API Worker's speech-session binding points at this Worker,
   * so new sessions are created here. The API keeps its own class export.
   */
  readonly hostsSessions?: boolean;
  /** Database and cache; the API Worker's when omitted. */
  readonly resources?: {
    readonly hyperdriveId: string;
    readonly kvNamespaceId: string;
  };
  readonly vars?: Readonly<Record<string, string>>;
  readonly secrets: readonly string[];
}

/** Dedicated isolate that owns the inference admission gate. */
export interface AdmissionComponent {
  readonly workerName: string;
  readonly routes?: readonly DeploymentRoute[];
  readonly vars?: Readonly<Record<string, string>>;
  readonly secrets: readonly string[];
}

/** Cloudflare Pages front end. */
export interface WebComponent {
  readonly projectName: string;
  readonly vars?: Readonly<Record<string, string>>;
}

export interface DeploymentComponents {
  readonly login?: LoginComponent;
  readonly speech?: SpeechComponent;
  readonly admission?: AdmissionComponent;
  readonly web?: WebComponent;
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
  /** The other parts of this Cloud. Each is optional. */
  readonly components?: DeploymentComponents;
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

/** Pages variables the renderer derives from typed fields. */
export const WEB_DERIVED_VARS = [
  "CLOUD_DEPLOYMENT_ID",
  "API_UPSTREAM",
  "VITE_ELIZA_CLOUD_BASE",
  "VITE_STEWARD_TENANT_ID",
  "NEXT_PUBLIC_STEWARD_TENANT_ID",
  "VITE_ENVIRONMENT",
] as const;

/** Login Worker variables the renderer derives from typed fields. */
export const LOGIN_DERIVED_VARS = ["LOGIN_ENABLED"] as const;

/**
 * Secrets the login Worker refuses to start its runtime without
 * (`REQUIRED_RUNTIME_SETTINGS` in `packages/auth/cloudflare/worker.ts`).
 */
export const LOGIN_REQUIRED_SECRETS = [
  "DATABASE_URL",
  "STEWARD_MASTER_PASSWORD",
  "STEWARD_JWT_SECRET",
  "STEWARD_KDF_SALT",
  "STEWARD_AUDIT_HMAC_KEY",
] as const;

/**
 * Login runtime settings whose built-in default is an eliza host or sender.
 * A product deployment must set each one.
 */
export const LOGIN_REQUIRED_PRODUCT_VARS = [
  "APP_URL",
  "EMAIL_FROM",
  "EMAIL_AUTH_REDIRECT_BASE_URL",
  "PASSKEY_RP_ID",
  "PASSKEY_ORIGIN",
] as const;

/** Class a deployment with an admission Worker must hand over to it. */
export const ADMISSION_GATE_CLASS = "InferenceAdmissionGate";

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

function canonicalBlobHost(value: string): string | null {
  if (!BLOB_HOST_PATTERN.test(value)) return null;
  try {
    return new URL(`https://${value}`).host;
  } catch {
    return null;
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
  "components",
] as const;

function routeHost(pattern: string): string {
  return pattern.split("/")[0].replace(/^\*\.?/, "");
}

function checkRoutes(
  check: Checker,
  value: unknown,
  path: string,
  required: boolean,
): DeploymentRoute[] {
  const routes: DeploymentRoute[] = [];
  if (!Array.isArray(value) || (required && value.length === 0)) {
    check.fail(
      path,
      required ? "must be a non-empty array" : "must be an array",
    );
    return routes;
  }
  value.forEach((entry, index) => {
    const at = `${path}[${index}]`;
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
        check.fail(`${at}.pattern`, "host is not in the configured zone");
      }
    }
    routes.push({ pattern, zone });
  });
  return routes;
}

function checkVars(
  check: Checker,
  value: unknown,
  path: string,
  derived: readonly string[],
): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  const vars = check.stringMap(value, path, BINDING_NAME_PATTERN);
  for (const name of Object.keys(vars)) {
    if (derived.includes(name)) {
      check.fail(
        fieldPath(path, name),
        "is set from a typed field and may not be repeated",
      );
    }
    if (looksLikeSecretName(name)) {
      check.fail(
        fieldPath(path, name),
        "is a secret name; list it under secrets instead",
      );
    }
  }
  return vars;
}

function checkSecrets(
  check: Checker,
  value: unknown,
  path: string,
  derived: readonly string[],
  vars: Record<string, string> | undefined,
): string[] {
  const secrets: string[] = [];
  if (!Array.isArray(value)) {
    check.fail(path, "must be an array of secret names");
    return secrets;
  }
  value.forEach((entry, index) => {
    const name = check.string(entry, `${path}[${index}]`, BINDING_NAME_PATTERN);
    if (!name) return;
    if (secrets.includes(name)) check.fail(`${path}[${index}]`, "is repeated");
    if (derived.includes(name) || (vars && name in vars)) {
      check.fail(`${path}[${index}]`, "is also a plain variable");
    }
    secrets.push(name);
  });
  return secrets;
}

interface ComponentContext {
  readonly deploymentId: string;
  readonly workerName: string;
  readonly origins: DeploymentOrigins;
  readonly durableObjectTransfers: Record<string, string> | undefined;
}

function checkComponents(
  check: Checker,
  value: unknown,
  path: string,
  context: ComponentContext,
): DeploymentComponents {
  const input =
    check.object(value, path, ["login", "speech", "admission", "web"]) ?? {};
  const workerNames = new Map<string, string>([[context.workerName, "api"]]);
  const workerName = (entry: unknown, at: string, component: string) => {
    const name = check.string(entry, at, WORKER_NAME_PATTERN);
    const owner = workerNames.get(name);
    if (name && owner) check.fail(at, `is also the ${owner} Worker's name`);
    if (name) workerNames.set(name, component);
    return name;
  };
  const components: {
    -readonly [K in keyof DeploymentComponents]: DeploymentComponents[K];
  } = {};

  if (input.login !== undefined) {
    const at = `${path}.login`;
    const login =
      check.object(input.login, at, [
        "workerName",
        "host",
        "enabled",
        "container",
        "vars",
        "secrets",
      ]) ?? {};
    if (typeof login.enabled !== "boolean")
      check.fail(`${at}.enabled`, "must be true or false");
    const containerIn =
      check.object(login.container, `${at}.container`, [
        "maxInstances",
        "instanceType",
        "image",
      ]) ?? {};
    const maxInstances = containerIn.maxInstances;
    if (
      typeof maxInstances !== "number" ||
      !Number.isInteger(maxInstances) ||
      maxInstances < 1 ||
      maxInstances > 1000
    ) {
      check.fail(`${at}.container.maxInstances`, "must be a positive integer");
    }
    const vars = checkVars(check, login.vars, `${at}.vars`, LOGIN_DERIVED_VARS);
    if (context.deploymentId !== ELIZA_DEPLOYMENT_ID) {
      for (const name of LOGIN_REQUIRED_PRODUCT_VARS) {
        if (!vars?.[name]?.trim()) {
          check.fail(
            `${at}.vars.${name}`,
            "is required: the login runtime's default is an eliza value",
          );
        }
      }
    }
    const secrets = checkSecrets(
      check,
      login.secrets,
      `${at}.secrets`,
      LOGIN_DERIVED_VARS,
      vars,
    );
    for (const name of LOGIN_REQUIRED_SECRETS) {
      if (Array.isArray(login.secrets) && !secrets.includes(name)) {
        check.fail(
          `${at}.secrets`,
          `must list ${name}; the login Worker does not start without it`,
        );
      }
    }
    components.login = {
      workerName: workerName(login.workerName, `${at}.workerName`, "login"),
      host: check.string(login.host, `${at}.host`, HOSTNAME_PATTERN),
      enabled: login.enabled === true,
      container: {
        maxInstances: typeof maxInstances === "number" ? maxInstances : 0,
        instanceType: check.string(
          containerIn.instanceType,
          `${at}.container.instanceType`,
          /^[a-z][a-z0-9-]{0,31}$/,
        ),
        ...(containerIn.image !== undefined
          ? {
              image: check.string(
                containerIn.image,
                `${at}.container.image`,
                /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?(\/[a-z0-9][a-z0-9._-]*)+:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/,
              ),
            }
          : {}),
      },
      ...(vars ? { vars } : {}),
      secrets,
    };
  }

  for (const name of ["speech", "admission"] as const) {
    if (input[name] === undefined) continue;
    const at = fieldPath(path, name);
    const known =
      name === "speech"
        ? [
            "workerName",
            "routes",
            "hostsSessions",
            "resources",
            "vars",
            "secrets",
          ]
        : ["workerName", "routes", "vars", "secrets"];
    const worker = check.object(input[name], at, known) ?? {};
    const vars = checkVars(check, worker.vars, `${at}.vars`, DERIVED_VARS);
    const common = {
      workerName: workerName(worker.workerName, `${at}.workerName`, name),
      ...(worker.routes !== undefined
        ? { routes: checkRoutes(check, worker.routes, `${at}.routes`, false) }
        : {}),
      ...(vars ? { vars } : {}),
      secrets: checkSecrets(
        check,
        worker.secrets,
        `${at}.secrets`,
        DERIVED_VARS,
        vars,
      ),
    };
    if (name === "admission") {
      components.admission = common;
      continue;
    }
    if (
      worker.hostsSessions !== undefined &&
      typeof worker.hostsSessions !== "boolean"
    ) {
      check.fail(`${at}.hostsSessions`, "must be true or false");
    }
    let resources: SpeechComponent["resources"];
    if (worker.resources !== undefined) {
      const resourcesIn =
        check.object(worker.resources, `${at}.resources`, [
          "hyperdriveId",
          "kvNamespaceId",
        ]) ?? {};
      resources = {
        hyperdriveId: check.string(
          resourcesIn.hyperdriveId,
          `${at}.resources.hyperdriveId`,
          RESOURCE_ID_PATTERN,
        ),
        kvNamespaceId: check.string(
          resourcesIn.kvNamespaceId,
          `${at}.resources.kvNamespaceId`,
          RESOURCE_ID_PATTERN,
        ),
      };
    }
    components.speech = {
      ...common,
      ...(worker.hostsSessions !== undefined
        ? { hostsSessions: worker.hostsSessions === true }
        : {}),
      ...(resources ? { resources } : {}),
    };
  }

  // One admission gate per deployment: the API Worker must bind the
  // admission Worker's namespace, or the two would admit independently.
  const gateOwner = context.durableObjectTransfers?.[ADMISSION_GATE_CLASS];
  if (
    components.admission?.workerName &&
    gateOwner !== components.admission.workerName
  ) {
    check.fail(
      `${path}.admission.workerName`,
      `durableObjectTransfers.${ADMISSION_GATE_CLASS} must name this Worker`,
    );
  }

  if (input.web !== undefined) {
    const at = `${path}.web`;
    const web = check.object(input.web, at, ["projectName", "vars"]) ?? {};
    const vars = checkVars(check, web.vars, `${at}.vars`, WEB_DERIVED_VARS);
    components.web = {
      projectName: check.string(
        web.projectName,
        `${at}.projectName`,
        /^[a-z0-9][a-z0-9-]{0,57}$/,
      ),
      ...(vars ? { vars } : {}),
    };
  }

  return components;
}

function checkEnvironment(
  check: Checker,
  value: unknown,
  path: string,
  deploymentId: string,
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

  const routes = checkRoutes(check, env.routes, `${path}.routes`, true);

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
  const configuredBlobHost = check.string(
    env.blobHost,
    `${path}.blobHost`,
    (entry) => canonicalBlobHost(entry) !== null,
  );
  const blobHost = canonicalBlobHost(configuredBlobHost) ?? configuredBlobHost;
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

  const vars = checkVars(check, env.vars, `${path}.vars`, DERIVED_VARS);
  const secrets = checkSecrets(
    check,
    env.secrets,
    `${path}.secrets`,
    DERIVED_VARS,
    vars,
  );

  const components =
    env.components === undefined
      ? undefined
      : checkComponents(check, env.components, `${path}.components`, {
          deploymentId,
          workerName,
          origins,
          durableObjectTransfers,
        });

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
    ...(components ? { components } : {}),
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
        id,
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
    // A Worker name identifies one script in the account, so a component
    // may not reuse a name from the other environment either.
    const owners = new Map<string, { environment: string; api: boolean }>();
    for (const [environment, env] of Object.entries(environments)) {
      const parts = env.components ?? {};
      const named: [string, string | undefined][] = [
        ["workerName", env.workerName],
        ["components.login.workerName", parts.login?.workerName],
        ["components.speech.workerName", parts.speech?.workerName],
        ["components.admission.workerName", parts.admission?.workerName],
      ];
      for (const [field, name] of named) {
        if (!name) continue;
        const api = field === "workerName";
        const other = owners.get(name);
        // Two API Workers sharing a name is reported above.
        if (other && other.environment !== environment && !(api && other.api)) {
          check.fail(
            `deployment.environments.${environment}.${field}`,
            `is also a Worker of ${other.environment}`,
          );
        }
        owners.set(name, { environment, api });
      }
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
