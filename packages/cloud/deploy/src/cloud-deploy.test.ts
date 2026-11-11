import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveCloudDeployment } from "../../shared/src/lib/deployment/cloud-deployment";
import {
  findElizaIdentity,
  parseRenderedConfig,
  RenderError,
  readUpstreamWranglerToml,
  renderWranglerConfig,
  UPSTREAM_API_DIR,
} from "./render";
import {
  DEPLOYMENT_ENVIRONMENTS,
  type DeploymentEnvironmentName,
  DeploymentFileError,
  validateDeployment,
} from "./schema";

type Table = Record<string, unknown>;

const PACKAGE_DIR = resolve(import.meta.dir, "..");
const UPSTREAM_ROOT = resolve(PACKAGE_DIR, "..", "..", "..");
const API_DIR = join(UPSTREAM_ROOT, UPSTREAM_API_DIR);
const PRODUCT_DIR = "/srv/example-product/cloud";

function readJson(path: string): Table {
  return JSON.parse(readFileSync(join(PACKAGE_DIR, path), "utf8")) as Table;
}

const exampleProduct = () => readJson("examples/product.json");
const eliza = () => readJson("deployments/eliza.json");

/** The example with one change applied to its production environment. */
function productWith(change: (production: Table, root: Table) => void): Table {
  const root = exampleProduct();
  change((root.environments as Table).production as Table, root);
  return root;
}

function problemsOf(input: unknown): readonly string[] {
  try {
    validateDeployment(input);
  } catch (error) {
    if (error instanceof DeploymentFileError) return error.problems;
    throw error;
  }
  return [];
}

function renderProduct(environment: DeploymentEnvironmentName) {
  return renderWranglerConfig({
    deployment: validateDeployment(exampleProduct()),
    environment,
    upstreamRoot: UPSTREAM_ROOT,
    outDir: PRODUCT_DIR,
  });
}

