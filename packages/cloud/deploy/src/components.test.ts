import { describe, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { findWrangler } from "./check";
import {
  allUpstreamIdentityStrings,
  findElizaIdentity,
  RenderError,
  readUpstreamComponentToml,
  renderedFileNames,
  renderWranglerConfig,
  UPSTREAM_COMPONENT_DIRS,
} from "./render";
import { definedComponents, renderComponent } from "./render-components";
import {
  DEPLOYMENT_COMPONENTS,
  DEPLOYMENT_ENVIRONMENTS,
  type DeploymentComponentName,
  type DeploymentEnvironmentName,
  DeploymentFileError,
  LOGIN_REQUIRED_PRODUCT_VARS,
  LOGIN_REQUIRED_SECRETS,
  validateDeployment,
} from "./schema";

type Table = Record<string, unknown>;

const PACKAGE_DIR = resolve(import.meta.dir, "..");
const UPSTREAM_ROOT = resolve(PACKAGE_DIR, "..", "..", "..");
const PRODUCT_DIR = "/srv/example-product/cloud";
const COMPONENTS = ["login", "speech", "admission", "web"] as const;

const readJson = (path: string): Table =>
  JSON.parse(readFileSync(join(PACKAGE_DIR, path), "utf8")) as Table;
const exampleProduct = () => readJson("examples/product.json");
const eliza = () => readJson("deployments/eliza.json");
const componentDir = (component: DeploymentComponentName) =>
  join(UPSTREAM_ROOT, UPSTREAM_COMPONENT_DIRS[component]);

/** The example with one change applied to its production components. */
function productWith(
  change: (components: Record<string, Table>, env: Table, root: Table) => void,
): Table {
  const root = exampleProduct();
  const env = (root.environments as Table).production as Table;
  change(env.components as Record<string, Table>, env, root);
  return root;
}

function problemsOf(input: unknown): string {
  try {
    validateDeployment(input);
  } catch (error) {
    if (error instanceof DeploymentFileError) return error.problems.join("\n");
    throw error;
  }
  return "";
}

function render(
  input: Table,
  component: DeploymentComponentName,
  environment: DeploymentEnvironmentName = "production",
  options: { outDir?: string; upstreamRoot?: string } = {},
) {
  return renderComponent({
    deployment: validateDeployment(input),
    environment,
    component,
    upstreamRoot: options.upstreamRoot ?? UPSTREAM_ROOT,
    outDir: options.outDir ?? PRODUCT_DIR,
  });
}

function componentsOf(input: Table, environment: DeploymentEnvironmentName) {
  const env = validateDeployment(input).environments[environment];
  if (!env) throw new Error(`no ${environment} environment`);
  return definedComponents(env);
}

const bindings = (config: Table) =>
  (config.durable_objects as { bindings: Table[] }).bindings;
const scriptNames = (config: Table) =>
  Object.fromEntries(
    bindings(config)
      .filter((binding) => binding.script_name !== undefined)
      .map((binding) => [binding.class_name, binding.script_name]),
  );

describe("components in the deployment file", () => {
  test("a file without components is valid and renders the API Worker as before", () => {
    const withComponents = exampleProduct();
    const without = exampleProduct();
    for (const env of Object.values(without.environments as Table) as Table[]) {
      delete env.components;
    }
    expect(problemsOf(without)).toBe("");
    for (const environment of DEPLOYMENT_ENVIRONMENTS) {
      const direct = renderWranglerConfig({
        deployment: validateDeployment(without),
        environment,
        upstreamRoot: UPSTREAM_ROOT,
        outDir: PRODUCT_DIR,
      });
      expect(direct.fileName).toBe(`wrangler.${environment}.jsonc`);
      expect(direct.secretsFileName).toBe(`secrets.${environment}.txt`);
      expect(render(without, "api", environment).text).toBe(direct.text);
      expect(componentsOf(without, environment)).toEqual(["api"]);

      // Components change one thing in the API render: the speech host.
      const hosted = render(withComponents, "api", environment).config;
      const speech = (
        ((withComponents.environments as Table)[environment] as Table)
          .components as Record<string, Table>
      ).speech.workerName;
      expect(scriptNames(hosted).SpeechRelayCoordinator).toBe(speech);
      const plain = bindings(direct.config).map((binding) =>
        binding.class_name === "SpeechRelayCoordinator"
          ? { ...binding, script_name: speech }
          : binding,
      );
      expect(bindings(hosted)).toEqual(plain);
      expect({ ...hosted, durable_objects: null }).toEqual({
        ...direct.config,
        durable_objects: null,
      });
    }
  });

  test("file names keep the API's and prefix every other component", () => {
    expect(renderedFileNames("api", "staging")).toEqual({
      fileName: "wrangler.staging.jsonc",
      secretsFileName: "secrets.staging.txt",
    });
    for (const component of COMPONENTS) {
      const rendered = render(exampleProduct(), component, "staging");
      expect(rendered.fileName).toBe(`wrangler.${component}.staging.jsonc`);
      expect(rendered.secretsFileName).toBe(`secrets.${component}.staging.txt`);
    }
    expect(componentsOf(exampleProduct(), "staging")).toEqual([
      ...DEPLOYMENT_COMPONENTS,
    ]);
  });

  test("refuses malformed components", () => {
    const cases: [(c: Record<string, Table>, env: Table) => void, string][] = [
      [
        (c) => Object.assign(c, { queue: {} }),
        "components.queue: is not a known field",
      ],
      [
        (c) => Object.assign(c.login, { zone: "example.org" }),
        "login.zone: is not a known field",
      ],
      [
        (c) => Object.assign(c.login, { enabled: "true" }),
        "login.enabled: must be true or false",
      ],
      [
        (c) => Object.assign(c.login, { host: "https://login.example.org" }),
        "login.host: has an invalid value",
      ],
      [
        (c) => Object.assign(c.login.container as Table, { maxInstances: 0 }),
        "container.maxInstances: must be a positive integer",
      ],
      [
        (c) =>
          Object.assign(c.login.container as Table, { image: "./Dockerfile" }),
        "container.image: has an invalid value",
      ],
      [
        (c) => Object.assign(c.speech, { hostsSessions: "yes" }),
        "speech.hostsSessions: must be true or false",
      ],
      [
        (c) =>
          Object.assign(c.speech, {
            resources: { hyperdriveId: "x", kvNamespaceId: "y" },
          }),
        "speech.resources.hyperdriveId: has an invalid value",
      ],
      [
        (c) =>
          Object.assign(c.speech, {
            routes: [{ pattern: "speech.other.org/*", zone: "example.org" }],
          }),
        "host is not in the configured zone",
      ],
      [
        (c) => Object.assign(c.web, { projectName: "Example Web" }),
        "web.projectName: has an invalid value",
      ],
      [
        (c) => Object.assign(c.admission, { secrets: "none" }),
        "admission.secrets: must be an array of secret names",
      ],
      // A typed field already sets these.
      [
        (c) => Object.assign(c.login.vars as Table, { LOGIN_ENABLED: "true" }),
        "login.vars.LOGIN_ENABLED: is set from a typed field",
      ],
      [
        (c) =>
          Object.assign(c.web, {
            vars: { API_UPSTREAM: "https://api.example.org" },
          }),
        "web.vars.API_UPSTREAM: is set from a typed field",
      ],
      [
        (c) =>
          Object.assign(c.speech.vars as Table, { STEWARD_TENANT_ID: "other" }),
        "speech.vars.STEWARD_TENANT_ID: is set from a typed field",
      ],
      // Secrets are named, never valued, in every component.
      [
        (c) => Object.assign(c.speech.vars as Table, { CARTESIA_API_KEY: "x" }),
        "speech.vars.CARTESIA_API_KEY: is a secret name",
      ],
      [
        (c) =>
          Object.assign(c.web, { vars: { NOTE: `sk_live_${"a".repeat(24)}` } }),
        "web.vars.NOTE: looks like a secret value",
      ],
    ];
    for (const [change, expected] of cases) {
      expect(problemsOf(productWith(change))).toContain(expected);
    }
  });

  test("never echoes rejected credentials through component diagnostics", () => {
    const secret = `sk_live_${"a".repeat(24)}`;
    const credentialName = `AKIA${"A".repeat(16)}`;
    const cases: [
      (c: Record<string, Table>, env: Table, root: Table) => void,
      string,
    ][] = [
      [
        (c) => {
          c.login[secret] = "value";
        },
        secret,
      ],
      [
        (c, env) => {
          env.workerName = secret;
          c.admission.workerName = secret;
        },
        secret,
      ],
      [
        (c, _env, root) => {
          ((root.environments as Table).staging as Table).workerName = secret;
          c.speech.workerName = secret;
        },
        secret,
      ],
      [
        (c) => {
          c.speech.routes = [
            { pattern: `${secret}.example.org/*`, zone: "example.org" },
          ];
        },
        secret,
      ],
      [
        (c) => {
          c.admission.routes = [{ pattern: "api.example.org/*", zone: secret }];
        },
        secret,
      ],
    ];
    for (const component of COMPONENTS) {
      cases.push([
        (c) => {
          c[component].vars = {
            ...(c[component].vars as Table),
            [secret]: "value",
          };
        },
        secret,
      ]);
    }
    for (const component of ["login", "speech", "admission"] as const) {
      cases.push([
        (c) => {
          c[component].secrets = [
            ...(c[component].secrets as string[]),
            credentialName,
            credentialName,
          ];
          c[component].vars = {
            ...(c[component].vars as Table),
            [credentialName]: "value",
          };
        },
        credentialName,
      ]);
    }
    for (const [change, credential] of cases) {
      const problems = problemsOf(productWith(change));
      expect(problems).toContain("looks like a secret value");
      expect(problems).not.toContain(credential);
    }
  });

  test("the login Worker must name the secrets it cannot start without", () => {
    const source = readFileSync(
      join(componentDir("login"), "worker.ts"),
      "utf8",
    );
    const block = source.match(
      /const REQUIRED_RUNTIME_SETTINGS = \[([^\]]*)\]/,
    )?.[1];
    expect(
      block?.match(/"([A-Z_]+)"/g)?.map((name) => name.slice(1, -1)),
    ).toEqual([...LOGIN_REQUIRED_SECRETS]);
    for (const name of LOGIN_REQUIRED_SECRETS) {
      expect(
        problemsOf(
          productWith((c) => {
            c.login.secrets = (c.login.secrets as string[]).filter(
              (secret) => secret !== name,
            );
          }),
        ),
      ).toContain(`login.secrets: must list ${name}`);
    }
  });

  test("a product login must set every setting the runtime defaults to an eliza value", () => {
    // Each is read by the login runtime with an eliza host or sender as its
    // fallback; this pins the list to the source it describes.
    const runtime = [
      "src/server/api/services/auth-lifecycle.ts",
      "src/server/api/routes/auth.ts",
    ]
      .map((path) =>
        readFileSync(join(UPSTREAM_ROOT, "packages", "auth", path), "utf8"),
      )
      .join("\n");
    for (const name of LOGIN_REQUIRED_PRODUCT_VARS) {
      expect(runtime).toMatch(
        new RegExp(
          `(process\\.env\\.${name}|runtimeEnvironmentValue\\("${name}"\\))[^;]*?\\|\\|\\s*"[^"]*eliza`,
        ),
      );
      expect(
        problemsOf(productWith((c) => delete (c.login.vars as Table)[name])),
      ).toContain(`login.vars.${name}: is required`);
    }
    // The eliza deployment keeps its defaults.
    expect(problemsOf(eliza())).toBe("");
  });

  test("refuses an eliza host in any component of a product", () => {
    const cases: ((c: Record<string, Table>) => void)[] = [
      (c) => Object.assign(c.login, { host: "login.eliza.app" }),
      (c) =>
        Object.assign(c.login.vars as Table, { APP_URL: "https://eliza.app" }),
      (c) =>
        Object.assign(c.speech.vars as Table, {
          UPSTREAM: "https://api.elizacloud.ai",
        }),
      (c) =>
        Object.assign(c.admission, {
          routes: [{ pattern: "gate.eliza.app/*", zone: "eliza.app" }],
        }),
      (c) =>
        Object.assign(c.web, {
          vars: { SUPPORT_URL: "https://cloud.eliza.app/help" },
        }),
    ];
    for (const change of cases) {
      expect(problemsOf(productWith(change))).toContain(
        "names a host of the eliza deployment",
      );
    }
  });

  test("Worker names are distinct within and across environments", () => {
    expect(
      problemsOf(
        productWith((c, env) =>
          Object.assign(c.speech, { workerName: env.workerName }),
        ),
      ),
    ).toContain("speech.workerName: is also the api Worker's name");
    expect(
      problemsOf(
        productWith((c) =>
          Object.assign(c.speech, { workerName: c.login.workerName }),
        ),
      ),
    ).toContain("speech.workerName: is also the login Worker's name");
    expect(
      problemsOf(
        productWith((c, _env, root) =>
          Object.assign(c.login, {
            workerName: (
              ((root.environments as Table).staging as Table)
                .components as Record<string, Table>
            ).login.workerName,
          }),
        ),
      ),
    ).toContain(
      "production.components.login.workerName: is also a Worker of staging",
    );
    expect(
      problemsOf(
        productWith((c, _env, root) =>
          Object.assign(c.login, {
            workerName: ((root.environments as Table).staging as Table)
              .workerName,
          }),
        ),
      ),
    ).toContain("is also a Worker of staging");
  });

  test("an admission Worker requires the API to hand it the gate", () => {
    const expected =
      "components.admission.workerName: durableObjectTransfers.InferenceAdmissionGate must name this Worker";
    expect(
      problemsOf(productWith((_c, env) => delete env.durableObjectTransfers)),
    ).toContain(expected);
    expect(
      problemsOf(
        productWith((_c, env) =>
          Object.assign(env, {
            durableObjectTransfers: {
              InferenceAdmissionGate: "another-worker",
            },
          }),
        ),
      ),
    ).toContain(expected);
  });
});

