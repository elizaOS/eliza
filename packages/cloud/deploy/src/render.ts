/**
 * Renders one environment of a deployment file into a complete Wrangler
 * configuration for the Cloud API Worker.
 *
 * Structure (entry, compatibility, aliases, defines, Durable Object classes,
 * crons, observability, AI and browser bindings, rate-limit shapes) is read
 * from upstream's `packages/cloud/api/wrangler.toml`. Identity and resources
 * (Worker name, account, routes, variables, buckets, database, cache,
 * rate-limit namespaces, placement) come only from the deployment file. No
 * `[vars]` value is copied from upstream.
 */

import { readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  type Deployment,
  type DeploymentComponentName,
  type DeploymentEnvironment,
  type DeploymentEnvironmentName,
  ELIZA_DEPLOYMENT_ID,
  mentionsElizaHost,
} from "./schema";

export const UPSTREAM_API_DIR = join("packages", "cloud", "api");
export const UPSTREAM_WRANGLER_TOML = join(UPSTREAM_API_DIR, "wrangler.toml");

type Table = Record<string, unknown>;

export class RenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RenderError";
  }
}

export function parseToml(text: string): Table {
  const bun = (globalThis as { Bun?: { TOML: { parse(text: string): Table } } })
    .Bun;
  if (!bun)
    throw new RenderError("cloud-deploy reads TOML with Bun; run it with bun");
  return bun.TOML.parse(text);
}

/** Directory of each component's upstream Wrangler configuration. */
export const UPSTREAM_COMPONENT_DIRS: Readonly<
  Record<DeploymentComponentName, string>
> = {
  api: UPSTREAM_API_DIR,
  login: join("packages", "auth", "cloudflare"),
  speech: join("packages", "cloud", "speech-worker"),
  admission: join("packages", "cloud", "admission-worker"),
  web: join("packages", "app"),
};

export function readUpstreamComponentToml(
  upstreamRoot: string,
  component: DeploymentComponentName,
): Table {
  const path = join(UPSTREAM_COMPONENT_DIRS[component], "wrangler.toml");
  const file = join(upstreamRoot, path);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    throw new RenderError(`--upstream has no ${path} (looked for ${file})`);
  }
  return parseToml(text);
}

export function readUpstreamWranglerToml(upstreamRoot: string): Table {
  return readUpstreamComponentToml(upstreamRoot, "api");
}

/**
 * Every key the renderer understands. An upstream key outside these sets
 * stops the render: it may carry identity the renderer would otherwise copy
 * or silently drop.
 */
const TOP_LEVEL_KEYS = new Set([
  "name",
  "main",
  "compatibility_date",
  "compatibility_flags",
  "account_id",
  "workers_dev",
  "minify",
  "keep_vars",
  "define",
  "alias",
  "observability",
  "triggers",
  "build",
  "rules",
  "limits",
  "placement",
  "routes",
  "r2_buckets",
  "hyperdrive",
  "kv_namespaces",
  "ai",
  "browser",
  "ratelimits",
  "durable_objects",
  "exports",
  "migrations",
  "vars",
  "env",
]);

/** Class whose new objects a speech Worker hosts. */
export const SPEECH_SESSION_CLASS = "SpeechRelayCoordinator";

/** Upstream environment whose structure every rendered config follows. */
const TEMPLATE_ENVIRONMENT = "production";

export function table(value: unknown, what: string): Table {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RenderError(`upstream wrangler.toml: ${what} is not a table`);
  }
  return value as Table;
}

export function tables(value: unknown, what: string): Table[] {
  if (!Array.isArray(value)) {
    throw new RenderError(
      `upstream wrangler.toml: ${what} is not an array of tables`,
    );
  }
  return value.map((entry, index) => table(entry, `${what}[${index}]`));
}

export function single(value: unknown, what: string): Table {
  const entries = tables(value, what);
  if (entries.length !== 1) {
    throw new RenderError(
      `upstream wrangler.toml: expected exactly one ${what} binding`,
    );
  }
  return entries[0];
}

function assertKnownKeys(config: Table, what: string): void {
  for (const key of Object.keys(config)) {
    if (!TOP_LEVEL_KEYS.has(key)) {
      throw new RenderError(
        `upstream wrangler.toml: ${what} has a key the renderer does not know: ${key}`,
      );
    }
  }
}

/** Rewrite a path written relative to an upstream component directory. */
export function rebase(path: string, apiDir: string, outDir: string): string {
  if (resolve(outDir) === resolve(apiDir)) return path;
  const moved = relative(resolve(outDir), resolve(apiDir, path))
    .split(sep)
    .join("/");
  return moved.startsWith(".") ? moved : `./${moved}`;
}