describe("deployment file validation", () => {
  test("accepts the example product and the eliza deployment", () => {
    expect(problemsOf(exampleProduct())).toEqual([]);
    expect(problemsOf(eliza())).toEqual([]);
  });

  test("renders canonical blob authorities and refuses ports outside the URL range", () => {
    for (const [configured, canonical] of [
      ["blob.example.org:8443", "blob.example.org:8443"],
      ["blob.example.org:443", "blob.example.org"],
    ]) {
      const deployment = validateDeployment(
        productWith((env) => Object.assign(env, { blobHost: configured })),
      );
      const { config } = renderWranglerConfig({
        deployment,
        environment: "production",
        upstreamRoot: UPSTREAM_ROOT,
        outDir: PRODUCT_DIR,
      });
      const vars = config.vars as Record<string, string>;
      expect(vars.R2_PUBLIC_HOST).toBe(canonical);
      expect(resolveCloudDeployment(vars).blobHost).toBe(canonical);
    }
    for (const host of ["blob.example.org:65536", "blob.example.org:99999"]) {
      expect(
        problemsOf(
          productWith((env) => Object.assign(env, { blobHost: host })),
        ),
      ).toContain(
        "deployment.environments.production.blobHost: has an invalid value",
      );
    }
  });

  test("refuses an eliza host anywhere in a product deployment", () => {
    for (const host of [
      "eliza.app",
      "api.eliza.app",
      "blob-staging.elizacloud.ai",
    ]) {
      expect(
        problemsOf(
          productWith((env) => Object.assign(env, { blobHost: host })),
        ).join("\n"),
      ).toContain("names a host of the eliza deployment");
    }
    expect(
      problemsOf(
        productWith((env) => {
          (env.vars as Table).LOGIN_API_URL = "https://login.eliza.app";
        }),
      ).join("\n"),
    ).toContain(
      "deployment.environments.production.vars.LOGIN_API_URL: names a host",
    );
    // The eliza deployment is the one deployment that may name them.
    expect(mentionsHostProblem(eliza())).toBe(false);
    // A look-alike host is not an eliza host.
    expect(
      mentionsHostProblem(
        productWith((env) =>
          Object.assign(env, { blobHost: "blob.noteliza.app" }),
        ),
      ),
    ).toBe(false);
  });

  test("refuses values that look like secrets, without echoing them", () => {
    const samples = [
      `sk_live_${"a".repeat(24)}`,
      `whsec_${"b".repeat(24)}`,
      "-----BEGIN PRIVATE KEY-----",
      `ghp_${"c".repeat(36)}`,
      `0x${"d".repeat(64)}`,
      "postgres://app:hunter2@db.example.org:5432/app",
    ];
    for (const sample of samples) {
      const problems = problemsOf(
        productWith((env) => {
          (env.vars as Table).SOME_SETTING = sample;
        }),
      );
      expect(problems).toEqual([
        "deployment.environments.production.vars.SOME_SETTING: looks like a secret value; a deployment file holds names only",
      ]);
    }
  });

  test("never echoes rejected credentials through structural or host diagnostics", () => {
    const secret = `sk_live_${"a".repeat(24)}`;
    for (const input of [
      productWith((env) => {
        env.workerName = secret;
      }),
      productWith((env) => {
        (env.resources as Table).hyperdriveId = secret;
      }),
      productWith((env) => {
        env.billingUrl = `https://app:${secret}@api.eliza.app`;
      }),
      productWith((env) => {
        (env.vars as Table)[secret] = "value";
      }),
      productWith((env) => {
        (env.secrets as string[]).push(secret, secret);
      }),
    ]) {
      const problems = problemsOf(input);
      expect(problems.length).toBeGreaterThan(0);
      expect(problems.join("\n")).not.toContain(secret);
    }
  });

  test("refuses a secret name used as a plain variable, and a value in the secrets list", () => {
    expect(
      problemsOf(
        productWith((env) => {
          (env.vars as Table).STRIPE_SECRET_KEY = "x";
        }),
      ),
    ).toEqual([
      "deployment.environments.production.vars.STRIPE_SECRET_KEY: is a secret name; list it under secrets instead",
    ]);
    expect(
      problemsOf(
        productWith((env) => {
          (env.secrets as string[]).push("CRON_SECRET=abc");
        }),
      ).join("\n"),
    ).toContain("secrets[6]: has an invalid value");
  });

  test("refuses a variable that a typed field already sets", () => {
    expect(
      problemsOf(
        productWith((env) => {
          (env.vars as Table).R2_PUBLIC_HOST = "blob.example.org";
        }),
      ),
    ).toEqual([
      "deployment.environments.production.vars.R2_PUBLIC_HOST: is set from a typed field and may not be repeated",
    ]);
  });

  test("refuses malformed identity and resources", () => {
    const cases: [(env: Table, root: Table) => void, string][] = [
      [
        (env) => Object.assign(env, { accountId: "abc" }),
        "accountId: has an invalid value",
      ],
      [
        (env) => Object.assign(env, { workerName: "Not A Name" }),
        "workerName: has an invalid",
      ],
      [
        (env) => Object.assign(env, { routes: [] }),
        "routes: must be a non-empty array",
      ],
      [
        (env) =>
          Object.assign(env, {
            routes: [{ pattern: "api.example.net/*", zone: "example.org" }],
          }),
        "host api.example.net is not in zone example.org",
      ],
      [
        (env) =>
          Object.assign(env.origins as Table, {
            api: "https://api.example.org/v1",
          }),
        "origins.api: has an invalid value",
      ],
      [
        (env) =>
          Object.assign(env.origins as Table, { web: "http://example.org" }),
        "origins.web: has an invalid value",
      ],
      [
        (env) => Object.assign(env, { mailFrom: "nobody" }),
        "mailFrom: has an invalid value",
      ],
      [(env) => delete env.tenantId, "tenantId: must be a non-empty string"],
      [
        (env) => delete env.secrets,
        "secrets: must be an array of secret names",
      ],
      [
        (env) =>
          Object.assign(env.resources as Table, {
            hyperdriveId: "my-database",
          }),
        "resources.hyperdriveId: has an invalid value",
      ],
      [
        (env) => Object.assign(env, { zoneId: "x" }),
        "production.zoneId: is not a known field",
      ],
      [
        (_env, root) => Object.assign(root, { id: "Example" }),
        "deployment.id: has an invalid",
      ],
      [
        (_env, root) => Object.assign(root, { environments: {} }),
        "must define staging, production or both",
      ],
      [
        (env, root) =>
          Object.assign(env, {
            workerName: ((root.environments as Table).staging as Table)
              .workerName,
          }),
        "staging and production share a workerName",
      ],
    ];
    for (const [change, expected] of cases) {
      expect(problemsOf(productWith(change)).join("\n")).toContain(expected);
    }
    expect(problemsOf(null)).toEqual(["deployment: must be an object"]);
  });
});

