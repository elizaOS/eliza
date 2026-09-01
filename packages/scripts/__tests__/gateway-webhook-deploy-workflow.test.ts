/**
 * Guards the protected gateway-webhook deploy workflow's exact source,
 * Railway identity, canonical routing, secret-name, and live smoke contracts.
 */
import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";

const repoRoot = new URL("../../../", import.meta.url);
const workflowPath = new URL(
  ".github/workflows/deploy-gateway-webhook.yml",
  repoRoot,
);
const source = readFileSync(workflowPath, "utf8");
const railwayManifest = readFileSync(
  new URL("packages/cloud/services/gateway-webhook/railway.toml", repoRoot),
  "utf8",
);
const workflowReadme = readFileSync(
  new URL(".github/workflows/README.md", repoRoot),
  "utf8",
);
const blooioNames = [
  "ELIZA_APP_BLOOIO_API_KEY",
  "ELIZA_APP_BLOOIO_PHONE_NUMBER",
  "ELIZA_APP_BLOOIO_WEBHOOK_SECRET",
] as const;
const blooioValues: Record<(typeof blooioNames)[number], string> = {
  ELIZA_APP_BLOOIO_API_KEY: "railway-api-key-private-canary",
  ELIZA_APP_BLOOIO_PHONE_NUMBER: "+15555550200",
  ELIZA_APP_BLOOIO_WEBHOOK_SECRET: "railway-webhook-private-canary",
};
const telegramValues = {
  ELIZA_APP_TELEGRAM_BOT_ID: "123456789",
  ELIZA_APP_TELEGRAM_BOT_USERNAME: "eliza_fixture_bot",
  ELIZA_APP_TELEGRAM_BOT_TOKEN: "telegram-token-private-canary",
  ELIZA_APP_TELEGRAM_WEBHOOK_SECRET: "telegram-webhook-private-canary",
} as const;
interface WorkflowStep {
  env?: Record<string, string>;
  id?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, string | number | boolean>;
}

interface WorkflowJob {
  concurrency?: {
    "cancel-in-progress"?: boolean;
    group?: string;
    queue?: string;
  };
  env?: Record<string, string>;
  environment?: string;
  needs?: string;
  steps?: WorkflowStep[];
}

interface Workflow {
  jobs?: Record<string, WorkflowJob>;
  on?: {
    workflow_dispatch?: {
      inputs?: {
        environment?: {
          options?: string[];
          required?: boolean;
          type?: string;
        };
      };
    };
  };
  permissions?: Record<string, string>;
}

const workflow = Bun.YAML.parse(source) as Workflow;
const deploy = workflow.jobs?.deploy;
const authorization = workflow.jobs?.["authorize-target"];
const steps = deploy?.steps ?? [];

function step(name: string): WorkflowStep {
  const found = steps.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Missing gateway-webhook workflow step: ${name}`);
  return found;
}

function githubExpression(body: string): string {
  return ["$", "{{ ", body, " }}"].join("");
}

function hasExactWorkflowReadmeRow(
  readme: string,
  environment: "staging" | "production",
  branch: "develop" | "main",
  service: "gateway-webhook-stg" | "gateway-webhook",
): boolean {
  const escaped = [environment, branch, service].map((value) =>
    value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  );
  return new RegExp(
    `^[ \\t]*\\|[ \\t]+${escaped[0]}[ \\t]+\\|[ \\t]+${escaped[1]}[ \\t]+\\|[ \\t]+${escaped[2]}[ \\t]+\\|`,
    "m",
  ).test(readme.replaceAll("`", ""));
}

