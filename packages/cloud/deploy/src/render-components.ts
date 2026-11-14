/**
 * Renders the parts of a Cloud other than the API Worker: the Steward login
 * Worker, the speech and admission Workers, and the Pages front end.
 *
 * As for the API Worker, structure comes from each component's upstream
 * `wrangler.toml` and identity comes only from the deployment file. A binding
 * that upstream points at another eliza Worker is pointed at this
 * deployment's Worker that exports the same class or entrypoint.
 */

import { isAbsolute, join } from "node:path";
import {
  allUpstreamIdentityStrings,
  finishRender,
  identityVars,
  isRelativePath,
  RenderError,
  type RenderedConfig,
  type RenderOptions,
  readUpstreamComponentToml,
  rebase,
  renderWranglerConfig,
  single,
  table,
  tables,
  UPSTREAM_COMPONENT_DIRS,
} from "./render";
import {
  ADMISSION_GATE_CLASS,
  DEPLOYMENT_COMPONENTS,
  type DeploymentComponentName,
  type DeploymentEnvironment,
  type DeploymentRoute,
  LOGIN_DERIVED_VARS,
  WEB_DERIVED_VARS,
} from "./schema";

type Table = Record<string, unknown>;

export interface ComponentRenderOptions extends RenderOptions {
  readonly component: DeploymentComponentName;
}

/** A component other than the API Worker is rendered from a checkout. */
type CheckoutRenderOptions = ComponentRenderOptions & {
  readonly upstreamRoot: string;
};

/** Upstream environment whose structure the login render follows. */
const LOGIN_TEMPLATE_ENVIRONMENT = "production";

const KNOWN_KEYS: Readonly<Record<string, ReadonlySet<string>>> = {
  login: new Set([
    "name",
    "main",
    "account_id",
    "compatibility_date",
    "compatibility_flags",
    "workers_dev",
    "preview_urls",
    "observability",
    "migrations",
    "env",
  ]),
  "login env": new Set([
    "name",
    "workers_dev",
    "preview_urls",
    "routes",
    "vars",
    "triggers",
    "containers",
    "durable_objects",
  ]),
  "login container": new Set([
    "class_name",
    "image",
    "image_build_context",
    "max_instances",
    "instance_type",
  ]),
  speech: new Set([
    "name",
    "main",
    "account_id",
    "compatibility_date",
    "compatibility_flags",
    "workers_dev",
    "preview_urls",
    "minify",
    "define",
    "alias",
    "observability",
    "exports",
    "durable_objects",
    "hyperdrive",
    "kv_namespaces",
    "vars",
  ]),
  admission: new Set([
    "name",
    "main",
    "account_id",
    "compatibility_date",
    "compatibility_flags",
    "workers_dev",
    "preview_urls",
    "keep_vars",
    "define",
    "alias",
    "observability",
    "exports",
    "durable_objects",
    "vars",
    "services",
  ]),
  web: new Set([
    "name",
    "pages_build_output_dir",
    "compatibility_date",
    "compatibility_flags",
    "vars",
    "services",
    "env",
  ]),
  "web env": new Set(["vars", "services"]),
};

/** An upstream key the renderer does not know may carry identity: stop. */
function assertKnown(config: Table, what: string): void {
  for (const key of Object.keys(config)) {
    if (!KNOWN_KEYS[what].has(key)) {
      throw new RenderError(
        `upstream ${what} configuration has a key the renderer does not know: ${key}`,
      );
    }
  }
}

function rebasedAlias(
  value: unknown,
  componentDir: string,
  outDir: string,
): Record<string, string> {
  const alias: Record<string, string> = {};
  for (const [name, target] of Object.entries(table(value ?? {}, "alias"))) {
    if (typeof target !== "string")
      throw new RenderError(`alias ${name} is not a string`);
    alias[name] = isRelativePath(target)
      ? rebase(target, componentDir, outDir)
      : target;
  }
  return alias;
}

function renderedRoutes(
  routes: readonly DeploymentRoute[] | undefined,
): Table[] | undefined {
  return routes && routes.length > 0
    ? routes.map((route) => ({
        pattern: route.pattern,
        zone_name: route.zone,
      }))
    : undefined;
}