export function isRelativePath(value: string): boolean {
  return value.startsWith("./") || value.startsWith("../");
}

export interface RenderOptions {
  readonly deployment: Deployment;
  readonly environment: DeploymentEnvironmentName;
  /** Root of the upstream checkout the Worker is built from. */
  readonly upstreamRoot: string;
  /** Directory the rendered file will live in; relative paths are written from it. */
  readonly outDir: string;
}

export interface RenderedConfig {
  readonly component: DeploymentComponentName;
  /** The Wrangler configuration object. */
  readonly config: Table;
  /** `wrangler.<environment>.jsonc` contents. */
  readonly text: string;
  readonly fileName: string;
  /** `secrets.<environment>.txt` contents: one required secret name per line. */
  readonly secretsText: string;
  readonly secretsFileName: string;
}

/** The variables `resolveCloudDeployment` reads, from the typed fields. */
export function identityVars(
  id: string,
  environment: DeploymentEnvironmentName,
  env: DeploymentEnvironment,
): Record<string, string> {
  return {
    CLOUD_DEPLOYMENT_ID: id,
    ENVIRONMENT: environment,
    NODE_ENV: "production",
    CLOUD_WEB_ORIGIN: env.origins.web,
    NEXT_PUBLIC_APP_URL: env.origins.app,
    NEXT_PUBLIC_API_URL: env.origins.api,
    ELIZA_CLOUD_URL: env.origins.api,
    ...(env.origins.firstParty && env.origins.firstParty.length > 0
      ? { CLOUD_FIRST_PARTY_ORIGINS: env.origins.firstParty.join(",") }
      : {}),
    STEWARD_TENANT_ID: env.tenantId,
    NEXT_PUBLIC_STEWARD_TENANT_ID: env.tenantId,
    CLOUD_PUBLIC_SERVICE_NAME: env.serviceName,
    R2_PUBLIC_HOST: env.blobHost,
    NEXT_PUBLIC_ASSETS_CDN_URL: env.assetsBase,
    SENDGRID_FROM_EMAIL: env.mailFrom,
    CLOUD_BILLING_URL: env.billingUrl,
    ELIZA_ENTITLEMENT_ISSUER: env.entitlement.issuer,
    ELIZA_ENTITLEMENT_AUDIENCE: env.entitlement.audience,
  };
}

export function deploymentVars(
  id: string,
  environment: DeploymentEnvironmentName,
  env: DeploymentEnvironment,
): Record<string, string> {
  return { ...identityVars(id, environment, env), ...(env.vars ?? {}) };
}

/**
 * Strings that identify the eliza deployment in upstream's wrangler.toml:
 * account, Worker names, zones, database, cache and bucket ids, and the names
 * of sibling Workers. Rate-limit namespace ids are left out: they are small
 * integers chosen per account, so another account may reuse one.
 */
export function upstreamIdentityStrings(upstream: Table): string[] {
  const found = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === "string" && value) found.add(value);
  };
  const scan = (config: Table) => {
    add(config.account_id);
    add(config.name);
    for (const route of Array.isArray(config.routes) ? config.routes : []) {
      add((route as Table).zone_name);
    }
    for (const entry of Array.isArray(config.hyperdrive)
      ? config.hyperdrive
      : []) {
      add((entry as Table).id);
    }
    for (const entry of Array.isArray(config.kv_namespaces)
      ? config.kv_namespaces
      : []) {
      add((entry as Table).id);
    }
    for (const entry of Array.isArray(config.r2_buckets)
      ? config.r2_buckets
      : []) {
      add((entry as Table).bucket_name);
    }
    const objects = config.durable_objects as Table | undefined;
    for (const entry of Array.isArray(objects?.bindings)
      ? (objects.bindings as Table[])
      : []) {
      add(entry.script_name);
    }
    for (const entry of Object.values(
      (config.exports as Table | undefined) ?? {},
    )) {
      add((entry as Table).transferred_to);
    }
    for (const entry of Array.isArray(config.services) ? config.services : []) {
      add((entry as Table).service);
    }
  };
  scan(upstream);
  for (const env of Object.values((upstream.env as Table | undefined) ?? {}))
    scan(env as Table);
  return [...found];
}

/** Identity strings of every upstream component configuration that exists. */
export function allUpstreamIdentityStrings(upstreamRoot: string): string[] {
  const found = new Set<string>();
  for (const component of Object.keys(
    UPSTREAM_COMPONENT_DIRS,
  ) as DeploymentComponentName[]) {
    const file = join(
      upstreamRoot,
      UPSTREAM_COMPONENT_DIRS[component],
      "wrangler.toml",
    );
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      // The component being rendered is read, and required, by its renderer.
      continue;
    }
    for (const value of upstreamIdentityStrings(parseToml(text)))
      found.add(value);
  }
  return [...found];
}