const expectedJobEnvironment = {
  TARGET_ENVIRONMENT: githubExpression("inputs.environment"),
  DEPLOY_BRANCH: githubExpression(
    "inputs.environment == 'production' && 'main' || 'develop'",
  ),
  EXPECTED_SERVICE_NAME: githubExpression(
    "inputs.environment == 'production' && 'gateway-webhook' || 'gateway-webhook-stg'",
  ),
  EXPECTED_CLOUD_URL: githubExpression(
    "inputs.environment == 'production' && 'https://api.eliza.app' || 'https://api-staging.eliza.app'",
  ),
  EXPECTED_ROUTER_ORIGIN: githubExpression(
    "inputs.environment == 'production' && 'eliza-production-1.eliza.app' || 'eliza-staging-1.eliza.app'",
  ),
  EXPECTED_AGENT_BASE_DOMAIN: githubExpression(
    "inputs.environment == 'production' && 'cloud.eliza.app' || 'cloud-staging.eliza.app'",
  ),
  EXPECTED_GATEWAY_URL: githubExpression(
    "inputs.environment == 'production' && 'https://gateway-webhook-production.up.railway.app' || 'https://gateway-webhook-stg-staging.up.railway.app'",
  ),
  GATEWAY_WEBHOOK_URL: githubExpression("vars.ELIZA_APP_WEBHOOK_GATEWAY_URL"),
  RAILWAY_PROJECT_ID: githubExpression("vars.RAILWAY_PROJECT_ID"),
  RAILWAY_ENVIRONMENT_ID: githubExpression("vars.RAILWAY_ENVIRONMENT_ID"),
  RAILWAY_SERVICE_ID: githubExpression(
    "vars.RAILWAY_SERVICE_ID_GATEWAY_WEBHOOK",
  ),
  RAILWAY_TOKEN: githubExpression("secrets.RAILWAY_TOKEN"),
};

function assertExactProtectedRouting(job: WorkflowJob | undefined): void {
  if (job?.environment !== githubExpression("inputs.environment")) {
    throw new Error("protected environment expression drifted");
  }
  for (const [name, expected] of Object.entries(expectedJobEnvironment)) {
    if (job.env?.[name] !== expected) {
      throw new Error(`${name} mapping drifted`);
    }
  }
}

function railwayUpPathArgument(run: string): string | undefined {
  const normalized = run.replace(/\\\n/g, " ");
  const invocation = normalized.match(/(?:^|\n)\s*railway up(?:\s+(\S+))?/);
  if (!invocation) throw new Error("Missing Railway up invocation");
  const firstArgument = invocation[1];
  return firstArgument && !firstArgument.startsWith("-")
    ? firstArgument
    : undefined;
}