function exportedClasses(config: Table): Set<string> {
  return new Set(Object.keys(table(config.exports ?? {}, "exports")));
}

/** Names the eliza deployment gives its API Worker in any environment. */
function upstreamApiWorkerNames(upstreamRoot: string): Set<string> {
  const api = readUpstreamComponentToml(upstreamRoot, "api");
  const names = new Set<string>();
  for (const config of [
    api,
    ...Object.values(table(api.env ?? {}, "env")),
  ] as Table[]) {
    if (typeof config.name === "string") names.add(config.name);
  }
  return names;
}

/**
 * The Worker of this deployment that owns a Durable Object class another
 * component binds. Upstream's `script_name` is never used: it names an eliza
 * Worker.
 */
function classOwner(
  className: string,
  env: DeploymentEnvironment,
  upstreamRoot: string,
): string {
  if (className === ADMISSION_GATE_CLASS && env.components?.admission) {
    return env.components.admission.workerName;
  }
  const transferred = env.durableObjectTransfers?.[className];
  if (transferred) return transferred;
  const api = readUpstreamComponentToml(upstreamRoot, "api");
  if (!exportedClasses(api).has(className)) {
    throw new RenderError(
      `no Worker of this deployment is known to export ${className}`,
    );
  }
  return env.workerName;
}

function renderLogin(options: CheckoutRenderOptions): RenderedConfig {
  const { deployment, environment, upstreamRoot, outDir } = options;
  const env = deployment.environments[environment] as DeploymentEnvironment;
  const login = env.components?.login;
  if (!login) throw missing(options);

  const dir = join(upstreamRoot, UPSTREAM_COMPONENT_DIRS.login);
  const upstream = readUpstreamComponentToml(upstreamRoot, "login");
  assertKnown(upstream, "login");
  const template = table(
    table(upstream.env, "env")[LOGIN_TEMPLATE_ENVIRONMENT],
    `env.${LOGIN_TEMPLATE_ENVIRONMENT}`,
  );
  assertKnown(template, "login env");
  const inherited = (key: string): unknown => template[key] ?? upstream[key];

  for (const name of Object.keys(table(template.vars ?? {}, "vars"))) {
    if (!(LOGIN_DERIVED_VARS as readonly string[]).includes(name)) {
      throw new RenderError(
        `upstream login configuration sets a variable the renderer does not derive: ${name}`,
      );
    }
  }
  const bindings = tables(
    table(template.durable_objects, "durable_objects").bindings,
    "durable_objects.bindings",
  );
  for (const binding of bindings) {
    if (binding.script_name !== undefined) {
      throw new RenderError(
        `upstream login binding ${String(binding.name)} names another Worker; the renderer must handle it`,
      );
    }
  }

  const container = single(template.containers, "containers");
  assertKnown(container, "login container");
  if (
    typeof container.image !== "string" ||
    typeof container.image_build_context !== "string"
  ) {
    throw new RenderError("upstream login container has no image to build");
  }
  const main = inherited("main");
  if (typeof main !== "string")
    throw new RenderError("upstream login configuration has no main");

  const config: Table = {
    name: login.workerName,
    main: rebase(main, dir, outDir),
    account_id: env.accountId,
    compatibility_date: inherited("compatibility_date"),
    compatibility_flags: inherited("compatibility_flags"),
    workers_dev: inherited("workers_dev"),
    preview_urls: inherited("preview_urls"),
    routes: [{ pattern: login.host, custom_domain: true }],
    observability: inherited("observability"),
    triggers: template.triggers,
    migrations: upstream.migrations,
    containers: [
      {
        class_name: container.class_name,
        ...(login.container.image
          ? { image: login.container.image }
          : {
              image: rebase(container.image, dir, outDir),
              image_build_context: rebase(
                container.image_build_context,
                dir,
                outDir,
              ),
            }),
        max_instances: login.container.maxInstances,
        instance_type: login.container.instanceType,
      },
    ],
    durable_objects: { bindings },
    vars: {
      LOGIN_ENABLED: login.enabled ? "true" : "false",
      ...(login.vars ?? {}),
    },
  };
  return finishRender({
    component: "login",
    deployment,
    environment,
    config,
    identity: allUpstreamIdentityStrings(upstreamRoot),
    owner: `${login.workerName} Worker`,
    secrets: login.secrets,
  });
}

