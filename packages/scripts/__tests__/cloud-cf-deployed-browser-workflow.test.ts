/**
 * Fail-closed structure for the credentialed browser proof of the exact
 * Cloudflare Pages staging deployment. The workflow is inspected as data so a
 * later refactor cannot silently move credentials into public probes, test a
 * local renderer, or publish Wrangler/Playwright internals as evidence.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const repoRoot = new URL("../../../", import.meta.url);

function read(path: string): string {
  return readFileSync(new URL(path, repoRoot), "utf8");
}

function githubExpression(body: string): string {
  return ["$", "{{ ", body, " }}"].join("");
}

function shellExpansion(body: string): string {
  return ["$", "{", body, "}"].join("");
}

interface WorkflowStep {
  id?: string;
  name?: string;
  if?: string;
  uses?: string;
  env?: Record<string, string>;
  run?: string;
  with?: Record<string, string>;
}

interface WorkflowJob {
  needs?: string[];
  if?: string;
  environment?: string;
  env?: Record<string, string>;
  outputs?: Record<string, string>;
  steps?: WorkflowStep[];
}

interface Workflow {
  jobs?: Record<string, WorkflowJob>;
}

const workflowSource = read(".github/workflows/cloud-cf-release.yml");
const workflow = Bun.YAML.parse(workflowSource) as Workflow;
const deployedConfig = read("packages/app/playwright.cloud-deployed.config.ts");
const smokeSpec = read("packages/app/test/ui-smoke/cloud-live.spec.ts");

function requireJob(name: string): WorkflowJob {
  const job = workflow.jobs?.[name];
  if (!job) throw new Error(`Missing workflow job: ${name}`);
  return job;
}

function requireStep(job: WorkflowJob, name: string): WorkflowStep {
  const step = job.steps?.find((candidate) => candidate.name === name);
  if (!step) throw new Error(`Missing workflow step: ${name}`);
  return step;
}

const deployJob = requireJob("deploy-app");
const deployStep = requireStep(deployJob, "Deploy to Cloudflare Pages");
const freshnessStep = requireStep(deployJob, "Verify Pages frontend freshness");
const authorityUpload = requireStep(
  deployJob,
  "Publish closed Pages deployment authority",
);
const deployedJob = requireJob("deployed-renderer-staging");
const authorityDownload = requireStep(
  deployedJob,
  "Download exact Pages deployment authority",
);
const preflightStep = requireStep(
  deployedJob,
  "Verify public deployment before browser auth",
);
const browserStep = requireStep(
  deployedJob,
  "Run deployed Personal identity, chat, and continuity trajectory",
);
const postflightStep = requireStep(
  deployedJob,
  "Verify public deployment after browser auth",
);
const combineStep = requireStep(deployedJob, "Close deployed renderer proof");
const receiptStep = requireStep(deployedJob, "Write deployed staging receipt");
const receiptUpload = requireStep(
  deployedJob,
  "Upload closed deployed staging receipt",
);

describe("Cloudflare deployed browser workflow contract", () => {
  test("closes the append-only Wrangler output before publishing authority", () => {
    expect(deployJob.outputs?.pages_deployed).toBe(
      "$" + "{{ steps.pages-deploy.outputs.deployed }}",
    );
    expect(deployStep.id).toBe("pages-deploy");
    expect(deployStep.run).toContain("WRANGLER_OUTPUT_FILE_PATH");
    expect(deployStep.run).toContain('chmod 600 "$wrangler_output"');
    expect(deployStep.run).toContain(': > "$wrangler_output"');
    expect(deployStep.run).toContain('--commit-hash="$GITHUB_SHA"');
    expect(deployStep.run).toContain("--commit-dirty=false");
    expect(deployStep.run).toContain('pages-deployment-authority.mjs" parse');
    expect(deployStep.run).toContain("--expected-environment preview");
    expect(deployStep.run).toContain("--expected-production-branch main");
    expect(deployStep.env?.PAGES_BRANCH).toBe(
      "$" + "{{ steps.pages.outputs.branch }}",
    );
    expect(deployStep.run).toContain('--expected-branch "$PAGES_BRANCH"');
    expect(deployStep.run).toContain("trap cleanup_wrangler_output EXIT");
    expect(deployStep.run).toContain('rm -f -- "$wrangler_output"');

    expect(authorityUpload.if).toContain(
      "inputs.target_environment == 'staging'",
    );
    expect(authorityUpload.with?.name).toBe(
      `pages-deployment-authority-${githubExpression("github.run_id")}-${githubExpression("github.run_attempt")}`,
    );
    expect(authorityUpload.with?.path).toBe(
      `${githubExpression("runner.temp")}/pages-deployment-authority/pages-deployment-authority.json`,
    );
    expect(authorityUpload.with?.["if-no-files-found"]).toBe("error");

    const uploadPaths = (deployJob.steps ?? [])
      .filter((step) => step.uses?.startsWith("actions/upload-artifact@"))
      .map((step) => step.with?.path ?? "")
      .join("\n");
    expect(uploadPaths).not.toContain("WRANGLER_OUTPUT_FILE_PATH");
    expect(uploadPaths).not.toContain("wrangler-output");
  });

  test("byte-verifies the canonical alias as well as the custom domains", () => {
    expect(freshnessStep.env?.PAGES_ALIAS).toBe(
      "$" + "{{ steps.pages-deploy.outputs.alias }}",
    );
    expect(freshnessStep.run).toContain(
      'served_frontends=("$MARKETING_URL" "$CLOUD_APP_URL")',
    );
    expect(freshnessStep.run).toContain('served_frontends+=("$PAGES_ALIAS")');
    expect(freshnessStep.run).toContain(
      `for served_url in "${shellExpansion("served_frontends[@]")}"`,
    );
    expect(freshnessStep.run).toContain("https://develop.eliza-app.pages.dev");
  });

  test("runs only after the staging deploy and public routing gates", () => {
    expect(deployedJob.needs).toEqual(["deploy-app", "verify-routing"]);
    expect(deployedJob.environment).toBe("staging");
    expect(deployedJob.if).toContain("inputs.target_environment == 'staging'");
    expect(deployedJob.if).toContain(
      "vars.ELIZA_CLOUD_STAGING_LIVE_READY == '1'",
    );
    expect(deployedJob.if).toContain(
      "needs.deploy-app.outputs.pages_deployed == 'true'",
    );
    expect(deployedJob.if).toContain(
      "needs.verify-routing.result == 'success'",
    );
    expect(authorityDownload.with?.name).toBe(
      `pages-deployment-authority-${githubExpression("github.run_id")}-${githubExpression("github.run_attempt")}`,
    );
  });

  test("keeps public probes secretless and exposes the key only to Chromium", () => {
    expect(preflightStep.env).toBeUndefined();
    expect(postflightStep.env).toBeUndefined();
    expect(preflightStep.run).toContain("--phase preflight");
    expect(postflightStep.run).toContain("--phase postflight");
    expect(postflightStep.if).toContain("always()");

    const secretSteps = (deployedJob.steps ?? []).filter((step) =>
      JSON.stringify(step.env ?? {}).includes("ELIZAOS_CLOUD_API_KEY"),
    );
    expect(secretSteps.map((step) => step.name)).toEqual([browserStep.name]);
    expect(deployedJob.env?.ELIZAOS_CLOUD_API_KEY).toBeUndefined();
    expect(browserStep.env?.ELIZAOS_CLOUD_API_KEY).toBe(
      "$" + "{{ secrets.ELIZAOS_CLOUD_API_KEY }}",
    );
    expect(browserStep.run).toContain(
      "--config playwright.cloud-deployed.config.ts",
    );
    expect(browserStep.run).not.toContain("webServer");
  });

  test("combines every strict observation before deriving receipt v3", () => {
    for (const input of [
      '--authority "$AUTHORITY_PATH"',
      '--preflight "$PREFLIGHT_PATH"',
      '--remote-smoke "$REMOTE_SMOKE_PATH"',
      '--latency "$LATENCY_PATH"',
      '--continuity "$CONTINUITY_PATH"',
      '--postflight "$POSTFLIGHT_PATH"',
    ]) {
      expect(combineStep.run).toContain(input);
    }
    expect(receiptStep.run).toContain(
      '--deployed-proof-file "$DEPLOYED_PROOF_PATH"',
    );
    expect(receiptStep.run).not.toContain("--deployed-renderer-verified");
    expect(receiptUpload.with?.name).toBe(
      `app-live-e2e-cloud-staging-deployed-${githubExpression("github.run_id")}-${githubExpression("github.run_attempt")}`,
    );
    expect(receiptUpload.with?.path).toBe(
      `${githubExpression("runner.temp")}/deployed-renderer-proof-${githubExpression("github.run_id")}-${githubExpression("github.run_attempt")}/cloud-staging-deployed-receipt.json`,
    );
    expect(receiptUpload.with?.["if-no-files-found"]).toBe("error");

    const deployedUploads = (deployedJob.steps ?? [])
      .filter((step) => step.uses?.startsWith("actions/upload-artifact@"))
      .map((step) => `${step.with?.name ?? ""}\n${step.with?.path ?? ""}`)
      .join("\n");
    expect(deployedUploads).not.toContain("playwright-report");
    expect(deployedUploads).not.toContain("REMOTE_SMOKE_PATH");
    expect(deployedUploads).not.toContain("DEPLOYED_PROOF_PATH");
  });

  test("hard-pins a no-retention, service-worker-free remote Chromium run", () => {
    expect(deployedConfig).toContain(
      'const DEPLOYED_RENDERER_ALIAS = "https://develop.eliza-app.pages.dev"',
    );
    expect(deployedConfig).toContain("workers: 1");
    expect(deployedConfig).toContain("retries: 0");
    expect(deployedConfig).toContain('serviceWorkers: "block"');
    expect(deployedConfig).toContain('trace: "off"');
    expect(deployedConfig).toContain('screenshot: "off"');
    expect(deployedConfig).toContain('video: "off"');
    expect(deployedConfig).toContain('name: "chromium"');
    expect(deployedConfig).not.toContain("webServer:");

    expect(smokeSpec).toContain("ELIZA_UI_SMOKE_DEPLOYED_RENDERER");
    expect(smokeSpec).toContain("cloudflare-pages-alias");
    expect(smokeSpec).toContain("elizaos.renderer.build/v1");
    expect(smokeSpec).toContain("https://develop.eliza-app.pages.dev");
  });

  test("verifies the top-level Pages document before handing it the bearer", () => {
    expect(smokeSpec).toContain("if (!DEPLOYED_RENDERER_ENABLED)");
    expect(smokeSpec).toContain("resolveCloudLiveBrowserAuthSeed(process.env)");
    expect(smokeSpec).toContain("window.top !== window");
    expect(smokeSpec).toContain("window.location.origin !== expectedOrigin");

    const openStart = smokeSpec.indexOf(
      "async function openProtectedCloudBlankStart",
    );
    const navigation = smokeSpec.indexOf(
      'await page.goto("/", { waitUntil: "domcontentloaded" });',
      openStart,
    );
    const publicIdentity = smokeSpec.indexOf(
      "await requireDeployedRendererIdentity(page, baseURL)",
      navigation,
    );
    const cloudOrigin = smokeSpec.indexOf(
      "await requireRendererCloudApiOrigin(",
      publicIdentity,
    );
    const bearerHandoff = smokeSpec.indexOf(
      "await seedVerifiedDeployedCloudBrowserAuth(page)",
      cloudOrigin,
    );
    expect(openStart).toBeGreaterThan(0);
    expect(navigation).toBeGreaterThan(openStart);
    expect(publicIdentity).toBeGreaterThan(navigation);
    expect(cloudOrigin).toBeGreaterThan(publicIdentity);
    expect(bearerHandoff).toBeGreaterThan(cloudOrigin);
    expect(
      smokeSpec.match(/await requireRendererCloudApiOrigin\(/g),
    ).toHaveLength(2);
  });
});