function verifyRailwayVariableInventory(
  target: "staging" | "production",
  overrides: Record<string, string | undefined> = {},
  workerOverrides: Record<string, string | undefined> = {},
): ReturnType<typeof Bun.spawnSync> {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "gateway-webhook-vars-"));
  const binRoot = join(fixtureRoot, "bin");
  mkdirSync(binRoot, { recursive: true });
  const canonical =
    target === "staging"
      ? {
          ELIZA_CLOUD_URL: "https://api-staging.eliza.app",
          AGENT_ROUTER_ORIGIN_HOST: "eliza-staging-1.eliza.app",
          ELIZA_CLOUD_AGENT_BASE_DOMAIN: "cloud-staging.eliza.app",
        }
      : {
          ELIZA_CLOUD_URL: "https://api.eliza.app",
          AGENT_ROUTER_ORIGIN_HOST: "eliza-production-1.eliza.app",
          ELIZA_CLOUD_AGENT_BASE_DOMAIN: "cloud.eliza.app",
        };
  const variables: Record<string, string | undefined> = {
    ...canonical,
    GATEWAY_BOOTSTRAP_SECRET: "bootstrap-private-canary",
    GATEWAY_INTERNAL_SECRET: "internal-private-canary",
    AGENT_SERVER_SHARED_SECRET: "server-private-canary",
    ELIZA_APP_WEBHOOK_GATEWAY_SECRET: "forwarder-private-canary",
    REDIS_URL: "redis-private-canary",
    ...blooioValues,
    ...telegramValues,
    ...overrides,
  };
  // The Worker side receives these as GitHub Environment secrets; by default
  // they agree with Railway, so only an explicit override models divergence.
  const workerEnvironment: Record<string, string> = {};
  for (const name of blooioNames) {
    const value =
      name in workerOverrides ? workerOverrides[name] : blooioValues[name];
    if (value !== undefined) workerEnvironment[`WORKER_${name}`] = value;
  }
  for (const name of [
    "ELIZA_APP_TELEGRAM_BOT_TOKEN",
    "ELIZA_APP_TELEGRAM_WEBHOOK_SECRET",
  ] as const) {
    workerEnvironment[`WORKER_${name}`] = telegramValues[name];
  }
  writeFileSync(
    join(binRoot, "railway"),
    `#!/bin/sh
set -eu
if [ "$1" = "variable" ] && [ "$2" = "list" ]; then
  printf '%s' "$RAILWAY_VARIABLES_FIXTURE"
  exit 0
fi
exit 97
`,
  );
  writeFileSync(
    join(binRoot, "shred"),
    `#!/bin/sh
set -eu
if [ "$1" = "-u" ]; then
  rm -f "$2"
  exit 0
fi
exit 98
`,
  );
  writeFileSync(join(binRoot, "node"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(binRoot, "railway"), 0o755);
  chmodSync(join(binRoot, "shred"), 0o755);
  chmodSync(join(binRoot, "node"), 0o755);

  try {
    const verification = step(
      "Verify canonical Railway variables and sensitive names",
    );
    return Bun.spawnSync(["bash", "-c", verification.run ?? ""], {
      env: {
        ...process.env,
        EXPECTED_AGENT_BASE_DOMAIN: canonical.ELIZA_CLOUD_AGENT_BASE_DOMAIN,
        EXPECTED_CLOUD_URL: canonical.ELIZA_CLOUD_URL,
        EXPECTED_ROUTER_ORIGIN: canonical.AGENT_ROUTER_ORIGIN_HOST,
        PATH: `${binRoot}:${process.env.PATH ?? ""}`,
        RAILWAY_ENVIRONMENT_ID: "22222222-2222-4222-8222-222222222222",
        RAILWAY_PROJECT_ID: "11111111-1111-4111-8111-111111111111",
        RAILWAY_SERVICE_ID: "33333333-3333-4333-8333-333333333333",
        RAILWAY_VARIABLES_FIXTURE: JSON.stringify(variables),
        RUNNER_TEMP: fixtureRoot,
        TARGET_ENVIRONMENT: target,
        TELEGRAM_EXPECTED_BOT_ID: telegramValues.ELIZA_APP_TELEGRAM_BOT_ID,
        TELEGRAM_EXPECTED_BOT_USERNAME:
          telegramValues.ELIZA_APP_TELEGRAM_BOT_USERNAME,
        ...workerEnvironment,
      },
      stderr: "pipe",
      stdout: "pipe",
    });
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

/**
 * Reproduces Railway CLI v5.38.0's pre-upload path contract from
 * `commands/up.rs::get_deploy_paths` and
 * `controllers/upload.rs::create_deploy_tarball`.
 */
function pinnedRailwayV538ArchiveMembers(
  cwd: string,
  pathArgument: string | undefined,
  relativeMembers: string[],
): string[] {
  const projectPath = pathArgument ?? cwd;
  const archivePrefixPath = cwd;
  return relativeMembers.map((member) => {
    const walkedPath = join(projectPath, member);
    if (isAbsolute(walkedPath) !== isAbsolute(archivePrefixPath)) {
      throw new Error("prefix not found");
    }
    const stripped = relative(archivePrefixPath, walkedPath);
    if (
      stripped === ".." ||
      stripped.startsWith(`..${sep}`) ||
      isAbsolute(stripped)
    ) {
      throw new Error("prefix not found");
    }
    return stripped;
  });
}

function assertExactForwarderAuthReadinessProbe(run: string): void {
  const required = {
    route: '"$GATEWAY_WEBHOOK_URL/ready/forwarder-auth/eliza-app"',
    status: '"$forwarder_probe_status" != "401"',
    keys: 'keys == ["error", "project", "status"]',
    error: '.error == "unauthorized"',
    readiness: '.status == "enforced"',
    project: '.project == "eliza-app"',
  } as const;
  const routeStart = run.indexOf(required.route);
  const routeEnd = run.indexOf("telegram_probe_path=", routeStart);
  if (routeStart < 0 || routeEnd < 0) {
    throw new Error("forwarder readiness route contract drifted");
  }
  const forwarderProbe = run.slice(routeStart, routeEnd);
  for (const [contract, fragment] of Object.entries(required)) {
    if (!forwarderProbe.includes(fragment)) {
      throw new Error(`forwarder readiness ${contract} contract drifted`);
    }
  }
  for (const forbidden of [
    "X-Eliza-Webhook-Forwarder-Secret",
    "--request POST",
    "--data '{}'",
    "/webhook/eliza-app/telegram",
  ]) {
    if (run.includes(forbidden)) {
      throw new Error("forwarder readiness probe entered a forbidden path");
    }
  }
  if (
    run.indexOf("assert_active_deployment after") < run.indexOf(required.route)
  ) {
    throw new Error("forwarder readiness active-deployment recheck drifted");
  }
}

describe("protected gateway-webhook deployment workflow", () => {
  test("authorizes before the shared protected mutation lock", () => {
    expect(Object.keys(workflow.on ?? {})).toEqual(["workflow_dispatch"]);
    expect(workflow.on?.workflow_dispatch?.inputs?.environment).toEqual({
      description: "Protected environment to deploy",
      required: true,
      type: "choice",
      options: ["staging", "production"],
    });
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(authorization?.environment).toBe(
      githubExpression("inputs.environment"),
    );
    expect(authorization?.concurrency).toBeUndefined();
    expect(deploy?.environment).toBe(githubExpression("inputs.environment"));
    expect(deploy?.needs).toBe("authorize-target");
    expect(deploy?.concurrency?.group).toBe(
      ["cloud-cf-release-v6-", githubExpression("inputs.environment")].join(""),
    );
    expect(deploy?.concurrency?.["cancel-in-progress"]).toBe(false);
    expect(deploy?.concurrency?.queue).toBe("max");

    expect(deploy?.env).toEqual(expectedJobEnvironment);
    expect(() => assertExactProtectedRouting(deploy)).not.toThrow();

    expect(() =>
      assertExactProtectedRouting({
        ...deploy,
        environment: `unsafe-${deploy?.environment}`,
      }),
    ).toThrow("protected environment expression drifted");

    const reversedMappings = {
      EXPECTED_CLOUD_URL: githubExpression(
        "inputs.environment == 'production' && 'https://api-staging.eliza.app' || 'https://api.eliza.app'",
      ),
      EXPECTED_ROUTER_ORIGIN: githubExpression(
        "inputs.environment == 'production' && 'eliza-staging-1.eliza.app' || 'eliza-production-1.eliza.app'",
      ),
      EXPECTED_AGENT_BASE_DOMAIN: githubExpression(
        "inputs.environment == 'production' && 'cloud-staging.eliza.app' || 'cloud.eliza.app'",
      ),
      EXPECTED_GATEWAY_URL: githubExpression(
        "inputs.environment == 'production' && 'https://gateway-webhook-stg-staging.up.railway.app' || 'https://gateway-webhook-production.up.railway.app'",
      ),
    };
    for (const [name, reversed] of Object.entries(reversedMappings)) {
      expect(() =>
        assertExactProtectedRouting({
          ...deploy,
          env: { ...deploy?.env, [name]: reversed },
        }),
      ).toThrow(`${name} mapping drifted`);
    }
    expect(
      hasExactWorkflowReadmeRow(
        workflowReadme,
        "staging",
        "develop",
        "gateway-webhook-stg",
      ),
    ).toBe(true);
    expect(
      hasExactWorkflowReadmeRow(
        workflowReadme,
        "production",
        "main",
        "gateway-webhook",
      ),
    ).toBe(true);
    expect(
      hasExactWorkflowReadmeRow(
        "| staging\n| develop\n| gateway-webhook-stg\n|",
        "staging",
        "develop",
        "gateway-webhook-stg",
      ),
    ).toBe(false);

    const checkout = steps.find((candidate) =>
      candidate.uses?.startsWith("actions/checkout@"),
    );
    expect(checkout?.uses).toBe(
      "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
    );
    expect(checkout?.with?.ref).toContain("github.sha");
    expect(checkout?.with?.["persist-credentials"]).toBe(false);
  });

  test("fails closed on branch, exact SHA, canonical URLs, and protected ids", () => {
    const preflight = step("Validate protected canonical configuration");
    for (const name of [
      "TARGET_ENVIRONMENT",
      "DEPLOY_BRANCH",
      "EXPECTED_CLOUD_URL",
      "EXPECTED_ROUTER_ORIGIN",
      "EXPECTED_AGENT_BASE_DOMAIN",
      "EXPECTED_GATEWAY_URL",
      "GATEWAY_WEBHOOK_URL",
      "RAILWAY_PROJECT_ID",
      "RAILWAY_ENVIRONMENT_ID",
      "RAILWAY_SERVICE_ID",
      "RAILWAY_TOKEN",
    ]) {
      expect(preflight.run).toContain(`\n  ${name}\n`);
    }
    expect(preflight.run).toContain('"refs/heads/$DEPLOY_BRANCH"');
    expect(preflight.run).toContain('"$(git rev-parse HEAD)" "$GITHUB_SHA"');
    expect(preflight.run).toContain(
      "git status --porcelain --untracked-files=all",
    );
    expect(preflight.run).toContain("Unsupported protected environment");
    expect(preflight.run).not.toContain('echo "$actual"');

    for (const canonical of [
      "https://api.eliza.app",
      "https://api-staging.eliza.app",
      "eliza-production-1.eliza.app",
      "eliza-staging-1.eliza.app",
      "cloud.eliza.app",
      "cloud-staging.eliza.app",
      "https://gateway-webhook-production.up.railway.app",
      "https://gateway-webhook-stg-staging.up.railway.app",
    ]) {
      expect(source).toContain(canonical);
    }
  });

  test("pins Railway and resolves the exact project, environment, service, and domain", () => {
    const install = step("Install pinned Railway CLI");
    expect(install.run).toContain("v5.38.0");
    expect(install.run).toContain(
      "72835c48a710c48c4542141bf12264823cf3a029b514f9e27994096c036c539e",
    );
    expect(install.run).toContain("sha256sum --check --status");

    const target = step("Verify exact Railway target and public domain");
    expect(target.run).toContain("railway status");
    expect(target.run).toContain('--project "$RAILWAY_PROJECT_ID"');
    expect(target.run).toContain('--environment "$RAILWAY_ENVIRONMENT_ID"');
    expect(target.run).toContain(".node.id == $id and .node.name == $name");
    expect(target.run).toContain("railway domain list");
    expect(target.run).toContain('--service "$RAILWAY_SERVICE_ID"');
    expect(target.run).toContain(".domain == $domain");
  });

  test("checks sensitive variable names through private files without publishing values", () => {
    const variables = step(
      "Verify canonical Railway variables and sensitive names",
    );
    expect(variables.run).toContain("umask 077");
    expect(variables.run).toContain("railway variable list");
    expect(variables.run).toContain("nonblank_sensitive_names");
    expect(variables.run).toContain('shred -u "$variables_raw_path"');
    expect(variables.run).toContain("GATEWAY_BOOTSTRAP_SECRET");
    expect(variables.run).toContain("GATEWAY_INTERNAL_SECRET");
    expect(variables.run).toContain("AGENT_SERVER_SHARED_SECRET");
    expect(variables.run).toContain("ELIZA_APP_WEBHOOK_GATEWAY_SECRET");
    expect(variables.run).toContain("REDIS_URL");
    expect(variables.run).toContain("KV_REST_API_URL");
    expect(variables.run).toContain("KV_REST_API_TOKEN");
    expect(variables.run).toContain("AGENT_ROUTER_ORIGIN_HOST");
    expect(variables.run).toContain("ELIZA_CLOUD_AGENT_BASE_DOMAIN");
    expect(variables.run).toContain("blooio_nonblank_names");
    for (const name of blooioNames) {
      expect(variables.run).toContain(name);
    }
    expect(source).not.toContain("railway variable set");
    expect(source).not.toContain('cat "$variables_path"');
    expect(source).not.toContain('echo "$RAILWAY_TOKEN"');
  });

  test("requires the complete protected-environment Blooio set", () => {
    for (const target of ["staging", "production"] as const) {
      const complete = verifyRailwayVariableInventory(target);
      expect(complete.exitCode).toBe(0);
      expect(complete.stdout.toString()).toContain(
        "required sensitive variable names are present",
      );
      const completeOutput = `${complete.stdout.toString()}${complete.stderr.toString()}`;
      for (const value of Object.values(blooioValues)) {
        expect(completeOutput).not.toContain(value);
      }

      for (const name of blooioNames) {
        for (const missingValue of [undefined, "", " \t "]) {
          const missing = verifyRailwayVariableInventory(target, {
            [name]: missingValue,
          });
          expect(missing.exitCode).toBe(1);
          const output = `${missing.stdout.toString()}${missing.stderr.toString()}`;
          expect(output).toContain(
            `Required protected ${target} Blooio Railway variable name is absent or blank: ${name}`,
          );
          for (const value of Object.values(blooioValues)) {
            expect(output).not.toContain(value);
          }
        }
      }
    }
  }, 30_000);

  test("requires protected Worker and Railway Blooio values to actually match", () => {
    const variables = step(
      "Verify canonical Railway variables and sensitive names",
    );
    for (const name of blooioNames) {
      expect(variables.env?.[`WORKER_${name}`]).toBe(
        githubExpression(`secrets.${name}`),
      );
    }
    // Equality is proven by digest; the values themselves must never be
    // compared, echoed, or written in the clear.
    expect(variables.run).toContain("openssl rand -hex 32");
    expect(variables.run).toContain(
      'openssl dgst -sha256 -hmac "$protected_match_salt" -r',
    );
    expect(variables.run).not.toContain('"$worker_value" != "$railway_value"');
    expect(variables.run).not.toContain('echo "$worker_value"');

    const workerValues = {
      ELIZA_APP_BLOOIO_API_KEY: "worker-api-key-private-canary",
      ELIZA_APP_BLOOIO_PHONE_NUMBER: "+15555550999",
      ELIZA_APP_BLOOIO_WEBHOOK_SECRET: "worker-webhook-private-canary",
    } as const;
    const allSecretValues = [
      ...Object.values(blooioValues),
      ...Object.values(workerValues),
    ];

    for (const target of ["staging", "production"] as const) {
      const matched = verifyRailwayVariableInventory(target);
      expect(matched.exitCode).toBe(0);
      expect(matched.stdout.toString()).toContain(
        `protected ${target} Blooio Worker/Railway value matches by salted digest`,
      );

      for (const name of blooioNames) {
        // A divergent-but-nonblank Worker secret is precisely the case a
        // names-only inventory accepts and a live webhook then rejects with 401.
        const divergent = verifyRailwayVariableInventory(
          target,
          {},
          { [name]: workerValues[name] },
        );
        expect(divergent.exitCode).toBe(1);
        const divergentOutput = `${divergent.stdout.toString()}${divergent.stderr.toString()}`;
        expect(divergentOutput).toContain(
          `Protected ${target} Blooio value differs between the Cloudflare Worker GitHub environment secret and the Railway variable: ${name}`,
        );
        for (const value of allSecretValues) {
          expect(divergentOutput).not.toContain(value);
        }

        for (const absentWorkerValue of [undefined, "", " \t "]) {
          const absent = verifyRailwayVariableInventory(
            target,
            {},
            { [name]: absentWorkerValue },
          );
          expect(absent.exitCode).toBe(1);
          const absentOutput = `${absent.stdout.toString()}${absent.stderr.toString()}`;
          expect(absentOutput).toContain(
            `Required protected ${target} Blooio GitHub environment secret is absent or blank: ${name}`,
          );
          for (const value of allSecretValues) {
            expect(absentOutput).not.toContain(value);
          }
        }
      }
    }
  }, 30_000);

  test("binds the exact root source and manifest to its new deployment id", () => {
    const exactSource = step("Deploy exact gateway-webhook source");
    expect(exactSource.run).toContain(
      '"$(git rev-parse HEAD)" != "$GITHUB_SHA"',
    );
    expect(exactSource.run).toContain(
      "git status --porcelain --untracked-files=all",
    );
    expect(railwayUpPathArgument(exactSource.run ?? "")).toBeUndefined();
    expect(exactSource.run).toContain(
      "cp packages/cloud/services/gateway-webhook/railway.toml railway.toml",
    );
    expect(railwayManifest).toContain("healthcheckTimeout = 90");
    expect(railwayManifest).not.toContain("healthcheckTimeout = 30");
    expect(exactSource.run).toContain("cmp --silent");
    expect(exactSource.run).toContain('!= "?? railway.toml"');
    expect(exactSource.run).toContain('--project "$RAILWAY_PROJECT_ID"');
    expect(exactSource.run).toContain(
      '--environment "$RAILWAY_ENVIRONMENT_ID"',
    );
    expect(exactSource.run).toContain('--service "$RAILWAY_SERVICE_ID"');
    expect(exactSource.run).toContain("--detach");
    expect(exactSource.run).toContain("--yes");
    expect(exactSource.run).toContain(
      '--message "gateway-webhook $GITHUB_SHA ($TARGET_ENVIRONMENT)"',
    );
    expect(exactSource.run).toContain(
      "gateway-webhook-deployment-baseline.json",
    );
    expect(exactSource.run).toContain("deployment_id=$deployment_id");

    const fixtureRoot = mkdtempSync(
      join(tmpdir(), "gateway-webhook-railway-v538-"),
    );
    try {
      const dockerfilePath =
        "packages/cloud/services/gateway-webhook/Dockerfile";
      mkdirSync(join(fixtureRoot, "packages/cloud/services/gateway-webhook"), {
        recursive: true,
      });
      writeFileSync(join(fixtureRoot, "railway.toml"), "[build]\n");
      writeFileSync(join(fixtureRoot, dockerfilePath), "FROM scratch\n");

      expect(() =>
        pinnedRailwayV538ArchiveMembers(fixtureRoot, ".", [
          "railway.toml",
          dockerfilePath,
        ]),
      ).toThrow("prefix not found");

      const archiveMembers = pinnedRailwayV538ArchiveMembers(
        fixtureRoot,
        railwayUpPathArgument(exactSource.run ?? ""),
        ["railway.toml", dockerfilePath],
      );
      expect(archiveMembers).toEqual(["railway.toml", dockerfilePath]);

      const archivePath = join(fixtureRoot, "gateway-webhook-source.tar.gz");
      const createArchive = Bun.spawnSync([
        "tar",
        "-czf",
        archivePath,
        "-C",
        fixtureRoot,
        ...archiveMembers,
      ]);
      expect(createArchive.exitCode).toBe(0);
      const listArchive = Bun.spawnSync(["tar", "-tzf", archivePath]);
      expect(listArchive.exitCode).toBe(0);
      const listed = listArchive.stdout.toString().trim().split("\n");
      expect(listed).toContain("railway.toml");
      expect(listed).toContain(dockerfilePath);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }

    const wait = step("Wait for the exact Railway deployment");
    expect(wait.env?.DEPLOYMENT_ID).toContain(
      "steps.railway_deploy.outputs.deployment_id",
    );
    expect(wait.run).toContain("railway deployment list");
    expect(wait.run).toContain(".id == $id");
    expect(wait.run).toContain("SUCCESS");
    expect(wait.run).toContain("FAILED | CRASHED | REMOVED");
    expect(wait.run).toContain("CANCELED | CANCELLED");
  });

  test("proves live health and the startup-required canonical fallback pair", () => {
    const verify = step(
      "Verify deployed health and canonical fallback configuration",
    );
    expect(verify.env?.DEPLOYMENT_ID).toContain(
      "steps.railway_deploy.outputs.deployment_id",
    );
    expect(verify.run).toContain('.meta.configFile == "/railway.toml"');
    expect(verify.run).toContain(".meta.fileServiceManifest.build.builder");
    expect(verify.run).toContain(".meta.serviceManifest.build.builder");
    expect(verify.run).toContain(
      "packages/cloud/services/gateway-webhook/Dockerfile",
    );
    expect(verify.run).toContain(
      ".meta.fileServiceManifest.deploy.healthcheckPath",
    );
    expect(verify.run).toContain(
      ".meta.fileServiceManifest.deploy.healthcheckTimeout == 90",
    );
    expect(verify.run).toContain(
      ".meta.serviceManifest.deploy.healthcheckTimeout == 90",
    );
    expect(verify.run).not.toContain(
      ".meta.fileServiceManifest.deploy.healthcheckTimeout == 30",
    );
    expect(verify.run).not.toContain(
      ".meta.serviceManifest.deploy.healthcheckTimeout == 30",
    );
    expect(verify.run).toContain("railway service status");
    expect(
      verify.run?.match(/^assert_active_deployment (before|after)$/gm)?.length,
    ).toBe(2);
    expect(verify.run).toContain(".deploymentId == $id");
    expect(verify.run).toContain('"$GATEWAY_WEBHOOK_URL/health"');
    expect(verify.run).toContain('.status == "healthy"');
    expect(verify.run).toContain("railway variable list");
    expect(verify.run).toContain(".AGENT_ROUTER_ORIGIN_HOST == $router");
    expect(verify.run).toContain(".ELIZA_CLOUD_AGENT_BASE_DOMAIN == $domain");
    const verifyRun = verify.run ?? "";
    expect(() =>
      assertExactForwarderAuthReadinessProbe(verifyRun),
    ).not.toThrow();
    const readinessMutations = [
      [
        "/ready/forwarder-auth/eliza-app",
        "/webhook/eliza-app/telegram",
        "forwarder readiness route contract drifted",
      ],
      [
        '"$forwarder_probe_status" != "401"',
        '"$forwarder_probe_status" != "200"',
        "forwarder readiness status contract drifted",
      ],
      [
        '.status == "enforced"',
        '.status == "ready"',
        "forwarder readiness readiness contract drifted",
      ],
      [
        '.project == "eliza-app"',
        '.project == "another-project"',
        "forwarder readiness project contract drifted",
      ],
    ] as const;
    for (const [from, to, error] of readinessMutations) {
      const mutated = verifyRun.replace(from, to);
      expect(mutated).not.toBe(verifyRun);
      expect(() => assertExactForwarderAuthReadinessProbe(mutated)).toThrow(
        error,
      );
    }
    expect(() =>
      assertExactForwarderAuthReadinessProbe(
        verifyRun.replace(
          "--max-time 15",
          "--max-time 15 --header X-Eliza-Webhook-Forwarder-Secret:guess",
        ),
      ),
    ).toThrow("forwarder readiness probe entered a forbidden path");

    const receipt = step("Write exact deployment receipt");
    expect(receipt.env?.DEPLOYMENT_ID).toContain(
      "steps.railway_deploy.outputs.deployment_id",
    );
    expect(receipt.run).toContain('--arg sourceSha "$GITHUB_SHA"');
    expect(receipt.run).toContain('--arg environment "$TARGET_ENVIRONMENT"');
    expect(receipt.run).toContain('--arg deploymentId "$DEPLOYMENT_ID"');
    expect(receipt.run).toContain('--arg service "$EXPECTED_SERVICE_NAME"');
    expect(receipt.run).toContain("gateway-webhook-deployment.json");

    const publish = steps.find(
      (candidate) => candidate.name === "Publish exact deployment receipt",
    );
    expect(publish?.uses).toBe(
      "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
    );
    expect(publish?.with).toEqual({
      name: "gateway-webhook-deployment-${{ inputs.environment }}-${{ github.sha }}",
      path: "${{ runner.temp }}/gateway-webhook-deployment-receipt/gateway-webhook-deployment.json",
      "if-no-files-found": "error",
      "retention-days": 30,
    });

    const summary = step("Write deployment summary");
    expect(summary.run).toContain("$GITHUB_SHA");
    expect(summary.run).toContain("$DEPLOYMENT_ID");
    expect(summary.run).toContain("Canonical fallback pair: verified");

    const cleanup = step("Remove temporary deployment files");
    expect(cleanup.run).toContain("shred -u");
    expect(cleanup.run).toContain("shred -u railway.toml");
    expect(cleanup.run).toContain("gateway-webhook-active-deployment.json");
    expect(cleanup.run).toContain(
      "gateway-webhook-forwarder-auth-readiness.json",
    );
    expect(cleanup.run).toContain("gateway-webhook-railway-variables-raw.json");
    expect(cleanup.run).toContain(
      "gateway-webhook-postdeploy-variables-raw.json",
    );
    expect(cleanup.run).toContain(
      "gateway-webhook-deployment-receipt/gateway-webhook-deployment.json",
    );
  });
});