/** Shared by the speech and admission Workers, which upstream configures alike. */
function renderLeanWorker(
  options: CheckoutRenderOptions,
  component: "speech" | "admission",
): RenderedConfig {
  const { deployment, environment, upstreamRoot, outDir } = options;
  const env = deployment.environments[environment] as DeploymentEnvironment;
  const worker = env.components?.[component];
  if (!worker) throw missing(options);

  const dir = join(upstreamRoot, UPSTREAM_COMPONENT_DIRS[component]);
  const upstream = readUpstreamComponentToml(upstreamRoot, component);
  assertKnown(upstream, component);
  if (typeof upstream.main !== "string")
    throw new RenderError(`upstream ${component} configuration has no main`);

  const own = exportedClasses(upstream);
  const bindings = tables(
    table(upstream.durable_objects, "durable_objects").bindings,
    "durable_objects.bindings",
  ).map((binding) => {
    const { script_name: upstreamOwner, ...rest } = binding;
    const className = String(binding.class_name);
    if (upstreamOwner === undefined) {
      if (!own.has(className)) {
        throw new RenderError(
          `upstream ${component} Worker binds ${className} without exporting it`,
        );
      }
      return rest;
    }
    return { ...rest, script_name: classOwner(className, env, upstreamRoot) };
  });

  // Every service binding upstream declares reaches the API Worker.
  const apiNames = upstreamApiWorkerNames(upstreamRoot);
  const services =
    upstream.services === undefined
      ? undefined
      : tables(upstream.services, "services").map((service) => {
          if (!apiNames.has(String(service.service))) {
            throw new RenderError(
              `upstream ${component} service binding ${String(service.binding)} names a Worker the renderer does not know`,
            );
          }
          return { ...service, service: env.workerName };
        });

  const resources =
    component === "speech"
      ? (env.components?.speech?.resources ?? env.resources)
      : undefined;

  const config: Table = {
    name: worker.workerName,
    main: rebase(upstream.main, dir, outDir),
    account_id: env.accountId,
    compatibility_date: upstream.compatibility_date,
    compatibility_flags: upstream.compatibility_flags,
    workers_dev: upstream.workers_dev,
    preview_urls: upstream.preview_urls,
    minify: upstream.minify,
    keep_vars: upstream.keep_vars,
    routes: renderedRoutes(worker.routes),
    define: upstream.define,
    alias: rebasedAlias(upstream.alias, dir, outDir),
    observability: upstream.observability,
    exports: upstream.exports,
    durable_objects: { bindings },
    hyperdrive:
      upstream.hyperdrive === undefined
        ? undefined
        : [
            {
              ...single(upstream.hyperdrive, "hyperdrive"),
              id: resources?.hyperdriveId,
            },
          ],
    kv_namespaces:
      upstream.kv_namespaces === undefined
        ? undefined
        : [
            {
              ...single(upstream.kv_namespaces, "kv_namespaces"),
              id: resources?.kvNamespaceId,
            },
          ],
    services,
    // These Workers run the API's own classes, which resolve the deployment
    // from the same variables the API Worker is given.
    vars: {
      ...identityVars(deployment.id, environment, env),
      ...(worker.vars ?? {}),
    },
  };
  if (
    (config.hyperdrive || config.kv_namespaces) &&
    (!resources?.hyperdriveId || !resources.kvNamespaceId)
  ) {
    throw new RenderError(
      `upstream ${component} Worker binds a database or cache the deployment gives no id for`,
    );
  }
  return finishRender({
    component,
    deployment,
    environment,
    config,
    identity: allUpstreamIdentityStrings(upstreamRoot),
    owner: `${worker.workerName} Worker`,
    secrets: worker.secrets,
  });
}