function mentionsHostProblem(input: unknown): boolean {
  return problemsOf(input).some((problem) =>
    problem.includes("names a host of the eliza"),
  );
}

describe("product render", () => {
  const upstream = readUpstreamWranglerToml(UPSTREAM_ROOT);

  for (const environment of DEPLOYMENT_ENVIRONMENTS) {
    test(`${environment} carries no eliza identity`, () => {
      const { text, secretsText } = renderProduct(environment);
      const rendered = `${text}\n${secretsText}`;

      expect(findElizaIdentity(rendered, upstream)).toEqual([]);
      // Independent of the renderer's own scan: the literal identity of the
      // eliza deployment as upstream's wrangler.toml states it.
      for (const literal of [
        "eliza.app",
        "elizacloud.ai",
        "23cf6feaeaa541f6a0675053c33da768",
        "eliza-cloud-api",
        "eliza-cloud-blob",
        "eliza-cloud-admission",
        "elizacloud",
        "eliza-alpha-phone",
        "eliza-cloud-apps",
        "square-rain-7251",
        "0x72D043586b6226A97197408b4EE41572dD000ac6",
      ]) {
        expect(rendered).not.toContain(literal);
      }
      // Every resource id upstream binds, including rate-limit namespaces.
      const upstreamText = readFileSync(join(API_DIR, "wrangler.toml"), "utf8");
      const ids = [
        ...upstreamText.matchAll(/^\s*(?:id|namespace_id)\s*=\s*"([^"]+)"/gm),
      ].map((match) => match[1]);
      expect(ids.length).toBeGreaterThan(10);
      for (const id of ids) expect(rendered).not.toContain(`"${id}"`);
    });

    test(`${environment} parses and fills identity and resources from the file`, () => {
      const { text, config, secretsText } = renderProduct(environment);
      expect(parseRenderedConfig(text)).toEqual(config);

      const env = (exampleProduct().environments as Table)[
        environment
      ] as Table;
      const resources = env.resources as Table;
      expect(config.name).toBe(env.workerName);
      expect(config.account_id).toBe(env.accountId);
      expect(config.routes).toEqual(
        (env.routes as Table[]).map((route) => ({
          pattern: route.pattern,
          zone_name: route.zone,
        })),
      );
      expect(config.r2_buckets).toEqual([
        { binding: "BLOB", bucket_name: resources.r2Bucket },
      ]);
      expect(config.hyperdrive).toEqual([
        { binding: "HYPERDRIVE", id: resources.hyperdriveId },
      ]);
      expect(config.kv_namespaces).toEqual([
        { binding: "CACHE_KV", id: resources.kvNamespaceId },
      ]);
      expect(
        Object.fromEntries(
          (config.ratelimits as Table[]).map((limit) => [
            limit.name,
            limit.namespace_id,
          ]),
        ),
      ).toEqual(resources.rateLimitNamespaceIds as Table);
      expect(
        secretsText.split("\n").filter((line) => line && !line.startsWith("#")),
      ).toEqual(env.secrets as string[]);
    });

    test(`${environment} variables satisfy resolveCloudDeployment`, () => {
      const vars = renderProduct(environment).config.vars as Record<
        string,
        string
      >;
      const env = (exampleProduct().environments as Table)[
        environment
      ] as Table;
      const origins = env.origins as Record<string, string>;
      const deployment = resolveCloudDeployment(vars);
      expect(deployment.id).toBe("example-product");
      expect(deployment.isEliza).toBe(false);
      expect(deployment.webOrigin).toBe(origins.web);
      expect(deployment.appOrigin).toBe(origins.app);
      expect(deployment.apiOrigin).toBe(origins.api);
      expect(deployment.tenantId).toBe(env.tenantId as string);
      expect(deployment.blobHost).toBe(env.blobHost as string);
      expect(deployment.mailFrom).toBe(env.mailFrom as string);
      expect(deployment.billingUrl).toBe(env.billingUrl as string);
    });
  }

  test("structure comes from upstream and every path resolves from the product directory", () => {
    const { config } = renderProduct("production");
    expect(resolve(PRODUCT_DIR, config.main as string)).toBe(
      join(API_DIR, "src/index.ts"),
    );
    const upstreamAlias = upstream.alias as Record<string, string>;
    const alias = config.alias as Record<string, string>;
    expect(Object.keys(alias)).toEqual(Object.keys(upstreamAlias));
    const dangling: string[] = [];
    for (const [name, target] of Object.entries(alias)) {
      expect(resolve(PRODUCT_DIR, target)).toBe(
        resolve(API_DIR, upstreamAlias[name]),
      );
      if (!existsSync(resolve(PRODUCT_DIR, target))) dangling.push(name);
    }
    // Upstream's own file aliases this specifier to a path that no longer
    // exists (the contract moved to packages/contracts). Nothing imports it,
    // so the bundle is unaffected; it is carried as written.
    expect(dangling).toEqual([
      "@elizaos/core/contracts/cloud-coding-containers",
    ]);
    expect(config.triggers).toEqual(upstream.triggers);
    expect(config.compatibility_date).toBe(upstream.compatibility_date);
    expect(config.exports).toEqual(upstream.exports);
    const production = (upstream.env as Table).production as Table;
    expect(config.compatibility_flags).toEqual(production.compatibility_flags);
    expect(config.durable_objects).toEqual(production.durable_objects);
    expect(config.define).toEqual(production.define);
    expect(config.ai).toEqual(production.ai);
    expect(config.browser).toEqual(production.browser);
  });

  test("refuses a missing environment, a missing namespace id and an unknown class", () => {
    const render = (
      input: Table,
      environment: DeploymentEnvironmentName = "production",
    ) =>
      renderWranglerConfig({
        deployment: validateDeployment(input),
        environment,
        upstreamRoot: UPSTREAM_ROOT,
        outDir: PRODUCT_DIR,
      });
    expect(() =>
      render(
        productWith(
          (_env, root) => delete (root.environments as Table).staging,
        ),
        "staging",
      ),
    ).toThrow(RenderError);
    expect(() =>
      render(
        productWith((env) => {
          delete ((env.resources as Table).rateLimitNamespaceIds as Table)
            .GLOBAL_RATE_LIMITER;
        }),
      ),
    ).toThrow("no id for binding GLOBAL_RATE_LIMITER");
    expect(() =>
      render(
        productWith((env) =>
          Object.assign(env, { durableObjectTransfers: { Nope: "w" } }),
        ),
      ),
    ).toThrow("unknown class Nope");
  });

  test("refuses a product that reuses an eliza resource", () => {
    const production = (upstream.env as Table).production as Table;
    const hyperdriveId = ((production.hyperdrive as Table[])[0] as Table).id;
    expect(() =>
      renderWranglerConfig({
        deployment: validateDeployment(
          productWith((env) =>
            Object.assign(env.resources as Table, { hyperdriveId }),
          ),
        ),
        environment: "production",
        upstreamRoot: UPSTREAM_ROOT,
        outDir: PRODUCT_DIR,
      }),
    ).toThrow("carries eliza identity");
  });
});

