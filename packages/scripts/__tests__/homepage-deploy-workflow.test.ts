/**
 * Guards the consolidated homepage deployment authority and the fail-closed
 * public messaging identity preflight that must succeed before release
 * mutations can begin.
 */
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
}

interface WorkflowJob {
  environment?: string;
  if?: string;
  needs?: string | string[];
  outputs?: Record<string, string>;
  steps?: WorkflowStep[];
  uses?: string;
  with?: Record<string, string | boolean>;
}

interface WorkflowFile {
  jobs?: Record<string, WorkflowJob>;
  on?: Record<string, unknown>;
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

const resolver =
  parsedReleaseWorkflow.jobs?.["resolve-pages-environment-config"];
const telegramValidation = resolver?.steps?.find(
  (candidate) =>
    candidate.name === "Validate Telegram public identity preflight",
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

function readOptionalFile(filePath: string): string {
  return existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
}

function runTelegramPreflight(
  overrides: Partial<{
    botId: string;
    botUsername: string;
    targetEnvironment: string;
  }> = {},
): TelegramExecution {
  if (!telegramValidation?.run) {
    throw new Error("Missing executable Telegram public identity preflight");
  }

  const fixtureRoot = mkdtempSync(
    path.join(tmpdir(), "homepage-telegram-preflight-"),
  );
  const githubOutputPath = path.join(fixtureRoot, "github-output.txt");
  const summaryPath = path.join(fixtureRoot, "step-summary.md");

  try {
    const result = Bun.spawnSync(["bash", "-c", telegramValidation.run], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        GITHUB_OUTPUT: githubOutputPath,
        GITHUB_STEP_SUMMARY: summaryPath,
        TARGET_ENVIRONMENT: overrides.targetEnvironment ?? "staging",
        STAGING_TELEGRAM_BOT_ID: overrides.botId ?? stagingTelegram.botId,
        STAGING_TELEGRAM_BOT_USERNAME:
          overrides.botUsername ?? stagingTelegram.botUsername,
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

  it("runs the Telegram resolver before every release mutation", () => {
    const jobs = parsedReleaseWorkflow.jobs ?? {};
    const jobNames = Object.keys(jobs);
    const migration = jobs["migrate-db"];
    const apiDeploy = jobs["deploy-api"];
    const pagesBuild = jobs["build-pages"];

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
    expect(telegramValidation?.env).toEqual({
      TARGET_ENVIRONMENT: githubExpression("inputs.target_environment"),
      STAGING_TELEGRAM_BOT_ID: githubExpression("vars.VITE_TELEGRAM_BOT_ID"),
      STAGING_TELEGRAM_BOT_USERNAME: githubExpression(
        "vars.VITE_TELEGRAM_BOT_USERNAME",
      ),
    });

    expect(jobNeeds(migration)).toEqual(["resolve-pages-environment-config"]);
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

  it("accepts valid repository-scoped staging Telegram identities", () => {
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
        `bot_id=${valid.botId}\nbot_username=${valid.botUsername}\n`,
      );
      expect(execution.summary).toContain(
        `Validated Telegram public identity policy for ${valid.target}.`,
      );
      assertNoPublicSurfaceLeak(execution, [valid.botId, valid.botUsername]);
    }
  });

  it("derives production Telegram identity from source and ignores repository staging input", () => {
    for (const configuredStagingPair of [
      { botId: "", botUsername: "" },
      stagingTelegram,
      { botId: "not-a-number", botUsername: "not-a-valid-name!" },
    ]) {
      const execution = runTelegramPreflight({
        ...configuredStagingPair,
        targetEnvironment: "production",
      });
      expect(execution.exitCode).toBe(0);
      expect(execution.githubOutput).toBe(
        `bot_id=${canonicalTelegram.botId}\nbot_username=${canonicalTelegram.botUsername}\n`,
      );
      expect(execution.summary).toContain(
        "Validated Telegram public identity policy for production.",
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

  it("preserves resolver outputs through the primary and legacy Pages builds", () => {
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

    expect(pagesBuild?.outputs?.telegram_bot_id).toBe(
      githubExpression(
        "needs.resolve-pages-environment-config.outputs.telegram_bot_id",
      ),
    );
    expect(pagesBuild?.outputs?.telegram_bot_username).toBe(
      githubExpression(
        "needs.resolve-pages-environment-config.outputs.telegram_bot_username",
      ),
    );
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
      githubExpression("needs.build-pages.outputs.telegram_bot_id"),
    );
    expect(legacyBuild.env?.VITE_TELEGRAM_BOT_USERNAME).toBe(
      githubExpression("needs.build-pages.outputs.telegram_bot_username"),
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