function renderWeb(options: CheckoutRenderOptions): RenderedConfig {
  const { deployment, environment, upstreamRoot, outDir } = options;
  const env = deployment.environments[environment] as DeploymentEnvironment;
  const web = env.components?.web;
  if (!web) throw missing(options);

  const dir = join(upstreamRoot, UPSTREAM_COMPONENT_DIRS.web);
  const upstream = readUpstreamComponentToml(upstreamRoot, "web");
  assertKnown(upstream, "web");
  const scopes: Table[] = [upstream];
  for (const [name, scope] of Object.entries(
    table(upstream.env ?? {}, "env"),
  )) {
    assertKnown(table(scope, `env.${name}`), "web env");
    scopes.push(scope as Table);
  }
  // Every variable and binding upstream sets must be one the renderer
  // derives; otherwise a product would silently go without it.
  let binding: string | undefined;
  for (const scope of scopes) {
    for (const name of Object.keys(table(scope.vars ?? {}, "vars"))) {
      if (!(WEB_DERIVED_VARS as readonly string[]).includes(name)) {
        throw new RenderError(
          `upstream Pages configuration sets a variable the renderer does not derive: ${name}`,
        );
      }
    }
    const service = single(scope.services, "services");
    if (binding !== undefined && service.binding !== binding) {
      throw new RenderError(
        "upstream Pages environments bind the API Worker under different names",
      );
    }
    binding = String(service.binding);
    if (
      Object.keys(service).some((key) => !["binding", "service"].includes(key))
    )
      throw new RenderError(
        "upstream Pages service binding has a field the renderer does not know",
      );
  }
  if (typeof upstream.pages_build_output_dir !== "string") {
    throw new RenderError(
      "upstream Pages configuration has no pages_build_output_dir",
    );
  }

  const config: Table = {
    name: web.projectName,
    pages_build_output_dir: rebase(
      upstream.pages_build_output_dir,
      dir,
      outDir,
    ),
    compatibility_date: upstream.compatibility_date,
    compatibility_flags: upstream.compatibility_flags,
    vars: {
      CLOUD_DEPLOYMENT_ID: deployment.id,
      API_UPSTREAM: env.origins.api,
      VITE_ELIZA_CLOUD_BASE: env.origins.app,
      VITE_STEWARD_TENANT_ID: env.tenantId,
      NEXT_PUBLIC_STEWARD_TENANT_ID: env.tenantId,
      VITE_ENVIRONMENT: environment,
      ...(web.vars ?? {}),
    },
    // Pages reaches the API through this binding only; it is always this
    // deployment's API Worker.
    services: [{ binding, service: env.workerName }],
  };
  return finishRender({
    component: "web",
    deployment,
    environment,
    config,
    identity: allUpstreamIdentityStrings(upstreamRoot),
    owner: `${web.projectName} Pages project`,
    secrets: [],
  });
}

function missing(options: ComponentRenderOptions): RenderError {
  return new RenderError(
    `deployment "${options.deployment.id}" has no ${options.component} component in ${options.environment}`,
  );
}

/** Render one component of one environment. */
export function renderComponent(
  options: ComponentRenderOptions,
): RenderedConfig {
  const { deployment, environment, upstreamRoot, outDir, component } = options;
  if (!deployment.environments[environment]) {
    throw new RenderError(
      `deployment "${deployment.id}" has no ${environment} environment`,
    );
  }
  if (component === "api") return renderWranglerConfig(options);
  if (options.packagesRoot !== undefined || upstreamRoot === undefined) {
    // Only the API Worker is published as a package. The others are a
    // wrangler.toml beside sources in the checkout.
    throw new RenderError(
      `the ${component} component is rendered from an upstream checkout (upstreamRoot); only the API Worker renders from installed packages`,
    );
  }
  if (!isAbsolute(upstreamRoot) || !isAbsolute(outDir)) {
    throw new RenderError("upstreamRoot and outDir must be absolute paths");
  }
  const fromCheckout: CheckoutRenderOptions = { ...options, upstreamRoot };
  switch (component) {
    case "login":
      return renderLogin(fromCheckout);
    case "speech":
    case "admission":
      return renderLeanWorker(fromCheckout, component);
    case "web":
      return renderWeb(fromCheckout);
  }
}

/** The components an environment defines; the API Worker is always one. */
export function definedComponents(
  env: DeploymentEnvironment,
): DeploymentComponentName[] {
  return DEPLOYMENT_COMPONENTS.filter(
    (component) =>
      component === "api" || env.components?.[component] !== undefined,
  );
}