/**
 * What Wrangler deploys for `--env <name>` of upstream's wrangler.toml: the
 * environment's own keys over the top-level keys an environment inherits.
 */
function upstreamEffective(upstream: Table, environment: string): Table {
  const inheritable = [
    "main",
    "compatibility_date",
    "compatibility_flags",
    "account_id",
    "workers_dev",
    "minify",
    "keep_vars",
    "alias",
    "observability",
    "triggers",
    "exports",
  ];
  const effective: Table = {};
  for (const key of inheritable) {
    if (upstream[key] !== undefined) effective[key] = upstream[key];
  }
  return { ...effective, ...((upstream.env as Table)[environment] as Table) };
}

/** Paths at which two configs differ; `vars` is compared one variable at a time. */
function differences(rendered: Table, expected: Table): string[] {
  const out: string[] = [];
  const compare = (left: Table, right: Table, prefix: string) => {
    for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
      const path = `${prefix}${key}`;
      if (!(key in left)) out.push(`${path}: only upstream`);
      else if (!(key in right)) out.push(`${path}: only rendered`);
      else if (key === "vars" && !prefix)
        compare(left.vars as Table, right.vars as Table, "vars.");
      else if (!Bun.deepEquals(left[key], right[key], true))
        out.push(`${path}: differs`);
    }
  };
  compare(rendered, expected, "");
  return out.sort();
}

