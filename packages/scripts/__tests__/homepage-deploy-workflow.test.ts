/**
 * Guards the consolidated homepage deployment authority and the fail-closed
 * public messaging identity preflight that must succeed before release
 * mutations can begin.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
const workflowsDirectory = path.join(repositoryRoot, ".github/workflows");
const workflowPath = path.join(workflowsDirectory, "cloud-cf-deploy.yml");
const releaseWorkflowPath = path.join(
  workflowsDirectory,
  "cloud-cf-release.yml",
);
const qualityWorkflowPath = path.join(workflowsDirectory, "quality.yml");
const contactPath = path.join(
  repositoryRoot,
  "packages/homepage/src/lib/contact.ts",
);

interface WorkflowStep {
  env?: Record<string, string>;
  id?: string;
  if?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, string>;
  "working-directory"?: string;
}

interface WorkflowJob {
  environment?: string;
  if?: string;
  needs?: string | string[];
  outputs?: Record<string, string>;
  secrets?: "inherit" | Record<string, string>;
  steps?: WorkflowStep[];
  uses?: string;
  with?: Record<string, string | boolean>;
}

interface WorkflowCallInput {
  required?: boolean;
  type?: string;
}

interface WorkflowFile {
  jobs?: Record<string, WorkflowJob>;
  on?: {
    workflow_call?: {
      inputs?: Record<string, WorkflowCallInput>;
      secrets?: Record<string, { required?: boolean }>;
    };
    [event: string]: unknown;
  };
}

interface TelegramExecution {
  exitCode: number;
  githubOutput: string;
  stderr: string;
  stdout: string;
  summary: string;
}

const workflow = readFileSync(workflowPath, "utf8");
const releaseWorkflow = readFileSync(releaseWorkflowPath, "utf8");
const qualityWorkflow = readFileSync(qualityWorkflowPath, "utf8");
const contactSource = readFileSync(contactPath, "utf8");
const parsedWorkflow = Bun.YAML.parse(workflow) as WorkflowFile;
const parsedReleaseWorkflow = Bun.YAML.parse(releaseWorkflow) as WorkflowFile;
const telegramAuthorityGuardName =
  "Reject stale Telegram configuration authority";
const guardedReleaseJobNames = [
  "migrate-db",
  "deploy-api",
  "build-pages",
  "deploy-app",
] as const;

const telegramAuthorityResolver =
  parsedWorkflow.jobs?.["resolve-telegram-environment-authority"];
const resolver =
  parsedReleaseWorkflow.jobs?.["resolve-pages-environment-config"];
const telegramValidation = telegramAuthorityResolver?.steps?.find(
  (candidate) =>
    candidate.name === "Validate protected Telegram public identity",
);
const admittedTelegramValidation = resolver?.steps?.find(
  (candidate) =>
    candidate.name === "Validate caller-admitted Telegram public identity",
);

function requiredTelegramConstant(
  name: "ELIZA_TELEGRAM_BOT_ID" | "ELIZA_TELEGRAM_BOT_USERNAME",
): string {
  const match = contactSource.match(
    new RegExp(`^export const ${name} = "([^"]+)";$`, "m"),
  );
  if (!match?.[1])
    throw new Error(`Missing homepage Telegram constant: ${name}`);
  return match[1];
}

const canonicalTelegram = {
  botId: requiredTelegramConstant("ELIZA_TELEGRAM_BOT_ID"),
  botUsername: requiredTelegramConstant("ELIZA_TELEGRAM_BOT_USERNAME"),
};
const stagingTelegram = {
  botId: "1234567890123",
  botUsername: "ElizaStage29206Bot",
};

function telegramIdentityAuthoritySha256(
  botId: string,
  botUsername: string,
): string {
  const framed = [
    "elizaOS/eliza",
    "staging",
    "telegram-public-identity",
    "v1",
    botId,
    botUsername.toLowerCase(),
  ].join("\0");
  return createHash("sha256").update(`${framed}\n`).digest("hex");
}

function readOptionalFile(filePath: string): string {
  return existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
}

function runTelegramPreflight(
  overrides: Partial<{
    botId: string;
    botUsername: string;
    authorityRunAttempt: string;
    authoritySha256: string;
    releaseRunAttempt: string;
    targetEnvironment: string;
  }> = {},
): TelegramExecution {
  // This executes the checked-in shell contract locally. Environment-secret
  // provenance is enforced separately by the structural caller-allowlist test;
  // a local GITHUB_OUTPUT file cannot model hosted runner scope or filtering.
  if (!telegramValidation?.run) {
    throw new Error("Missing executable Telegram public identity preflight");
  }

  const fixtureRoot = mkdtempSync(
    path.join(tmpdir(), "homepage-telegram-preflight-"),
  );
  const githubOutputPath = path.join(fixtureRoot, "github-output.txt");
  const summaryPath = path.join(fixtureRoot, "step-summary.md");

  try {
    const botId = overrides.botId ?? stagingTelegram.botId;
    const botUsername = overrides.botUsername ?? stagingTelegram.botUsername;
    const result = Bun.spawnSync(["bash", "-c", telegramValidation.run], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        GITHUB_OUTPUT: githubOutputPath,
        GITHUB_STEP_SUMMARY: summaryPath,
        RELEASE_RUN_ATTEMPT: overrides.releaseRunAttempt ?? "1",
        TARGET_ENVIRONMENT: overrides.targetEnvironment ?? "staging",
        TELEGRAM_AUTHORITY_RUN_ATTEMPT: overrides.authorityRunAttempt ?? "1",
        ENVIRONMENT_TELEGRAM_BOT_ID: botId,
        ENVIRONMENT_TELEGRAM_BOT_USERNAME: botUsername,
        TELEGRAM_IDENTITY_AUTHORITY_SHA256:
          overrides.authoritySha256 ??
          telegramIdentityAuthoritySha256(botId, botUsername),
      },
      stderr: "pipe",
      stdout: "pipe",
    });

    return {
      exitCode: result.exitCode,
      githubOutput: readOptionalFile(githubOutputPath),
      stderr: result.stderr.toString(),
      stdout: result.stdout.toString(),
      summary: readOptionalFile(summaryPath),
    };
  } finally {
    rmSync(fixtureRoot, { force: true, recursive: true });
  }
}

function runReusableTelegramPreflight(
  overrides: Partial<{
    botId: string;
    botUsername: string;
    authorityRunAttempt: string;
    releaseRunAttempt: string;
    runtimeAuthority: string;
    targetEnvironment: string;
  }> = {},
): TelegramExecution {
  if (!admittedTelegramValidation?.run) {
    throw new Error("Missing executable caller-admitted Telegram preflight");
  }

  const fixtureRoot = mkdtempSync(
    path.join(tmpdir(), "homepage-telegram-reusable-preflight-"),
  );
  const githubOutputPath = path.join(fixtureRoot, "github-output.txt");
  const summaryPath = path.join(fixtureRoot, "step-summary.md");

  try {
    const targetEnvironment = overrides.targetEnvironment ?? "staging";
    const result = Bun.spawnSync(
      ["bash", "-c", admittedTelegramValidation.run],
      {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          GITHUB_OUTPUT: githubOutputPath,
          GITHUB_STEP_SUMMARY: summaryPath,
          ADMITTED_TELEGRAM_BOT_ID: overrides.botId ?? stagingTelegram.botId,
          ADMITTED_TELEGRAM_BOT_USERNAME:
            overrides.botUsername ?? stagingTelegram.botUsername,
          RELEASE_RUN_ATTEMPT: overrides.releaseRunAttempt ?? "1",
          TARGET_ENVIRONMENT: targetEnvironment,
          TELEGRAM_AUTHORITY_RUN_ATTEMPT: overrides.authorityRunAttempt ?? "1",
          TELEGRAM_RUNTIME_AUTHORITY:
            overrides.runtimeAuthority ??
            (targetEnvironment === "production"
              ? "production-live-attested"
              : "staging-protected-receipt-and-existing-bindings"),
        },
        stderr: "pipe",
        stdout: "pipe",
      },
    );

    return {
      exitCode: result.exitCode,
      githubOutput: readOptionalFile(githubOutputPath),
      stderr: result.stderr.toString(),
      stdout: result.stdout.toString(),
      summary: readOptionalFile(summaryPath),
    };
  } finally {
    rmSync(fixtureRoot, { force: true, recursive: true });
  }
}

function runTelegramAuthorityCanaryAdmission(
  overrides: Partial<{
    force: string;
    renderer: string;
    targetEnvironment: string;
  }> = {},
): TelegramExecution {
  const guard = namedStep(
    parsedWorkflow.jobs?.["validate-deploy-source"],
    "Reject feature refs targeting canonical environments",
  );
  if (!guard.run) throw new Error("Missing executable canary admission guard");

  const result = Bun.spawnSync(["bash", "-c", guard.run], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      CERTIFIED_PRODUCTION_BASE_SHA: "",
      CERTIFIED_RECOVERY_POLICY_SHA: "",
      EFFECT_DIGEST: "",
      EVENT_NAME: "workflow_dispatch",
      FORCE: overrides.force ?? "false",
      GITHUB_SHA: "0123456789012345678901234567890123456789",
      PRODUCTION_BINDING_ONLY_RECOVERY: "false",
      RUN_DEPLOYED_RENDERER_STAGING: overrides.renderer ?? "false",
      SOURCE_REF: "refs/heads/feature/telegram-canary",
      SOURCE_SHA: "",
      TARGET_ENVIRONMENT: overrides.targetEnvironment ?? "staging",
      TELEGRAM_AUTHORITY_CANARY: "true",
    },
    stderr: "pipe",
    stdout: "pipe",
  });

  return {
    exitCode: result.exitCode,
    githubOutput: "",
    stderr: result.stderr.toString(),
    stdout: result.stdout.toString(),
    summary: "",
  };
}

function assertNoPublicSurfaceLeak(
  execution: TelegramExecution,
  values: string[],
): void {
  const publicSurfaces = `${execution.stdout}\n${execution.stderr}\n${execution.summary}`;
  for (const value of values.filter((candidate) => candidate.length >= 4)) {
    expect(publicSurfaces).not.toContain(value);
  }
}

function jobNeeds(job: WorkflowJob | undefined): string[] {
  if (!job?.needs) return [];
  return Array.isArray(job.needs) ? job.needs : [job.needs];
}

function githubExpression(body: string): string {
  return ["$", "{{ ", body, " }}"].join("");
}

function namedStep(job: WorkflowJob | undefined, name: string): WorkflowStep {
  const found = job?.steps?.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Missing workflow step: ${name}`);
  return found;
}

function runTelegramAuthorityGuard(
  jobName: (typeof guardedReleaseJobNames)[number],
  authorityRunAttempt: string,
  releaseRunAttempt: string,
  botId = stagingTelegram.botId,
  botUsername = stagingTelegram.botUsername,
): TelegramExecution {
  const guard = namedStep(
    parsedReleaseWorkflow.jobs?.[jobName],
    telegramAuthorityGuardName,
  );
  if (!guard.run) throw new Error(`Missing executable guard in ${jobName}`);

  const fixtureRoot = mkdtempSync(
    path.join(tmpdir(), "homepage-telegram-authority-guard-"),
  );
  const githubOutputPath = path.join(fixtureRoot, "github-output.txt");
  const summaryPath = path.join(fixtureRoot, "step-summary.md");

  try {
    const result = Bun.spawnSync(["bash", "-c", guard.run], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        GITHUB_OUTPUT: githubOutputPath,
        GITHUB_STEP_SUMMARY: summaryPath,
        ADMITTED_TELEGRAM_BOT_ID: botId,
        ADMITTED_TELEGRAM_BOT_USERNAME: botUsername,
        RELEASE_RUN_ATTEMPT: releaseRunAttempt,
        TELEGRAM_AUTHORITY_RUN_ATTEMPT: authorityRunAttempt,
      },
      stderr: "pipe",
      stdout: "pipe",
    });

    return {
      exitCode: result.exitCode,
      githubOutput: readOptionalFile(githubOutputPath),
      stderr: result.stderr.toString(),
      stdout: result.stdout.toString(),
      summary: readOptionalFile(summaryPath),
    };
  } finally {
    rmSync(fixtureRoot, { force: true, recursive: true });
  }
}

describe("homepage deployment workflow", () => {
  const homepagePackage = JSON.parse(
    readFileSync(
      path.join(repositoryRoot, "packages/homepage/package.json"),
      "utf8",
    ),
  ) as { name?: string; scripts?: Record<string, string> };
  const appPackage = JSON.parse(
    readFileSync(
      path.join(repositoryRoot, "packages/app/package.json"),
      "utf8",
    ),
  ) as { scripts?: Record<string, string> };
  const devAll = readFileSync(
    path.join(repositoryRoot, "packages/scripts/dev-all.mjs"),
    "utf8",
  );

  it("retires every standalone homepage application lifecycle", () => {
    expect(
      existsSync(path.join(workflowsDirectory, "deploy-homepage.yml")),
    ).toBe(false);
    expect(homepagePackage.name).toBe("@elizaos/homepage-source");
    for (const script of [
      "predev",
      "dev",
      "prebuild",
      "build",
      "postbuild",
      "preview",
      "deploy:production",
      "deploy:preview",
    ]) {
      expect(homepagePackage.scripts?.[script]).toBeUndefined();
    }
    expect(workflow).not.toContain("eliza-app-home");
    expect(releaseWorkflow).not.toContain("eliza-app-home");
    expect(devAll).not.toContain("packages/homepage");
    expect(devAll).not.toContain("DEV_ALL_HOMEPAGE_PORT");
  });

  it("keeps preview work out of the manual canonical entry workflow", () => {
    expect(Object.keys(parsedWorkflow.on ?? {})).toEqual(["workflow_dispatch"]);
    expect(
      parsedWorkflow.jobs?.["resolve-pages-preview-config"],
    ).toBeUndefined();
    expect(parsedWorkflow.jobs?.["build-pages"]).toBeUndefined();
    expect(workflow).not.toContain("pull-request Pages preview");

    const release = parsedWorkflow.jobs?.release;
    expect(release?.uses).toBe("./.github/workflows/cloud-cf-release.yml");
    expect(release?.if).toContain("github.event_name != 'pull_request'");
    expect(release?.with?.target_environment).toContain("staging");
    expect(release?.with?.target_environment).toContain("production");
  });

  it("binds the release attempt before entering a GitHub Environment", () => {
    const attemptBinder =
      parsedWorkflow.jobs?.["bind-telegram-release-attempt"];
    const attemptStep = namedStep(
      attemptBinder,
      "Bind Telegram release attempt",
    );
    const release = parsedWorkflow.jobs?.release;
    const attemptInput =
      parsedReleaseWorkflow.on?.workflow_call?.inputs
        ?.telegram_authority_run_attempt;

    expect(attemptBinder?.environment).toBeUndefined();
    expect(attemptBinder?.outputs?.run_attempt).toBe(
      githubExpression("steps.attempt.outputs.run_attempt"),
    );
    expect(attemptStep.env).toEqual({
      TELEGRAM_AUTHORITY_RUN_ATTEMPT: githubExpression("github.run_attempt"),
    });
    expect(release?.environment).toBeUndefined();
    expect(jobNeeds(release)).toContain("bind-telegram-release-attempt");
    expect(release?.if).toContain(
      "needs.bind-telegram-release-attempt.result == 'success'",
    );
    expect(release?.with?.telegram_authority_run_attempt).toContain(
      "needs.resolve-telegram-environment-authority.outputs.telegram_authority_run_attempt",
    );
    expect(release?.with?.telegram_authority_run_attempt).toContain(
      "needs.bind-telegram-release-attempt.outputs.run_attempt",
    );
    expect(release?.with?.admitted_telegram_bot_id).toBe(
      githubExpression(
        "needs.resolve-telegram-environment-authority.outputs.telegram_bot_id",
      ),
    );
    expect(release?.with?.admitted_telegram_bot_username).toBe(
      githubExpression(
        "needs.resolve-telegram-environment-authority.outputs.telegram_bot_username",
      ),
    );
    expect(
      parsedReleaseWorkflow.on?.workflow_call?.inputs
        ?.telegram_repo_or_org_configured,
    ).toBeUndefined();
    expect(attemptInput).toMatchObject({
      required: true,
      type: "string",
    });
    expect(
      parsedReleaseWorkflow.on?.workflow_call?.inputs?.admitted_telegram_bot_id,
    ).toMatchObject({ required: true, type: "string" });
    expect(
      parsedReleaseWorkflow.on?.workflow_call?.inputs
        ?.admitted_telegram_bot_username,
    ).toMatchObject({ required: true, type: "string" });
  });

  it("keeps Telegram authority and runtime credentials in protected Environment jobs", () => {
    const release = parsedWorkflow.jobs?.release;
    const callerSecrets = release?.secrets;
    const environmentOnlySecrets = [
      "TELEGRAM_IDENTITY_AUTHORITY_SHA256",
      "ELIZA_APP_TELEGRAM_BOT_TOKEN",
      "ELIZA_APP_TELEGRAM_WEBHOOK_SECRET",
    ] as const;
    const referencedSecrets = [
      ...releaseWorkflow.matchAll(/\bsecrets\.([A-Z0-9_]+)/g),
    ]
      .map((match) => match[1])
      .filter((name): name is string => Boolean(name));
    const expectedCallerSecrets = [
      ...new Set(
        referencedSecrets.filter(
          (name) =>
            !environmentOnlySecrets.includes(
              name as (typeof environmentOnlySecrets)[number],
            ),
        ),
      ),
    ].sort();

    expect(callerSecrets).not.toBe("inherit");
    expect(callerSecrets).toBeTypeOf("object");
    const callerSecretMap = callerSecrets as Record<string, string>;
    expect(Object.keys(callerSecretMap).sort()).toEqual(expectedCallerSecrets);
    expect(
      Object.keys(
        parsedReleaseWorkflow.on?.workflow_call?.secrets ?? {},
      ).sort(),
    ).toEqual(expectedCallerSecrets);
    for (const name of expectedCallerSecrets) {
      expect(callerSecretMap[name], name).toBe(
        githubExpression(`secrets.${name}`),
      );
      expect(
        parsedReleaseWorkflow.on?.workflow_call?.secrets?.[name],
        name,
      ).toEqual({ required: false });
    }
    for (const name of environmentOnlySecrets) {
      expect(callerSecretMap).not.toHaveProperty(name);
      expect(
        parsedReleaseWorkflow.on?.workflow_call?.secrets,
      ).not.toHaveProperty(name);
    }
    expect(releaseWorkflow).not.toContain(
      "secrets.TELEGRAM_IDENTITY_AUTHORITY_SHA256",
    );
    expect(releaseWorkflow).not.toContain(
      "secrets.ELIZA_APP_TELEGRAM_BOT_TOKEN",
    );
    expect(releaseWorkflow).not.toContain(
      "secrets.ELIZA_APP_TELEGRAM_WEBHOOK_SECRET",
    );

    const apiDeploy = parsedReleaseWorkflow.jobs?.["deploy-api"];
    const secretPreparation = namedStep(
      apiDeploy,
      "Prepare Worker secrets for atomic deploy",
    );
    expect(apiDeploy?.environment).toBe(
      githubExpression("inputs.target_environment"),
    );
    expect(secretPreparation.env?.ELIZA_APP_TELEGRAM_BOT_TOKEN).toBe(
      githubExpression(
        "secrets[format('{0}{1}', 'ELIZA_APP_TELEGRAM_', 'BOT_TOKEN')]",
      ),
    );
    expect(secretPreparation.env?.ELIZA_APP_TELEGRAM_WEBHOOK_SECRET).toBe(
      githubExpression(
        "secrets[format('{0}{1}', 'ELIZA_APP_TELEGRAM_', 'WEBHOOK_SECRET')]",
      ),
    );
  });

  it("admits Telegram identity in the entry workflow before every release mutation", () => {
    const jobs = parsedReleaseWorkflow.jobs ?? {};
    const jobNames = Object.keys(jobs);
    const migration = jobs["migrate-db"];
    const apiDeploy = jobs["deploy-api"];
    const pagesBuild = jobs["build-pages"];

    expect(telegramAuthorityResolver?.environment).toBe("staging");
    expect(jobNeeds(telegramAuthorityResolver)).toEqual([
      "bind-telegram-release-attempt",
      "validate-deploy-source",
    ]);
    expect(telegramAuthorityResolver?.if).toContain(
      "inputs.environment == 'staging'",
    );
    expect(telegramAuthorityResolver?.outputs).toEqual({
      telegram_bot_id: githubExpression("steps.telegram.outputs.bot_id"),
      telegram_bot_username: githubExpression(
        "steps.telegram.outputs.bot_username",
      ),
      telegram_authority_run_attempt: githubExpression(
        "steps.telegram.outputs.run_attempt",
      ),
      telegram_runtime_authority: githubExpression(
        "steps.runtime_binding.outputs.runtime_authority",
      ),
    });
    expect(telegramAuthorityResolver?.steps?.[0]?.uses).toContain(
      "actions/checkout@",
    );
    const stagingBunSetupIndex =
      telegramAuthorityResolver?.steps?.findIndex(
        (step) =>
          step.uses ===
          "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6",
      ) ?? -1;
    const stagingRuntimeBindingIndex =
      telegramAuthorityResolver?.steps?.findIndex(
        (step) =>
          step.name ===
          "Verify protected staging Telegram Worker binding names",
      ) ?? -1;
    expect(stagingBunSetupIndex).toBeGreaterThan(0);
    expect(stagingBunSetupIndex).toBeLessThan(stagingRuntimeBindingIndex);
    expect(
      telegramAuthorityResolver?.steps?.[stagingBunSetupIndex]?.with,
    ).toEqual({
      "bun-version": "1.3.14",
    });
    expect(telegramValidation?.env).toEqual({
      RELEASE_RUN_ATTEMPT: githubExpression("github.run_attempt"),
      TARGET_ENVIRONMENT: "staging",
      TELEGRAM_AUTHORITY_RUN_ATTEMPT: githubExpression(
        "needs.bind-telegram-release-attempt.outputs.run_attempt",
      ),
      ENVIRONMENT_TELEGRAM_BOT_ID: githubExpression(
        "vars.VITE_TELEGRAM_BOT_ID",
      ),
      ENVIRONMENT_TELEGRAM_BOT_USERNAME: githubExpression(
        "vars.VITE_TELEGRAM_BOT_USERNAME",
      ),
      TELEGRAM_IDENTITY_AUTHORITY_SHA256: githubExpression(
        "secrets.TELEGRAM_IDENTITY_AUTHORITY_SHA256",
      ),
    });
    const stagingRuntimeBinding = namedStep(
      telegramAuthorityResolver,
      "Verify protected staging Telegram Worker binding names",
    );
    expect(stagingRuntimeBinding.env).toEqual({
      CLOUDFLARE_API_TOKEN: githubExpression("secrets.CLOUDFLARE_API_TOKEN"),
      CLOUDFLARE_ACCOUNT_ID: githubExpression("secrets.CLOUDFLARE_ACCOUNT_ID"),
    });
    expect(stagingRuntimeBinding["working-directory"]).toBe(
      "packages/cloud/api",
    );
    expect(stagingRuntimeBinding.run).toContain(
      "wrangler@4.116.0 secret list --env staging --format json",
    );
    expect(stagingRuntimeBinding.run).toContain(
      "../scripts/verify-worker-secret-binding-names.mjs",
    );
    expect(stagingRuntimeBinding.run).toContain(
      "runtime_authority=staging-protected-receipt-and-existing-bindings",
    );
    expect(stagingRuntimeBinding.run).not.toContain("TELEGRAM_BOT_TOKEN=");
    expect(stagingRuntimeBinding.run).not.toContain("TELEGRAM_WEBHOOK_SECRET=");
    expect(jobNeeds(parsedWorkflow.jobs?.release)).toContain(
      "resolve-telegram-environment-authority",
    );
    expect(parsedWorkflow.jobs?.release?.if).toContain(
      "needs.resolve-telegram-environment-authority.result == 'success'",
    );
    expect(parsedWorkflow.jobs?.release?.if).toContain(
      "needs.resolve-telegram-environment-authority.result == 'skipped'",
    );
    expect(
      parsedWorkflow.jobs?.release?.with?.telegram_runtime_authority,
    ).toContain(
      "needs.resolve-telegram-environment-authority.outputs.telegram_runtime_authority",
    );
    expect(
      parsedWorkflow.jobs?.release?.with?.telegram_runtime_authority,
    ).toContain(
      "needs.authorize-production.outputs.telegram_runtime_authority",
    );
    expect(
      parsedReleaseWorkflow.on?.workflow_call?.inputs
        ?.telegram_runtime_authority,
    ).toMatchObject({ required: true, type: "string" });

    const productionAuthorization =
      parsedWorkflow.jobs?.["authorize-production"];
    const productionRuntimeAttestation = namedStep(
      productionAuthorization,
      "Attest protected production Telegram runtime identity",
    );
    expect(productionAuthorization?.environment).toBe("production");
    expect(productionAuthorization?.outputs).toEqual({
      telegram_runtime_authority: githubExpression(
        "steps.runtime_attestation.outputs.runtime_authority",
      ),
    });
    expect(productionRuntimeAttestation.env).toEqual({
      TELEGRAM_BOT_TOKEN: githubExpression(
        "secrets.ELIZA_APP_TELEGRAM_BOT_TOKEN",
      ),
      TELEGRAM_WEBHOOK_SECRET: githubExpression(
        "secrets.ELIZA_APP_TELEGRAM_WEBHOOK_SECRET",
      ),
      TELEGRAM_ATTESTATION_CONTEXT: "production",
    });
    expect(productionRuntimeAttestation.run).toContain(
      "packages/homepage/src/lib/contact.ts",
    );
    expect(productionRuntimeAttestation.run).toContain(
      "packages/cloud/scripts/verify-telegram-bot-identity.mjs",
    );
    expect(productionRuntimeAttestation.run).toContain(
      "runtime_authority=production-live-attested",
    );
    expect(jobNeeds(parsedWorkflow.jobs?.release)).toContain(
      "authorize-production",
    );

    expect(jobNames.indexOf("resolve-pages-environment-config")).toBeLessThan(
      jobNames.indexOf("migrate-db"),
    );
    expect(jobNeeds(resolver)).toEqual([]);
    expect(resolver?.environment).toBe(
      githubExpression(
        "inputs.target_environment == 'production' && 'production' || 'staging'",
      ),
    );
    expect(resolver?.steps?.[0]?.uses).toContain("actions/checkout@");
    expect(admittedTelegramValidation?.env).toEqual({
      RELEASE_RUN_ATTEMPT: githubExpression("github.run_attempt"),
      TARGET_ENVIRONMENT: githubExpression("inputs.target_environment"),
      TELEGRAM_AUTHORITY_RUN_ATTEMPT: githubExpression(
        "inputs.telegram_authority_run_attempt",
      ),
      TELEGRAM_RUNTIME_AUTHORITY: githubExpression(
        "inputs.telegram_runtime_authority",
      ),
      ADMITTED_TELEGRAM_BOT_ID: githubExpression(
        "inputs.admitted_telegram_bot_id",
      ),
      ADMITTED_TELEGRAM_BOT_USERNAME: githubExpression(
        "inputs.admitted_telegram_bot_username",
      ),
    });
    expect(releaseWorkflow).not.toContain("secrets.VITE_TELEGRAM_BOT_ID");
    expect(releaseWorkflow).not.toContain("secrets.VITE_TELEGRAM_BOT_USERNAME");

    expect(jobNeeds(migration)).toEqual(["resolve-pages-environment-config"]);
    expect(jobNeeds(parsedWorkflow.jobs?.release)).toContain(
      "resolve-telegram-environment-authority",
    );
    expect(migration?.if).toContain(
      "needs.resolve-pages-environment-config.result == 'success'",
    );
    expect(jobNeeds(apiDeploy)).toEqual([
      "resolve-pages-environment-config",
      "migrate-db",
    ]);
    expect(apiDeploy?.if).toContain(
      "needs.resolve-pages-environment-config.result == 'success'",
    );
    expect(jobNeeds(pagesBuild)).toEqual([
      "migrate-db",
      "resolve-pages-environment-config",
    ]);
    expect(pagesBuild?.if).toContain(
      "needs.resolve-pages-environment-config.result == 'success'",
    );
  });

  it("limits the feature-ref Telegram authority canary to protected staging preflight", () => {
    const dispatchInputs = (
      (parsedWorkflow.on?.workflow_dispatch ?? {}) as {
        inputs?: Record<string, WorkflowCallInput>;
      }
    ).inputs;
    const sourceValidation = namedStep(
      parsedWorkflow.jobs?.["validate-deploy-source"],
      "Reject feature refs targeting canonical environments",
    );
    const canaryInput = dispatchInputs?.telegram_authority_canary;

    expect(canaryInput).toMatchObject({ required: false, type: "boolean" });
    expect(telegramAuthorityResolver?.environment).toBe("staging");
    expect(telegramAuthorityResolver?.if).toContain(
      "inputs.environment == 'staging'",
    );
    expect(telegramValidation?.run).not.toContain(
      "TELEGRAM_IDENTITY_AUTHORITY_SHA256=",
    );
    expect(telegramValidation?.run).not.toContain(
      'TELEGRAM_IDENTITY_AUTHORITY_SHA256" >>',
    );
    for (const jobName of [
      "admit-staging",
      "validate-staging-certification",
      "authorize-production",
      "release",
      "certify-staging-release",
    ]) {
      expect(parsedWorkflow.jobs?.[jobName]?.if, jobName).toContain(
        "inputs.telegram_authority_canary != true",
      );
    }
    expect(sourceValidation.env?.TELEGRAM_AUTHORITY_CANARY).toBe(
      githubExpression("inputs.telegram_authority_canary == true"),
    );

    const accepted = runTelegramAuthorityCanaryAdmission();
    expect(accepted.exitCode).toBe(0);
    expect(accepted.stdout).toContain(
      "Telegram authority canary admitted for protected staging preflight only.",
    );

    for (const invalid of [
      { label: "production", targetEnvironment: "production" },
      { label: "force", force: "true" },
      { label: "renderer", renderer: "true" },
    ]) {
      const execution = runTelegramAuthorityCanaryAdmission(invalid);
      expect(execution.exitCode, invalid.label).toBe(1);
      expect(
        `${execution.stdout}\n${execution.stderr}`,
        invalid.label,
      ).toContain("Telegram authority canary");
    }
  });

  it("guards the first selected job for every partial-rerun mutation path", () => {
    const guardScripts: string[] = [];

    for (const jobName of guardedReleaseJobNames) {
      const job = parsedReleaseWorkflow.jobs?.[jobName];
      const guard = namedStep(job, telegramAuthorityGuardName);

      expect(job?.steps?.[0]?.name, jobName).toBe(telegramAuthorityGuardName);
      expect(guard.env, jobName).toEqual({
        ADMITTED_TELEGRAM_BOT_ID: githubExpression(
          "needs.resolve-pages-environment-config.outputs.telegram_bot_id",
        ),
        ADMITTED_TELEGRAM_BOT_USERNAME: githubExpression(
          "needs.resolve-pages-environment-config.outputs.telegram_bot_username",
        ),
        RELEASE_RUN_ATTEMPT: githubExpression("github.run_attempt"),
        TELEGRAM_AUTHORITY_RUN_ATTEMPT: githubExpression(
          "inputs.telegram_authority_run_attempt",
        ),
      });
      expect(guard.run, jobName).toBeTruthy();
      guardScripts.push(guard.run ?? "");

      const initialAttempt = runTelegramAuthorityGuard(jobName, "1", "1");
      expect(initialAttempt.exitCode, `${jobName} attempt 1`).toBe(0);
      expect(initialAttempt.githubOutput, `${jobName} attempt 1`).toBe("");
      expect(initialAttempt.stdout, `${jobName} attempt 1`).toBe("");
      expect(initialAttempt.stderr, `${jobName} attempt 1`).toBe("");
      expect(initialAttempt.summary, `${jobName} attempt 1`).toBe("");

      const partialRerun = runTelegramAuthorityGuard(jobName, "1", "2");
      expect(partialRerun.exitCode, `${jobName} partial rerun`).toBe(1);
      expect(partialRerun.githubOutput, `${jobName} partial rerun`).toBe("");
      expect(partialRerun.stdout, `${jobName} partial rerun`).toBe("");
      expect(partialRerun.summary, `${jobName} partial rerun`).toBe("");
      expect(partialRerun.stderr, `${jobName} partial rerun`).toContain(
        "Telegram configuration authority was not resolved for the current workflow attempt; re-run all jobs",
      );

      for (const suppressed of [
        { botId: "", botUsername: stagingTelegram.botUsername },
        { botId: stagingTelegram.botId, botUsername: "" },
        { botId: "4503599627370496", botUsername: stagingTelegram.botUsername },
        { botId: stagingTelegram.botId, botUsername: "not-a-bot-name" },
      ]) {
        const missingOutput = runTelegramAuthorityGuard(
          jobName,
          "1",
          "1",
          suppressed.botId,
          suppressed.botUsername,
        );
        expect(missingOutput.exitCode, `${jobName} suppressed output`).toBe(1);
        expect(missingOutput.githubOutput).toBe("");
        expect(missingOutput.stdout).toBe("");
        expect(missingOutput.summary).toBe("");
        expect(missingOutput.stderr).toContain("Admitted Telegram");
        assertNoPublicSurfaceLeak(missingOutput, [
          suppressed.botId,
          suppressed.botUsername,
        ]);
      }
    }

    expect(new Set(guardScripts).size).toBe(1);
  });

  it("accepts valid staging-Environment Telegram identities", () => {
    for (const valid of [
      { target: "staging", ...stagingTelegram },
      {
        target: "staging",
        botId: "4503599627370495",
        botUsername: "MaxIdStageBot",
      },
    ]) {
      const execution = runTelegramPreflight({
        botId: valid.botId,
        botUsername: valid.botUsername,
        targetEnvironment: valid.target,
      });
      expect(execution.exitCode).toBe(0);
      expect(execution.githubOutput).toBe(
        `bot_id=${valid.botId}\nbot_username=${valid.botUsername}\nrun_attempt=1\n`,
      );
      expect(execution.summary).toContain(
        `Validated protected Telegram public identity policy for ${valid.target}.`,
      );
      assertNoPublicSurfaceLeak(execution, [valid.botId, valid.botUsername]);
    }
  });

  it("binds the accepted public pair to a framed protected authority receipt", () => {
    const authoritySha256 = telegramIdentityAuthoritySha256(
      stagingTelegram.botId,
      stagingTelegram.botUsername,
    );
    const equivalentCase = runTelegramPreflight({
      authoritySha256,
      botUsername: stagingTelegram.botUsername.toLowerCase(),
    });
    expect(equivalentCase.exitCode).toBe(0);
    expect(equivalentCase.githubOutput).toContain(
      `bot_username=${stagingTelegram.botUsername.toLowerCase()}\n`,
    );
    assertNoPublicSurfaceLeak(equivalentCase, [
      stagingTelegram.botId,
      stagingTelegram.botUsername,
      authoritySha256,
    ]);

    for (const invalid of [
      { label: "missing receipt", authoritySha256: "" },
      { label: "malformed receipt", authoritySha256: "not-a-sha256" },
      {
        label: "uppercase receipt",
        authoritySha256: authoritySha256.toUpperCase(),
      },
      {
        label: "receipt for another ID",
        authoritySha256: telegramIdentityAuthoritySha256(
          `${stagingTelegram.botId.slice(0, -1)}4`,
          stagingTelegram.botUsername,
        ),
      },
      {
        label: "receipt for another username",
        authoritySha256: telegramIdentityAuthoritySha256(
          stagingTelegram.botId,
          "AnotherStageBot",
        ),
      },
    ]) {
      const execution = runTelegramPreflight({
        authoritySha256: invalid.authoritySha256,
      });
      expect(execution.exitCode, invalid.label).toBe(1);
      expect(execution.githubOutput, invalid.label).toBe("");
      expect(execution.summary, invalid.label).toBe("");
      assertNoPublicSurfaceLeak(execution, [
        stagingTelegram.botId,
        stagingTelegram.botUsername,
        invalid.authoritySha256,
      ]);
    }

    expect(telegramIdentityAuthoritySha256("1", "2345Bot")).not.toBe(
      telegramIdentityAuthoritySha256("12", "345Bot"),
    );
    expect(telegramValidation?.run).toContain(
      "elizaOS/eliza\\0staging\\0telegram-public-identity\\0v1\\0%s\\0%s\\n",
    );
  });

  it("rejects a stale Telegram authority receipt reused by a partial rerun", () => {
    const environmentTelegram = {
      botId: "partial-rerun-environment-id-fixture",
      botUsername: "partial-rerun-environment-username-fixture",
    };
    const execution = runTelegramPreflight({
      ...environmentTelegram,
      authorityRunAttempt: "1",
      releaseRunAttempt: "2",
      targetEnvironment: "staging",
    });

    expect(execution.exitCode).toBe(1);
    expect(execution.githubOutput).toBe("");
    expect(execution.summary).toBe("");
    expect(execution.stderr).toContain(
      "Telegram configuration authority was not resolved for the current workflow attempt; re-run all jobs",
    );
    expect(execution.stderr).not.toContain("must match the Telegram");
    assertNoPublicSurfaceLeak(execution, [
      environmentTelegram.botId,
      environmentTelegram.botUsername,
    ]);
  });

  it("fails closed before release mutations when caller runtime authority is absent", () => {
    const execution = runReusableTelegramPreflight({ runtimeAuthority: "" });

    expect(execution.exitCode).toBe(1);
    expect(execution.githubOutput).toBe("");
    expect(execution.summary).toBe("");
    expect(execution.stderr).toContain(
      "Telegram runtime authority was not proven for the selected protected Environment; re-run all jobs",
    );
    assertNoPublicSurfaceLeak(execution, [
      stagingTelegram.botId,
      stagingTelegram.botUsername,
    ]);
  });

  it("rejects a runtime-authority result for the wrong protected Environment", () => {
    for (const invalid of [
      {
        label: "production live attestation passed to staging",
        targetEnvironment: "staging",
        runtimeAuthority: "production-live-attested",
      },
      {
        label: "staging preserve authority passed to production",
        targetEnvironment: "production",
        runtimeAuthority: "staging-protected-receipt-and-existing-bindings",
      },
    ]) {
      const execution = runReusableTelegramPreflight(invalid);
      expect(execution.exitCode, invalid.label).toBe(1);
      expect(execution.githubOutput, invalid.label).toBe("");
      expect(execution.summary, invalid.label).toBe("");
      expect(execution.stderr, invalid.label).toContain(
        "Telegram runtime authority was not proven for the selected protected Environment; re-run all jobs",
      );
    }
  });

  it("derives production Telegram identity in the reusable release and ignores caller inputs", () => {
    for (const configuredStagingPair of [
      { botId: "", botUsername: "" },
      stagingTelegram,
      {
        botId: "not-a-number",
        botUsername: "not-a-valid-name!",
      },
    ]) {
      const execution = runReusableTelegramPreflight({
        ...configuredStagingPair,
        targetEnvironment: "production",
      });
      expect(execution.exitCode).toBe(0);
      expect(execution.githubOutput).toBe(
        `bot_id=${canonicalTelegram.botId}\nbot_username=${canonicalTelegram.botUsername}\n`,
      );
      expect(execution.summary).toContain(
        "Accepted caller-admitted Telegram public identity for production.",
      );
      assertNoPublicSurfaceLeak(execution, [
        configuredStagingPair.botId,
        configuredStagingPair.botUsername,
        canonicalTelegram.botId,
        canonicalTelegram.botUsername,
      ]);
    }
  });

  it("fails closed for incomplete, blank, malformed, crossed, or unknown Telegram configuration", () => {
    const cases = [
      { label: "both absent", target: "staging", botId: "", botUsername: "" },
      {
        label: "ID only",
        target: "staging",
        botId: stagingTelegram.botId,
        botUsername: "",
      },
      {
        label: "username only",
        target: "staging",
        botId: "",
        botUsername: stagingTelegram.botUsername,
      },
      {
        label: "blank ID",
        target: "staging",
        botId: " \t ",
        botUsername: stagingTelegram.botUsername,
      },
      {
        label: "blank username",
        target: "staging",
        botId: stagingTelegram.botId,
        botUsername: " \t ",
      },
      {
        label: "leading-zero ID",
        target: "staging",
        botId: "012345",
        botUsername: stagingTelegram.botUsername,
      },
      {
        label: "overlong ID",
        target: "staging",
        botId: "1".repeat(21),
        botUsername: stagingTelegram.botUsername,
      },
      {
        label: "ID above Telegram 52-bit maximum",
        target: "staging",
        botId: "4503599627370496",
        botUsername: stagingTelegram.botUsername,
      },
      {
        label: "nonnumeric ID",
        target: "staging",
        botId: "12345x",
        botUsername: stagingTelegram.botUsername,
      },
      {
        label: "short username",
        target: "staging",
        botId: stagingTelegram.botId,
        botUsername: "Bot_",
      },
      {
        label: "overlong username",
        target: "staging",
        botId: stagingTelegram.botId,
        botUsername: "B".repeat(33),
      },
      {
        label: "symbol in username",
        target: "staging",
        botId: stagingTelegram.botId,
        botUsername: "Eliza-Stage",
      },
      {
        label: "username is not a managed bot",
        target: "staging",
        botId: stagingTelegram.botId,
        botUsername: "ordinary_user",
      },
      {
        label: "unknown environment",
        target: "preview",
        botId: stagingTelegram.botId,
        botUsername: stagingTelegram.botUsername,
      },
      {
        label: "staging equals production",
        target: "staging",
        botId: canonicalTelegram.botId,
        botUsername: canonicalTelegram.botUsername,
      },
      {
        label: "staging reuses production ID",
        target: "staging",
        botId: canonicalTelegram.botId,
        botUsername: stagingTelegram.botUsername,
      },
      {
        label: "staging reuses production username",
        target: "staging",
        botId: stagingTelegram.botId,
        botUsername: canonicalTelegram.botUsername,
      },
      {
        label: "staging reuses production username with different casing",
        target: "staging",
        botId: stagingTelegram.botId,
        botUsername: canonicalTelegram.botUsername.toLowerCase(),
      },
    ];

    for (const invalid of cases) {
      const execution = runTelegramPreflight({
        botId: invalid.botId,
        botUsername: invalid.botUsername,
        targetEnvironment: invalid.target,
      });
      expect(execution.exitCode, invalid.label).toBe(1);
      expect(execution.githubOutput, invalid.label).toBe("");
      expect(execution.summary, invalid.label).toBe("");
      assertNoPublicSurfaceLeak(execution, [
        invalid.botId,
        invalid.botUsername,
      ]);
    }
  });

  it("passes guarded resolver outputs directly to primary and legacy Pages builds", () => {
    const pagesBuild = parsedReleaseWorkflow.jobs?.["build-pages"];
    const appDeploy = parsedReleaseWorkflow.jobs?.["deploy-app"];
    const primaryBuild = namedStep(
      pagesBuild,
      "Build consolidated frontend artifact",
    );
    const legacyBuild = namedStep(
      appDeploy,
      "Legacy inline fallback - build app",
    );

    expect(pagesBuild?.outputs).not.toHaveProperty("telegram_bot_id");
    expect(pagesBuild?.outputs).not.toHaveProperty("telegram_bot_username");
    expect(primaryBuild.env?.VITE_TELEGRAM_BOT_ID).toBe(
      githubExpression(
        "needs.resolve-pages-environment-config.outputs.telegram_bot_id",
      ),
    );
    expect(primaryBuild.env?.VITE_TELEGRAM_BOT_USERNAME).toBe(
      githubExpression(
        "needs.resolve-pages-environment-config.outputs.telegram_bot_username",
      ),
    );
    expect(legacyBuild.env?.VITE_TELEGRAM_BOT_ID).toBe(
      githubExpression(
        "needs.resolve-pages-environment-config.outputs.telegram_bot_id",
      ),
    );
    expect(legacyBuild.env?.VITE_TELEGRAM_BOT_USERNAME).toBe(
      githubExpression(
        "needs.resolve-pages-environment-config.outputs.telegram_bot_username",
      ),
    );
    expect(jobNeeds(parsedReleaseWorkflow.jobs?.["deploy-app"])).toContain(
      "resolve-pages-environment-config",
    );
    expect(releaseWorkflow).not.toContain("7684336618");
    expect(releaseWorkflow).not.toContain("Elizav2_Bot");
  });

  it("keeps WhatsApp disabled until a production sender is explicitly enabled", () => {
    expect(releaseWorkflow).toContain("WHATSAPP_PUBLIC_ENABLED");
    expect(releaseWorkflow).toContain(
      "VITE_WHATSAPP_PHONE_NUMBER must be an E.164 number when WHATSAPP_PUBLIC_ENABLED is true",
    );
    expect(releaseWorkflow).toContain(
      "The public WhatsApp CTA cannot use a shared sandbox, developer test, or unverified sender",
    );
    expect(releaseWorkflow).toContain("+14155238886|+15551649988|+14159611510");
    expect(releaseWorkflow).toContain(
      'echo "phone_number=" >> "$GITHUB_OUTPUT"',
    );
    expect(releaseWorkflow).toContain(
      "VITE_WHATSAPP_PHONE_NUMBER: $" +
        "{{ needs.resolve-pages-environment-config.outputs.whatsapp_phone_number }}",
    );
    expect(releaseWorkflow).toContain(
      "VITE_WHATSAPP_PHONE_NUMBER: $" +
        "{{ needs.build-pages.outputs.whatsapp_phone_number }}",
    );
  });

  it("builds homepage changes into the single eliza-app artifact", () => {
    expect(appPackage.scripts?.["prebuild:web"]).toBe(
      "bun run --cwd ../cloud/sdk build && bun run prebuild",
    );
    expect(qualityWorkflow).toContain("packages/homepage/");
    expect(qualityWorkflow).toContain("Build the only deployable frontend");
    expect(workflow).not.toContain("Build consolidated frontend artifact");
    expect(workflow).not.toContain("Upload consolidated frontend artifact");
    expect(releaseWorkflow).toContain("Build consolidated frontend artifact");
    expect(releaseWorkflow).toContain("Upload consolidated frontend artifact");
    expect(releaseWorkflow).toContain("PAGES_PROJECT: eliza-app");
    expect(releaseWorkflow).toContain("https://eliza.app");
    expect(releaseWorkflow).toContain("https://cloud.eliza.app");
    expect(releaseWorkflow).toContain("https://staging.eliza.app");
    expect(releaseWorkflow).toContain("https://cloud-staging.eliza.app");
  });

  it("validates homepage source while building only packages/app in quality CI", () => {
    expect(qualityWorkflow).toContain("consolidated-frontend-build:");
    expect(qualityWorkflow).toContain("Validate homepage source contracts");
    expect(qualityWorkflow).toContain("working-directory: packages/homepage");
    expect(qualityWorkflow).toContain(
      "run: bun run typecheck && bun run lint:check && bun run test && bun run check:snapshot-inventory",
    );
    expect(qualityWorkflow).toContain("Build the only deployable frontend");
    expect(qualityWorkflow).toContain("working-directory: packages/app");
    expect(qualityWorkflow).toContain("run: bun run build:web");
    expect(qualityWorkflow).not.toContain(
      "working-directory: packages/homepage\n        run: bun run build",
    );
    expect(qualityWorkflow).not.toContain(
      "PLAYWRIGHT_INSTALL_CWD=packages/homepage",
    );
  });

  it("builds the default-condition workspace chain before homepage validation", () => {
    // Homepage resolves UI's public dist subpaths and the frontend reaches
    // prompts through core. A clean --ignore-scripts install produces none of
    // those dist artifacts, so the consumer gates must follow their builds.
    expect(releaseWorkflow).toContain("run: bun run build:core");
    const promptsBuildIndex = qualityWorkflow.indexOf(
      "bun run --cwd packages/prompts build:package",
    );
    const coreBuildIndex = qualityWorkflow.indexOf("bun run build:core");
    const uiBuildIndex = qualityWorkflow.indexOf(
      "bun run --cwd packages/ui build",
    );
    const homepageValidationIndex = qualityWorkflow.indexOf(
      "name: Validate homepage source contracts",
    );
    const webBuildIndex = qualityWorkflow.indexOf("run: bun run build:web");
    expect(promptsBuildIndex).toBeGreaterThan(-1);
    expect(coreBuildIndex).toBeGreaterThan(promptsBuildIndex);
    expect(uiBuildIndex).toBeGreaterThan(coreBuildIndex);
    expect(homepageValidationIndex).toBeGreaterThan(uiBuildIndex);
    expect(coreBuildIndex).toBeGreaterThan(-1);
    expect(webBuildIndex).toBeGreaterThan(homepageValidationIndex);
  });
});
