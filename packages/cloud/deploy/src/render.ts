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

export function readUpstreamWranglerToml(upstreamRoot: string): Table {
  const file = join(upstreamRoot, UPSTREAM_WRANGLER_TOML);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    throw new RenderError(
      `--upstream has no ${UPSTREAM_WRANGLER_TOML} (looked for ${file})`,
    );
  }
  return parseToml(text);
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

/** Upstream environment whose structure every rendered config follows. */
const TEMPLATE_ENVIRONMENT = "production";

function table(value: unknown, what: string): Table {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RenderError(`upstream wrangler.toml: ${what} is not a table`);
  }
  return value as Table;
}

function tables(value: unknown, what: string): Table[] {
  if (!Array.isArray(value)) {
    throw new RenderError(
      `upstream wrangler.toml: ${what} is not an array of tables`,
    );
  }
  return value.map((entry, index) => table(entry, `${what}[${index}]`));
}

function single(value: unknown, what: string): Table {
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

/** Rewrite a path written relative to upstream's API directory. */
function rebase(path: string, apiDir: string, outDir: string): string {
  if (resolve(outDir) === resolve(apiDir)) return path;
  const moved = relative(resolve(outDir), resolve(apiDir, path))
    .split(sep)
    .join("/");
  return moved.startsWith(".") ? moved : `./${moved}`;
}

function isRelativePath(value: string): boolean {
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
  /** The Wrangler configuration object. */
  readonly config: Table;
  /** `wrangler.<environment>.jsonc` contents. */
  readonly text: string;
  readonly fileName: string;
  /** `secrets.<environment>.txt` contents: one required secret name per line. */
  readonly secretsText: string;
  readonly secretsFileName: string;
}

export function deploymentVars(
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
    ...(env.vars ?? {}),
  };
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
  };
  scan(upstream);
  for (const env of Object.values((upstream.env as Table | undefined) ?? {}))
    scan(env as Table);
  return [...found];
}

/** Eliza identity found in rendered text; empty when there is none. */
export function findElizaIdentity(text: string, upstream: Table): string[] {
  const hits = upstreamIdentityStrings(upstream).filter((value) =>
    text.includes(value),
  );
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
  const objectBindings = tables(
    table(template.durable_objects, "durable_objects").bindings,
    "durable_objects.bindings",
  ).map((binding) => {
    const { script_name: _upstreamOwner, ...rest } = binding;
    const owner = transfers[String(binding.class_name)];
    return owner ? { ...rest, script_name: owner } : rest;
  });

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

  const fileName = `wrangler.${environment}.jsonc`;
  const text = [
    `// Generated by @elizaos/cloud-deploy from deployment "${deployment.id}" (${environment}).`,
    "// Do not edit: change the deployment file and render again.",
    `${JSON.stringify(config, null, 2)}\n`,
  ].join("\n");

  if (deployment.id !== ELIZA_DEPLOYMENT_ID) {
    const hits = findElizaIdentity(text, upstream);
    if (hits.length > 0) {
      throw new RenderError(
        `rendered config for "${deployment.id}" carries eliza identity: ${hits.join(", ")}`,
      );
    }
  }

  const secretsFileName = `secrets.${environment}.txt`;
  const secretsText = [
    `# Secrets the ${env.workerName} Worker needs. Names only; set each with`,
    `#   wrangler secret put <NAME> --config ${fileName}`,
    ...env.secrets,
    "",
  ].join("\n");

  return { config, text, fileName, secretsText, secretsFileName };
}

/** Parse a rendered `wrangler.<environment>.jsonc` (leading `//` lines, then JSON). */
export function parseRenderedConfig(text: string): Table {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => !line.startsWith("//"));
  return JSON.parse(lines.slice(start).join("\n")) as Table;
}