describe("eliza render parity with packages/cloud/api/wrangler.toml", () => {
  const upstream = readUpstreamWranglerToml(UPSTREAM_ROOT);

  /**
   * Variables the rendered config adds. Upstream's file does not set them:
   * the eliza deployment is the default, so the Worker falls back to values
   * compiled into `resolveElizaDeployment`. The deployment file states the
   * same values explicitly. `CLOUD_WEB_ORIGIN` and `CLOUD_BILLING_URL` are not
   * read for the eliza deployment at all.
   */
  const ADDED_VARS = [
    "vars.CLOUD_BILLING_URL: only rendered",
    "vars.CLOUD_DEPLOYMENT_ID: only rendered",
    "vars.CLOUD_PUBLIC_SERVICE_NAME: only rendered",
    "vars.CLOUD_WEB_ORIGIN: only rendered",
    "vars.NEXT_PUBLIC_ASSETS_CDN_URL: only rendered",
    "vars.SENDGRID_FROM_EMAIL: only rendered",
  ];

  const render = (environment: DeploymentEnvironmentName) =>
    renderWranglerConfig({
      deployment: validateDeployment(eliza()),
      environment,
      upstreamRoot: UPSTREAM_ROOT,
      // Rendered beside upstream's file so that paths compare as written.
      outDir: API_DIR,
    }).config;

  test("production differs only by the added deployment variables", () => {
    expect(
      differences(
        render("production"),
        upstreamEffective(upstream, "production"),
      ),
    ).toEqual(ADDED_VARS);
  });

  test("staging differs only by those variables and the empty migrations list", () => {
    expect(
      differences(render("staging"), upstreamEffective(upstream, "staging")),
    ).toEqual(
      [
        // Upstream writes `migrations = []` on staging to state that it has
        // none. The rendered config has no migrations key, which means the same.
        "migrations: only upstream",
        ...ADDED_VARS,
      ].sort(),
    );
  });

  test("the added variables equal what the eliza deployment already resolves to", () => {
    for (const environment of DEPLOYMENT_ENVIRONMENTS) {
      const upstreamVars = ((upstream.env as Table)[environment] as Table)
        .vars as Record<string, string>;
      const renderedVars = render(environment).vars as Record<string, string>;
      const before = resolveCloudDeployment(upstreamVars);
      const after = resolveCloudDeployment(renderedVars);
      expect(after).toEqual(before);
      expect(renderedVars.CLOUD_PUBLIC_SERVICE_NAME).toBe(before.serviceName);
      expect(renderedVars.NEXT_PUBLIC_ASSETS_CDN_URL).toBe(before.assetsBase);
      expect(renderedVars.SENDGRID_FROM_EMAIL).toBe(before.mailFrom);
      expect(renderedVars.CLOUD_BILLING_URL).toBe(before.billingUrl);
      expect(renderedVars.CLOUD_WEB_ORIGIN).toBe(before.webOrigin);
    }
  });
});