/**
 * Eliza identity found in rendered text; empty when there is none.
 * `upstream` is a parsed configuration or a list of identity strings.
 */
export function findElizaIdentity(
  text: string,
  upstream: Table | readonly string[],
): string[] {
  const identity = Array.isArray(upstream)
    ? (upstream as readonly string[])
    : upstreamIdentityStrings(upstream as Table);
  const hits = identity.filter((value) => text.includes(value));
  for (const line of text.split("\n")) {
    if (mentionsElizaHost(line)) hits.push(line.trim());
  }
  return hits;
}

export function renderWranglerConfig(options: RenderOptions): RenderedConfig {
  const { deployment, environment, upstreamRoot, outDir } = options;
  const env = deployment.environments[environment];
  if (!env) {
    throw new RenderError(
      `deployment "${deployment.id}" has no ${environment} environment`,
    );
  }
  if (!isAbsolute(upstreamRoot) || !isAbsolute(outDir)) {
    throw new RenderError("upstreamRoot and outDir must be absolute paths");
  }

  const upstream = readUpstreamWranglerToml(upstreamRoot);
  assertKnownKeys(upstream, "the top level");
  const template = table(
    table(upstream.env, "env")[TEMPLATE_ENVIRONMENT],
    `env.${TEMPLATE_ENVIRONMENT}`,
  );
  assertKnownKeys(template, `env.${TEMPLATE_ENVIRONMENT}`);

  // Wrangler inherits these from the top level when an environment omits them.
  const inherited = (key: string): unknown => template[key] ?? upstream[key];
  const apiDir = join(upstreamRoot, UPSTREAM_API_DIR);

  for (const key of ["build", "rules", "migrations"]) {
    if (inherited(key) !== undefined) {
      // None is used upstream today. Each needs path or ownership handling
      // that must be written before it can be carried into a product config.
      throw new RenderError(
        `upstream wrangler.toml now sets ${key}; the renderer must handle it`,
      );
    }
  }

  const main = inherited("main");
  if (typeof main !== "string")
    throw new RenderError("upstream wrangler.toml has no main");

  const alias: Record<string, string> = {};
  for (const [name, target] of Object.entries(
    table(inherited("alias") ?? {}, "alias"),
  )) {
    if (typeof target !== "string")
      throw new RenderError(`alias ${name} is not a string`);
    alias[name] = isRelativePath(target)
      ? rebase(target, apiDir, outDir)
      : target;
  }

  const transfers = env.durableObjectTransfers ?? {};
  // A speech host takes new sessions without a transfer: the API keeps its
  // own export so sessions it already holds can retire there.
  const speechHost = env.components?.speech?.hostsSessions
    ? env.components.speech.workerName
    : undefined;
  if (speechHost && transfers[SPEECH_SESSION_CLASS]) {
    throw new RenderError(
      `${SPEECH_SESSION_CLASS} is both transferred and hosted by the speech Worker`,
    );
  }
  let speechBound = false;
  const objectBindings = tables(
    table(template.durable_objects, "durable_objects").bindings,
    "durable_objects.bindings",
  ).map((binding) => {
    const { script_name: _upstreamOwner, ...rest } = binding;
    const className = String(binding.class_name);
    if (speechHost && className === SPEECH_SESSION_CLASS) {
      speechBound = true;
      return { ...rest, script_name: speechHost };
    }
    const owner = transfers[className];
    return owner ? { ...rest, script_name: owner } : rest;
  });
  if (speechHost && !speechBound) {
    throw new RenderError(
      `upstream's API Worker has no ${SPEECH_SESSION_CLASS} binding for the speech Worker to host`,
    );
  }

  const exportsOut: Table = {};
  const upstreamExports = table(inherited("exports") ?? {}, "exports");
  for (const [className, declaration] of Object.entries(upstreamExports)) {
    const owner = transfers[className];
    exportsOut[className] = owner
      ? {
          type: table(declaration, className).type,
          state: "transferred",
          transferred_to: owner,
        }
      : declaration;
  }
  for (const className of Object.keys(transfers)) {
    if (!(className in upstreamExports)) {
      throw new RenderError(
        `durableObjectTransfers names an unknown class ${className}`,
      );
    }
  }

  const rateIds = env.resources.rateLimitNamespaceIds;
  const ratelimits = tables(template.ratelimits ?? [], "ratelimits").map(
    (limit) => {
      const name = String(limit.name);
      const id = rateIds[name];
      if (!id) {
        throw new RenderError(
          `resources.rateLimitNamespaceIds has no id for binding ${name}`,
        );
      }
      return { ...limit, name, namespace_id: id };
    },
  );
  for (const name of Object.keys(rateIds)) {
    if (!ratelimits.some((limit) => limit.name === name)) {
      throw new RenderError(
        `resources.rateLimitNamespaceIds names an unknown binding ${name}`,
      );
    }
  }

  const config: Table = {
    name: env.workerName,
    main: rebase(main, apiDir, outDir),
    compatibility_date: inherited("compatibility_date"),
    compatibility_flags: inherited("compatibility_flags"),
    account_id: env.accountId,
    workers_dev: inherited("workers_dev"),
    minify: inherited("minify"),
    keep_vars: inherited("keep_vars"),
    ...(env.placement ? { placement: env.placement } : {}),
    routes: env.routes.map((route) => ({
      pattern: route.pattern,
      zone_name: route.zone,
    })),
    define: template.define,
    alias,
    observability: inherited("observability"),
    triggers: inherited("triggers"),
    limits: inherited("limits"),
    ai: template.ai,
    browser: template.browser,
    r2_buckets: [
      {
        ...single(template.r2_buckets, "r2_buckets"),
        bucket_name: env.resources.r2Bucket,
      },
    ],
    hyperdrive: [
      {
        ...single(template.hyperdrive, "hyperdrive"),
        id: env.resources.hyperdriveId,
      },
    ],
    kv_namespaces: [
      {
        ...single(template.kv_namespaces, "kv_namespaces"),
        id: env.resources.kvNamespaceId,
      },
    ],
    ratelimits,
    durable_objects: { bindings: objectBindings },
    exports: exportsOut,
    vars: deploymentVars(deployment.id, environment, env),
  };
  for (const key of Object.keys(config)) {
    if (config[key] === undefined) delete config[key];
  }

  return finishRender({
    component: "api",
    deployment,
    environment,
    config,
    identity: upstreamIdentityStrings(upstream),
    owner: `${env.workerName} Worker`,
    secrets: env.secrets,
  });
}