describe("product component render", () => {
  const identity = allUpstreamIdentityStrings(UPSTREAM_ROOT);

  test("the identity scan covers every upstream component", () => {
    for (const expected of [
      "23cf6feaeaa541f6a0675053c33da768",
      "eliza-cloud-api-staging",
      "eliza-cloud-api-prod",
      "eliza-login-staging",
      "eliza-login-production",
      "eliza-cloud-speech-staging",
      "eliza-cloud-admission-staging",
      "eliza-app",
    ]) {
      expect(identity).toContain(expected);
    }
  });

  for (const environment of DEPLOYMENT_ENVIRONMENTS) {
    for (const component of COMPONENTS) {
      test(`${environment} ${component} carries no eliza identity`, () => {
        const { text, secretsText } = render(
          exampleProduct(),
          component,
          environment,
        );
        const rendered = `${text}\n${secretsText}`;
        expect(findElizaIdentity(rendered, identity)).toEqual([]);
        // Independent of the renderer's scan: upstream's literal identity.
        for (const literal of [
          "eliza.app",
          "elizacloud",
          "23cf6feaeaa541f6a0675053c33da768",
          "eliza-cloud-api",
          "eliza-cloud-speech",
          "eliza-cloud-admission",
          "eliza-login",
          "eliza-app",
          "ef65eb94c74144a3a3848ad1945571fb",
          "f7e24faaff734e7c8cd8e12b093c3571",
          "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4",
        ]) {
          expect(rendered).not.toContain(literal);
        }
      });
    }
  }

  test("bindings to another Worker name this product's Workers", () => {
    for (const environment of DEPLOYMENT_ENVIRONMENTS) {
      const env = (exampleProduct().environments as Table)[
        environment
      ] as Table;
      const parts = env.components as Record<string, Table>;

      const speech = render(exampleProduct(), "speech", environment).config;
      expect(scriptNames(speech)).toEqual({
        InferenceAdmissionGate: parts.admission.workerName,
        VoiceUsageState: env.workerName,
      });
      expect(speech.name).toBe(parts.speech.workerName);
      // Database and cache are the API Worker's unless the component says otherwise.
      const resources = env.resources as Table;
      expect((speech.hyperdrive as Table[])[0].id).toBe(resources.hyperdriveId);
      expect((speech.kv_namespaces as Table[])[0].id).toBe(
        resources.kvNamespaceId,
      );

      const admission = render(
        exampleProduct(),
        "admission",
        environment,
      ).config;
      expect(scriptNames(admission)).toEqual({});
      expect(admission.services).toEqual([
        {
          binding: "INFERENCE_RECOVERY_SERVICE",
          service: env.workerName,
          entrypoint: "InferenceRecoveryService",
        },
      ]);

      const web = render(exampleProduct(), "web", environment).config;
      expect(web.services).toEqual([
        { binding: "API_WORKER", service: env.workerName },
      ]);

      // The API and the speech Worker agree on who owns the gate.
      const api = render(exampleProduct(), "api", environment).config;
      expect(scriptNames(api).InferenceAdmissionGate).toBe(
        scriptNames(speech).InferenceAdmissionGate,
      );
    }
  });

  test("without an admission Worker the speech Worker binds the API's gate", () => {
    const input = productWith((c, env) => {
      delete c.admission;
      delete env.durableObjectTransfers;
    });
    const env = (input.environments as Table).production as Table;
    expect(scriptNames(render(input, "speech").config)).toEqual({
      InferenceAdmissionGate: env.workerName,
      VoiceUsageState: env.workerName,
    });
  });

  test("a speech Worker takes its own database and cache when given them", () => {
    const resources = {
      hyperdriveId: "00000000000000000000000000000031",
      kvNamespaceId: "00000000000000000000000000000032",
    };
    const { config } = render(
      productWith((c) => Object.assign(c.speech, { resources })),
      "speech",
    );
    expect((config.hyperdrive as Table[])[0].id).toBe(resources.hyperdriveId);
    expect((config.kv_namespaces as Table[])[0].id).toBe(
      resources.kvNamespaceId,
    );
  });

  test("speech and admission resolve the same deployment as the API Worker", () => {
    for (const environment of DEPLOYMENT_ENVIRONMENTS) {
      const env = (exampleProduct().environments as Table)[
        environment
      ] as Table;
      const api = render(exampleProduct(), "api", environment).config
        .vars as Record<string, string>;
      for (const component of ["speech", "admission"] as const) {
        const vars = render(exampleProduct(), component, environment).config
          .vars as Record<string, string>;
        const own = Object.keys(
          ((env.components as Record<string, Table>)[component].vars ??
            {}) as Table,
        );
        for (const [name, value] of Object.entries(vars)) {
          if (!own.includes(name)) expect(api[name]).toBe(value);
        }
        expect(vars.CLOUD_DEPLOYMENT_ID).toBe("example-product");
      }
    }
  });

  test("the Pages project uses the deployment identity without a callback registry", () => {
    const env = (exampleProduct().environments as Table).production as Table;
    const origins = env.origins as Record<string, string>;
    const { config, secretsText } = render(exampleProduct(), "web");
    const vars = config.vars as Record<string, string>;
    expect(config.name).toBe("example-product-web");
    expect(vars).toMatchObject({
      CLOUD_DEPLOYMENT_ID: "example-product",
      API_UPSTREAM: origins.api,
      VITE_ELIZA_CLOUD_BASE: origins.app,
      VITE_STEWARD_TENANT_ID: env.tenantId,
      NEXT_PUBLIC_STEWARD_TENANT_ID: env.tenantId,
      VITE_ENVIRONMENT: "production",
    });
    expect(
      secretsText.split("\n").filter((line) => line && !line.startsWith("#")),
    ).toEqual([]);
    expect("ELIZA_NATIVE_AUTH_CALLBACKS_JSON" in vars).toBe(false);
  });

  test("every path resolves from the product directory", () => {
    const login = render(exampleProduct(), "login").config;
    const container = (login.containers as Table[])[0];
    expect(resolve(PRODUCT_DIR, login.main as string)).toBe(
      join(componentDir("login"), "worker.ts"),
    );
    expect(resolve(PRODUCT_DIR, container.image as string)).toBe(
      join(componentDir("login"), "Dockerfile"),
    );
    expect(resolve(PRODUCT_DIR, container.image_build_context as string)).toBe(
      UPSTREAM_ROOT,
    );
    expect(login.routes).toEqual([
      { pattern: "login.example.org", custom_domain: true },
    ]);

    for (const component of ["speech", "admission"] as const) {
      const { config } = render(exampleProduct(), component);
      const main = resolve(PRODUCT_DIR, config.main as string);
      expect(main).toBe(join(componentDir(component), "src/index.ts"));
      expect(existsSync(main)).toBe(true);
      const upstreamAlias = readUpstreamComponentToml(UPSTREAM_ROOT, component)
        .alias as Record<string, string>;
      for (const [name, target] of Object.entries(
        config.alias as Record<string, string>,
      )) {
        expect(resolve(PRODUCT_DIR, target)).toBe(
          resolve(componentDir(component), upstreamAlias[name]),
        );
      }
    }

    const web = render(exampleProduct(), "web").config;
    const output = resolve(PRODUCT_DIR, web.pages_build_output_dir as string);
    expect(output).toBe(join(componentDir("web"), "web-dist"));
    // `check` finds the Pages Functions beside the build output.
    expect(
      existsSync(join(dirname(output), "functions", "_middleware.ts")),
    ).toBe(true);
  });

  test("a pushed image replaces the Dockerfile build", () => {
    const image =
      "registry.cloudflare.com/00000000000000000000000000000000/login:1.2.3";
    const { config } = render(
      productWith((c) => Object.assign(c.login.container as Table, { image })),
      "login",
    );
    expect((config.containers as Table[])[0]).toEqual({
      class_name: "LoginContainer",
      image,
      max_instances: 1,
      instance_type: "standard-1",
    });
  });

  test("refuses a component the environment does not define", () => {
    for (const component of COMPONENTS) {
      expect(() =>
        render(
          productWith((c, env) => {
            delete c[component];
            if (component === "admission") delete env.durableObjectTransfers;
          }),
          component,
        ),
      ).toThrow(`has no ${component} component in production`);
    }
  });

  test("refuses a product that reuses an eliza Worker or project name", () => {
    const cases: [
      DeploymentComponentName,
      (c: Record<string, Table>, env: Table) => void,
    ][] = [
      [
        "login",
        (c) => Object.assign(c.login, { workerName: "eliza-login-production" }),
      ],
      [
        "speech",
        (c) =>
          Object.assign(c.speech, { workerName: "eliza-cloud-speech-staging" }),
      ],
      ["web", (c) => Object.assign(c.web, { projectName: "eliza-app" })],
      [
        "admission",
        (c, env) => {
          Object.assign(c.admission, {
            workerName: "eliza-cloud-admission-staging",
          });
          Object.assign(env, {
            durableObjectTransfers: {
              InferenceAdmissionGate: "eliza-cloud-admission-staging",
            },
          });
        },
      ],
      // Reached through a binding rather than the component's own name.
      [
        "web",
        (_c, env) => Object.assign(env, { workerName: "eliza-cloud-api-prod" }),
      ],
      [
        "admission",
        (_c, env) => Object.assign(env, { workerName: "eliza-cloud-api-prod" }),
      ],
      [
        "speech",
        (_c, env) =>
          Object.assign(env, { accountId: "23cf6feaeaa541f6a0675053c33da768" }),
      ],
    ];
    for (const [component, change] of cases) {
      expect(() => render(productWith(change), component)).toThrow(
        `rendered ${component} config for "example-product" carries eliza identity`,
      );
    }
  });

  test("an upstream key or variable the renderer does not know stops the render", () => {
    const copy = mkdtempSync(join(tmpdir(), "cloud-deploy-upstream-"));
    try {
      for (const component of DEPLOYMENT_COMPONENTS) {
        const path = join(UPSTREAM_COMPONENT_DIRS[component], "wrangler.toml");
        mkdirSync(dirname(join(copy, path)), { recursive: true });
        cpSync(join(UPSTREAM_ROOT, path), join(copy, path));
      }
      const edit = (
        component: DeploymentComponentName,
        change: (text: string) => string,
      ) => {
        const file = join(
          copy,
          UPSTREAM_COMPONENT_DIRS[component],
          "wrangler.toml",
        );
        writeFileSync(file, change(readFileSync(file, "utf8")));
      };
      const attempt = (component: DeploymentComponentName) => () =>
        render(exampleProduct(), component, "production", {
          upstreamRoot: copy,
        });
      for (const component of COMPONENTS)
        expect(attempt(component)).not.toThrow();

      edit("speech", (text) => `logpush = true\n${text}`);
      expect(attempt("speech")).toThrow("does not know: logpush");
      edit("admission", (text) =>
        text.replace(
          'service = "eliza-cloud-api-staging"',
          'service = "eliza-billing"',
        ),
      );
      expect(attempt("admission")).toThrow(
        "names a Worker the renderer does not know",
      );
      edit("web", (text) =>
        text.replace("[vars]", '[vars]\nSUPPORT_ORIGIN = "https://eliza.app"'),
      );
      expect(attempt("web")).toThrow("does not derive: SUPPORT_ORIGIN");
      edit("login", (text) =>
        text.replace(
          "[env.production.vars]",
          '[env.production.vars]\nPASSKEY_RP_ID = "eliza.app"',
        ),
      );
      expect(attempt("login")).toThrow("does not derive: PASSKEY_RP_ID");
      expect(attempt("login")).toThrow(RenderError);
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  });
});

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

describe("eliza component parity with upstream's configurations", () => {
  // Rendered beside each upstream file so that paths compare as written.
  const renderEliza = (
    component: DeploymentComponentName,
    environment: DeploymentEnvironmentName,
  ) =>
    render(eliza(), component, environment, {
      outDir: componentDir(component),
    }).config;

  test("login reproduces both environments exactly", () => {
    const upstream = readUpstreamComponentToml(UPSTREAM_ROOT, "login");
    for (const environment of DEPLOYMENT_ENVIRONMENTS) {
      const { env: environments, ...top } = upstream;
      // Wrangler's effective config: the environment over the top level.
      const effective = {
        ...top,
        ...((environments as Table)[environment] as Table),
      };
      expect(differences(renderEliza("login", environment), effective)).toEqual(
        [],
      );
    }
  });

  /**
   * Upstream gives these Workers three of the deployment variables and lets
   * the rest fall back to the eliza defaults compiled into the bundle. The
   * render states all of them, with the values the staging API is given, so
   * the three Workers resolve one deployment. Each differs from the default
   * only where staging itself does (tenant, blob host, API origin).
   */
  const ADDED_VARS = [
    "CLOUD_BILLING_URL",
    "CLOUD_DEPLOYMENT_ID",
    "CLOUD_PUBLIC_SERVICE_NAME",
    "CLOUD_WEB_ORIGIN",
    "ELIZA_CLOUD_URL",
    "ELIZA_ENTITLEMENT_AUDIENCE",
    "ELIZA_ENTITLEMENT_ISSUER",
    "NEXT_PUBLIC_API_URL",
    "NEXT_PUBLIC_ASSETS_CDN_URL",
    "NEXT_PUBLIC_STEWARD_TENANT_ID",
    "R2_PUBLIC_HOST",
    "SENDGRID_FROM_EMAIL",
    "STEWARD_TENANT_ID",
  ];

  for (const component of ["speech", "admission"] as const) {
    test(`${component} (staging) differs only by the added deployment variables`, () => {
      const upstream = readUpstreamComponentToml(UPSTREAM_ROOT, component);
      const rendered = renderEliza(component, "staging");
      expect(differences(rendered, upstream)).toEqual(
        ADDED_VARS.map((name) => `vars.${name}: only rendered`),
      );
      const api = renderEliza("api", "staging").vars as Record<string, string>;
      const stagingApi = (
        (readUpstreamComponentToml(UPSTREAM_ROOT, "api").env as Table)
          .staging as Table
      ).vars as Record<string, string>;
      for (const name of ADDED_VARS) {
        const value = (rendered.vars as Record<string, string>)[name];
        expect(value).toBe(api[name]);
        // Where upstream's staging API sets the variable, it is that value.
        if (name in stagingApi) expect(value).toBe(stagingApi[name]);
      }
    });

    test(`${component} exists upstream for staging only`, () => {
      expect(() => renderEliza(component, "production")).toThrow(
        `has no ${component} component in production`,
      );
    });
  }

  test("web differs only by the added deployment id", () => {
    const upstream = readUpstreamComponentToml(UPSTREAM_ROOT, "web");
    const { env: environments, ...top } = upstream;
    // Pages uses the top level for previews (staging) and replaces `vars`
    // and `services` whole for the production branch.
    const effective: Record<DeploymentEnvironmentName, Table> = {
      staging: top,
      production: { ...top, ...((environments as Table).production as Table) },
    };
    for (const environment of DEPLOYMENT_ENVIRONMENTS) {
      expect(
        differences(renderEliza("web", environment), effective[environment]),
      ).toEqual(["vars.CLOUD_DEPLOYMENT_ID: only rendered"]);
      expect(
        (renderEliza("web", environment).vars as Table).CLOUD_DEPLOYMENT_ID,
      ).toBe("eliza");
    }
  });
});

describe("check", () => {
  test("finds a component's Wrangler in the upstream tree's API package", () => {
    const tree = mkdtempSync(join(tmpdir(), "cloud-deploy-tree-"));
    try {
      const entry = join(tree, "packages", "cloud", "speech-worker", "src");
      const bin = join(
        tree,
        "packages",
        "cloud",
        "api",
        "node_modules",
        ".bin",
      );
      mkdirSync(entry, { recursive: true });
      expect(findWrangler(entry)).toBe(null);
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, "wrangler"), "");
      expect(findWrangler(entry)).toBe(join(bin, "wrangler"));
      // A component's own install wins.
      const own = join(dirname(entry), "node_modules", ".bin");
      mkdirSync(own, { recursive: true });
      writeFileSync(join(own, "wrangler"), "");
      expect(findWrangler(entry)).toBe(join(own, "wrangler"));
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  });
});