/** Rendered file names; the API Worker keeps its original, unprefixed names. */
export function renderedFileNames(
  component: DeploymentComponentName,
  environment: DeploymentEnvironmentName,
): { fileName: string; secretsFileName: string } {
  const infix = component === "api" ? "" : `${component}.`;
  return {
    fileName: `wrangler.${infix}${environment}.jsonc`,
    secretsFileName: `secrets.${infix}${environment}.txt`,
  };
}

/** Serialise a configuration, refuse eliza identity, and list its secrets. */
export function finishRender(input: {
  readonly component: DeploymentComponentName;
  readonly deployment: Deployment;
  readonly environment: DeploymentEnvironmentName;
  readonly config: Table;
  /** Strings that identify the eliza deployment upstream. */
  readonly identity: readonly string[];
  /** What the secrets belong to, for the secrets file header. */
  readonly owner: string;
  readonly secrets: readonly string[];
}): RenderedConfig {
  const { component, deployment, environment, config } = input;
  for (const key of Object.keys(config)) {
    if (config[key] === undefined) delete config[key];
  }
  const { fileName, secretsFileName } = renderedFileNames(
    component,
    environment,
  );
  const text = [
    `// Generated by @elizaos/cloud-deploy from deployment "${deployment.id}" (${environment}${component === "api" ? "" : `, ${component}`}).`,
    "// Do not edit: change the deployment file and render again.",
    `${JSON.stringify(config, null, 2)}\n`,
  ].join("\n");

  if (deployment.id !== ELIZA_DEPLOYMENT_ID) {
    const hits = findElizaIdentity(text, input.identity);
    if (hits.length > 0) {
      throw new RenderError(
        `rendered ${component} config for "${deployment.id}" carries eliza identity: ${hits.join(", ")}`,
      );
    }
  }

  const secretsText =
    component === "web"
      ? [
          `# The ${input.owner} is configured without secrets.`,
          ...input.secrets,
          "",
        ].join("\n")
      : [
          `# Secrets the ${input.owner} needs. Names only; set each with`,
          `#   wrangler secret put <NAME> --config ${fileName}`,
          ...input.secrets,
          "",
        ].join("\n");

  return { component, config, text, fileName, secretsText, secretsFileName };
}

/** Parse a rendered `wrangler.<environment>.jsonc` (leading `//` lines, then JSON). */
export function parseRenderedConfig(text: string): Table {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => !line.startsWith("//"));
  return JSON.parse(lines.slice(start).join("\n")) as Table;
}
