/**
 * Fail-closed deployment contracts for realtime voice promotion.
 * Provider and bridge credentials must exist before a Worker advertising the
 * feature can deploy, while production may never inherit the staging Cloud key
 * as an implicit service authorization. Each protected GitHub environment owns
 * its Worker and renderer flag; production remains off until its dedicated
 * provider, bridge, voice, and endpoint configuration is complete.
 */
import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "../lib/spawn-sync-captured.mjs";

const repoRoot = new URL("../../../", import.meta.url);
const cloudApiDirectory = fileURLToPath(
  new URL("packages/cloud/api/", repoRoot),
);

function read(path: string): string {
  return readFileSync(new URL(path, repoRoot), "utf8");
}

interface WorkflowStep {
  name?: string;
  env?: Record<string, string>;
  run?: string;
}

interface WorkflowJob {
  environment?: string;
  steps?: WorkflowStep[];
}

interface Workflow {
  jobs?: Record<string, WorkflowJob>;
}

const workflowSource = read(".github/workflows/cloud-cf-deploy.yml");
const workflow = Bun.YAML.parse(workflowSource) as Workflow;
const publishStep = workflow.jobs?.["deploy-api"]?.steps?.find(
  (step) => step.name === "Publish Worker AI secrets",
);
const deployStep = workflow.jobs?.["deploy-api"]?.steps?.find(
  (step) => step.name === "Deploy to Cloudflare Workers",
);

if (!publishStep?.run) {
  throw new Error("Missing Publish Worker AI secrets workflow step");
}
if (!deployStep?.run) {
  throw new Error("Missing Deploy to Cloudflare Workers workflow step");
}

const preflight = publishStep.run.slice(
  0,
  publishStep.run.indexOf("# The Worker is the gateway"),
);

function sliceBetween(
  source: string,
  startMarker: string,
  endMarker: string,
): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) {
    throw new Error(
      `Missing workflow shell markers: ${startMarker} -> ${endMarker}`,
    );
  }
  return source.slice(start, end);
}

const shellHelpers = sliceBetween(
  publishStep.run,
  "has_nonblank_value() {",
  "# Construct the staging fallback",
);
const secretMutationFunctions = sliceBetween(
  publishStep.run,
  "publish_secret() {",
  "# The dedicated credential authorizes the internal shared-agent",
);
const realtimeDisableTransition = sliceBetween(
  publishStep.run,
  "# The dedicated credential authorizes the internal shared-agent",
  "# QA cutover is OFF-FIRST",
);

function runPreflight(env: Record<string, string>) {
  return spawnSync("/bin/bash", ["-e", "-o", "pipefail", "-c", preflight], {
    cwd: cloudApiDirectory,
    encoding: "utf8",
    env: {
      ...process.env,
      DEPLOY_ENVIRONMENT: "staging",
      DEEPGRAM_API_KEY: "deepgram-test",
      CARTESIA_API_KEY: "cartesia-test",
      FISH_AUDIO_API_KEY: "fish-test",
      FISH_AUDIO_REFERENCE_ID: "fish-reference-test",
      ELIZA_TTS_FISH_ENABLED: "false",
      FISH_AUDIO_DATA_GOVERNANCE_APPROVED: "false",
      FISH_AUDIO_MODEL: "s2.1-pro",
      FISH_AUDIO_SAMPLE_RATE: "16000",
      FISH_AUDIO_FIRST_AUDIO_TIMEOUT_MS: "1500",
      VOICE_REALTIME_ELIZA_AUTHORIZATION: "Bearer dedicated-test",
      VOICE_REALTIME_WS_ENABLED: "false",
      STAGING_ELIZACLOUD_API_KEY: "",
      PRODUCTION_REALTIME_CARTESIA_VOICE_ID: "",
      PRODUCTION_REALTIME_ELIZA_ENDPOINT: "",
      ...env,
    },
  });
}

interface PreflightResult {
  status: number | null;
  stderr: string;
  stdout: string;
}

function expectSuccessfulPreflight(result: PreflightResult) {
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  expect(result.stderr).toBe("");
}

describe("Cloud CF realtime voice deploy contract", () => {
  test("never builds a Bearer header in the GitHub expression layer", () => {
    expect(publishStep.env?.VOICE_REALTIME_ELIZA_AUTHORIZATION).toBe(
      "$" + "{{ secrets.VOICE_REALTIME_ELIZA_AUTHORIZATION }}",
    );
    expect(publishStep.env?.STAGING_ELIZACLOUD_API_KEY).toBe(
      "$" +
        "{{ steps.env.outputs.deploy_environment == 'staging' && secrets.ELIZACLOUD_API_KEY || '' }}",
    );
    expect(workflowSource).not.toContain("format('Bearer {0}'");
  });

  test("gates realtime secret publication behind explicit opt-in", () => {
    expect(publishStep.run).toContain(
      "is gated by VOICE_REALTIME_WS_ENABLED; skipping",
    );
    expect(publishStep.run).toContain(
      "CARTESIA_API_KEY|VOICE_REALTIME_ELIZA_AUTHORIZATION",
    );
    expect(publishStep.run).toContain(
      "is gated by VOICE_BATCH_STT_PROVIDER=deepgram; skipping",
    );
    expect(publishStep.run).toContain(
      "FISH_AUDIO_API_KEY|FISH_AUDIO_REFERENCE_ID",
    );
    expect(publishStep.run).toContain(
      "is gated by realtime voice, Fish enablement, and data-governance approval; skipping",
    );
  });

  test("removes disabled realtime bridge authority before deploying the false runtime flag", () => {
    const stateDirectory = mkdtempSync(
      path.join(tmpdir(), "eliza-voice-secret-transition-"),
    );
    const authorizationSecret = path.join(
      stateDirectory,
      "VOICE_REALTIME_ELIZA_AUTHORIZATION",
    );
    const mutationLog = path.join(stateDirectory, "wrangler.log");
    writeFileSync(authorizationSecret, "previously-published");

    try {
      const mutationHarness = `
bunx() {
  printf '%s\\n' "$*" >> "$VOICE_TEST_MUTATION_LOG"
  if [ "$1" = "wrangler" ] && [ "$2" = "secret" ] && [ "$3" = "delete" ]; then
    rm -f "$VOICE_TEST_STATE_DIRECTORY/$4"
  fi
}
${shellHelpers}
${secretMutationFunctions.replaceAll("$" + "{{ steps.env.outputs.wrangler_args }}", "--env production")}
${realtimeDisableTransition}
`;
      const result = spawnSync(
        "/bin/bash",
        ["-e", "-o", "pipefail", "-c", mutationHarness],
        {
          cwd: cloudApiDirectory,
          encoding: "utf8",
          env: {
            ...process.env,
            VOICE_REALTIME_WS_ENABLED: "false",
            VOICE_REALTIME_ELIZA_AUTHORIZATION: "Bearer previously-live",
            VOICE_TEST_MUTATION_LOG: mutationLog,
            VOICE_TEST_STATE_DIRECTORY: stateDirectory,
          },
        },
      );

      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      expect(result.stderr).toBe("");
      expect(existsSync(authorizationSecret)).toBe(false);
      expect(readFileSync(mutationLog, "utf8")).toContain(
        "wrangler secret delete VOICE_REALTIME_ELIZA_AUTHORIZATION --env production",
      );

      const steps = workflow.jobs?.["deploy-api"]?.steps ?? [];
      const publishIndex = steps.findIndex(
        (step) => step.name === "Publish Worker AI secrets",
      );
      const deployIndex = steps.findIndex(
        (step) => step.name === "Deploy to Cloudflare Workers",
      );
      expect(publishIndex).toBeGreaterThanOrEqual(0);
      expect(publishIndex).toBeLessThan(deployIndex);
      expect(deployStep.run).toContain(
        '--var VOICE_REALTIME_WS_ENABLED:"$VOICE_REALTIME_WS_ENABLED"',
      );
    } finally {
      rmSync(stateDirectory, { recursive: true, force: true });
    }
  });

  test("passes a production-off Fish opt-in and exact realtime format to the Worker", () => {
    const fishFlag = deployStep.env?.ELIZA_TTS_FISH_ENABLED;
    expect(fishFlag).toBe(publishStep.env?.ELIZA_TTS_FISH_ENABLED);
    expect(fishFlag).toContain("steps.env.outputs.deploy_environment");
    expect(fishFlag).toContain("!= 'production'");
    expect(fishFlag).toContain("vars.ELIZA_TTS_FISH_ENABLED");
    expect(deployStep.env?.FISH_AUDIO_SAMPLE_RATE).toBe("16000");
    expect(deployStep.run).toContain(
      '--var ELIZA_TTS_FISH_ENABLED:"$ELIZA_TTS_FISH_ENABLED"',
    );
    expect(deployStep.env?.FISH_AUDIO_DATA_GOVERNANCE_APPROVED).toBe(
      publishStep.env?.FISH_AUDIO_DATA_GOVERNANCE_APPROVED,
    );
    expect(deployStep.run).toContain(
      '--var FISH_AUDIO_DATA_GOVERNANCE_APPROVED:"$FISH_AUDIO_DATA_GOVERNANCE_APPROVED"',
    );
    expect(deployStep.run).toContain(
      '--var FISH_AUDIO_SAMPLE_RATE:"$FISH_AUDIO_SAMPLE_RATE"',
    );
  });

  test("keeps direct production deploys off while managed deploys use the protected environment opt-in", () => {
    const wrangler = read("packages/cloud/api/wrangler.toml");
    const stagingVars = wrangler.slice(
      wrangler.indexOf("[env.staging.vars]"),
      wrangler.indexOf("[env.production.vars]"),
    );
    const productionVars = wrangler.slice(
      wrangler.indexOf("[env.production.vars]"),
    );
    // Staging realtime is intentionally ON (#16809: toml aligned with the live
    // staging worker); production remains explicitly off until its own gated flip.
    expect(stagingVars).toContain('VOICE_REALTIME_WS_ENABLED = "true"');
    expect(productionVars).toContain('VOICE_REALTIME_WS_ENABLED = "false"');
    expect(stagingVars).toContain('ELIZA_TTS_FISH_ENABLED = "false"');
    expect(productionVars).toContain('ELIZA_TTS_FISH_ENABLED = "false"');
    expect(stagingVars).toContain(
      'FISH_AUDIO_DATA_GOVERNANCE_APPROVED = "false"',
    );
    expect(productionVars).toContain(
      'FISH_AUDIO_DATA_GOVERNANCE_APPROVED = "false"',
    );
    expect(publishStep.env?.VOICE_REALTIME_WS_ENABLED).toContain(
      "vars.VOICE_REALTIME_WS_ENABLED",
    );
    expect(publishStep.env?.VOICE_REALTIME_WS_ENABLED).not.toContain(
      "deploy_environment != 'production'",
    );
    expect(productionVars).not.toContain("VOICE_REALTIME_CARTESIA_VOICE_ID");
    expect(productionVars).not.toContain("VOICE_REALTIME_ELIZA_ENDPOINT");
    expect(publishStep.env?.PRODUCTION_REALTIME_CARTESIA_VOICE_ID).toContain(
      "vars.ELIZA_VOICE_CARTESIA_VOICE_ID",
    );
    expect(publishStep.env?.PRODUCTION_REALTIME_ELIZA_ENDPOINT).toContain(
      "vars.VOICE_REALTIME_ELIZA_ENDPOINT",
    );
    expect(publishStep.run).not.toContain("PRODUCTION_REALTIME_WS_ENABLED");
    expect(wrangler).not.toContain("VOICE_AMBIENT_ENABLED");
    expect(wrangler).not.toContain("VOICE_AMBIENT_PENDANT_BASE_URL");
  });

  test("deploy Worker passes the same fail-closed runtime realtime opt-in as secrets", () => {
    const runtimeFlag = deployStep.env?.VOICE_REALTIME_WS_ENABLED;
    expect(runtimeFlag).toBe(publishStep.env?.VOICE_REALTIME_WS_ENABLED);
    expect(runtimeFlag).toContain("vars.VOICE_REALTIME_WS_ENABLED");
    expect(runtimeFlag).toContain("&& 'true' || 'false'");
    expect(deployStep.run).toContain(
      '--var VOICE_REALTIME_WS_ENABLED:"$VOICE_REALTIME_WS_ENABLED"',
    );
  });

  test("runtime realtime override stays default-off and production-safe across Worker and frontend", () => {
    const wrangler = read("packages/cloud/api/wrangler.toml");
    const stagingVars = wrangler.slice(
      wrangler.indexOf("[env.staging.vars]"),
      wrangler.indexOf("[env.production.vars]"),
    );
    const productionVars = wrangler.slice(
      wrangler.indexOf("[env.production.vars]"),
    );
    // Staging is intentionally on (#16809); the production-safe invariant is
    // that production's own var stays "false".
    expect(stagingVars).toContain('VOICE_REALTIME_WS_ENABLED = "true"');
    expect(productionVars).toContain('VOICE_REALTIME_WS_ENABLED = "false"');
    expect(deployStep.env?.VOICE_REALTIME_WS_ENABLED).toBe(
      publishStep.env?.VOICE_REALTIME_WS_ENABLED,
    );
    expect(deployStep.env?.PRODUCTION_REALTIME_CARTESIA_VOICE_ID).toBe(
      publishStep.env?.PRODUCTION_REALTIME_CARTESIA_VOICE_ID,
    );
    expect(deployStep.env?.PRODUCTION_REALTIME_ELIZA_ENDPOINT).toBe(
      publishStep.env?.PRODUCTION_REALTIME_ELIZA_ENDPOINT,
    );
    expect(deployStep.env?.VOICE_REALTIME_WS_ENABLED).toContain(
      "&& 'true' || 'false'",
    );

    const frontendRealtimeFlags = workflowSource.match(
      /VITE_VOICE_REALTIME_WS: \$\{\{[^}]*vars\.VOICE_REALTIME_WS_ENABLED[^}]*&& '1' \|\| '0' \}\}/g,
    );
    expect(frontendRealtimeFlags?.length).toBeGreaterThanOrEqual(2);
    for (const flag of frontendRealtimeFlags ?? []) {
      expect(flag).toContain("vars.VOICE_REALTIME_WS_ENABLED");
      expect(flag).not.toContain("inputs.environment == 'production'");
      expect(flag).not.toContain("github.ref == 'refs/heads/main'");
    }
    const deployEnvironment = workflow.jobs?.["deploy-api"]?.environment;
    expect(deployEnvironment).toContain("inputs.environment == 'production'");
    expect(deployEnvironment).toContain("github.ref == 'refs/heads/main'");
    for (const jobName of ["build-pages", "deploy-console", "deploy-app"]) {
      expect(workflow.jobs?.[jobName]?.environment).toBe(deployEnvironment);
    }
    const previewWorkflow = read(
      ".github/workflows/cloud-cf-pr-preview-deploy.yml",
    );
    expect(previewWorkflow).toContain(
      "github.event.workflow_run.head_repository.full_name == github.repository",
    );
    expect(workflowSource).toContain(
      "readback must confirm intended source-owned PR merge refs are admitted",
    );
    expect(deployStep.run).toContain(
      '--var VOICE_REALTIME_CARTESIA_VOICE_ID:"$PRODUCTION_REALTIME_CARTESIA_VOICE_ID"',
    );
    expect(deployStep.run).toContain(
      '--var VOICE_REALTIME_ELIZA_ENDPOINT:"$PRODUCTION_REALTIME_ELIZA_ENDPOINT"',
    );
  });

  test("every GitHub expression in the deploy workflow has balanced parentheses", () => {
    // A stray `)` inside `${{ ... }}` makes the whole workflow unparseable at
    // the GitHub layer (instant run failure with zero jobs) while remaining
    // invisible to the substring/regex assertions above. Balance-check every
    // expression so the parse error fails HERE, in a reviewable unit test.
    const expressions = workflowSource.match(/\$\{\{[\s\S]*?\}\}/g) ?? [];
    expect(expressions.length).toBeGreaterThan(0);
    for (const expression of expressions) {
      let depth = 0;
      for (const ch of expression) {
        if (ch === "(") depth += 1;
        if (ch === ")") depth -= 1;
        expect(depth).toBeGreaterThanOrEqual(0);
      }
      expect(depth).toBe(0);
    }
  });
});

describe("Cloud CF realtime voice deploy preflight (executed verbatim)", () => {
  test("does not require realtime secrets when staging opt-in is absent", () => {
    const result = runPreflight({
      DEEPGRAM_API_KEY: "",
      CARTESIA_API_KEY: "",
      VOICE_REALTIME_ELIZA_AUTHORIZATION: "",
      STAGING_ELIZACLOUD_API_KEY: "repo-key-must-not-be-used",
      VOICE_REALTIME_WS_ENABLED: "false",
    });
    expectSuccessfulPreflight(result);
    expect(result.stdout).not.toContain("Bearer repo-key-must-not-be-used");
  });

  test("requires every realtime provider and bridge secret in opted-in staging", () => {
    for (const missing of [
      "CARTESIA_API_KEY",
      "VOICE_REALTIME_ELIZA_AUTHORIZATION",
    ]) {
      const result = runPreflight({
        [missing]: " \t\n",
        STAGING_ELIZACLOUD_API_KEY: "",
        VOICE_REALTIME_WS_ENABLED: "true",
      });
      expect(
        result.status,
        `${missing}: ${result.stdout}${result.stderr}`,
      ).toBe(1);
      expect(result.stdout).toContain(missing);
    }
  });

  test("requires Fish credentials and exact provider configuration only after Fish opt-in", () => {
    for (const missing of ["FISH_AUDIO_API_KEY", "FISH_AUDIO_REFERENCE_ID"]) {
      const result = runPreflight({
        [missing]: " \t\n",
        ELIZA_TTS_FISH_ENABLED: "true",
        FISH_AUDIO_DATA_GOVERNANCE_APPROVED: "true",
        VOICE_REALTIME_WS_ENABLED: "true",
      });
      expect(
        result.status,
        `${missing}: ${result.stdout}${result.stderr}`,
      ).toBe(1);
      expect(result.stdout).toContain(missing);
    }

    for (const invalid of [
      { FISH_AUDIO_MODEL: "s2.1" },
      { FISH_AUDIO_SAMPLE_RATE: "24000" },
    ]) {
      const result = runPreflight({
        ...invalid,
        ELIZA_TTS_FISH_ENABLED: "true",
        FISH_AUDIO_DATA_GOVERNANCE_APPROVED: "true",
        VOICE_REALTIME_WS_ENABLED: "true",
      });
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(1);
    }

    const configured = runPreflight({
      ELIZA_TTS_FISH_ENABLED: "true",
      FISH_AUDIO_DATA_GOVERNANCE_APPROVED: "true",
      VOICE_REALTIME_WS_ENABLED: "true",
    });
    expectSuccessfulPreflight(configured);
  });

  test("refuses Fish promotion without explicit data-governance approval", () => {
    const result = runPreflight({
      ELIZA_TTS_FISH_ENABLED: "true",
      FISH_AUDIO_DATA_GOVERNANCE_APPROVED: "false",
      VOICE_REALTIME_WS_ENABLED: "true",
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("FISH_AUDIO_DATA_GOVERNANCE_APPROVED");
  });

  test("constructs the staging fallback only after truthy opt-in and a nonblank source key", () => {
    const configured = spawnSync(
      "/bin/bash",
      [
        "-e",
        "-o",
        "pipefail",
        "-c",
        `${preflight}\nprintf '<%s>' "$VOICE_REALTIME_ELIZA_AUTHORIZATION"`,
      ],
      {
        cwd: cloudApiDirectory,
        encoding: "utf8",
        env: {
          ...process.env,
          DEPLOY_ENVIRONMENT: "staging",
          DEEPGRAM_API_KEY: "deepgram-test",
          CARTESIA_API_KEY: "cartesia-test",
          VOICE_REALTIME_WS_ENABLED: "true",
          VOICE_REALTIME_ELIZA_AUTHORIZATION: "",
          STAGING_ELIZACLOUD_API_KEY: "stage-cloud-key",
        },
      },
    );
    expectSuccessfulPreflight(configured);
    expect(configured.stdout).toBe("<Bearer stage-cloud-key>");

    const empty = runPreflight({
      VOICE_REALTIME_ELIZA_AUTHORIZATION: "",
      STAGING_ELIZACLOUD_API_KEY: " \t\n",
      VOICE_REALTIME_WS_ENABLED: "true",
    });
    expect(empty.status).toBe(1);
    expect(empty.stdout).not.toContain("Bearer ");
  });

  test("keeps disabled production deployable but fails a future enable without dedicated secrets", () => {
    const disabled = runPreflight({
      DEPLOY_ENVIRONMENT: "production",
      DEEPGRAM_API_KEY: "",
      CARTESIA_API_KEY: "",
      VOICE_REALTIME_ELIZA_AUTHORIZATION: "",
      STAGING_ELIZACLOUD_API_KEY: "repo-key-must-not-be-used",
    });
    expectSuccessfulPreflight(disabled);
    expect(disabled.stdout).not.toContain("Bearer repo-key-must-not-be-used");

    const missingDedicated = runPreflight({
      DEPLOY_ENVIRONMENT: "production",
      VOICE_REALTIME_WS_ENABLED: "true",
      DEEPGRAM_API_KEY: "",
      CEREBRAS_API_KEY: "",
      CARTESIA_API_KEY: "",
      VOICE_REALTIME_ELIZA_AUTHORIZATION: "",
      STAGING_ELIZACLOUD_API_KEY: "repo-key-must-not-be-used",
    });
    expect(missingDedicated.status).toBe(1);
    expect(missingDedicated.stdout).toContain(
      "Production realtime voice is enabled",
    );
    expect(missingDedicated.stdout).not.toContain("DEEPGRAM_API_KEY");
    expect(missingDedicated.stdout).toContain("CEREBRAS_API_KEY");
    expect(missingDedicated.stdout).toContain("CARTESIA_API_KEY");
    expect(missingDedicated.stdout).toContain(
      "VOICE_REALTIME_ELIZA_AUTHORIZATION",
    );
    expect(missingDedicated.stdout).toContain(
      "PRODUCTION_REALTIME_CARTESIA_VOICE_ID",
    );
    expect(missingDedicated.stdout).toContain(
      "PRODUCTION_REALTIME_ELIZA_ENDPOINT",
    );

    const configured = runPreflight({
      DEPLOY_ENVIRONMENT: "production",
      VOICE_REALTIME_WS_ENABLED: "true",
      CEREBRAS_API_KEY: "cerebras-production",
      CARTESIA_API_KEY: "cartesia-production",
      VOICE_REALTIME_ELIZA_AUTHORIZATION: "Bearer production-dedicated",
      PRODUCTION_REALTIME_CARTESIA_VOICE_ID:
        "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4",
      PRODUCTION_REALTIME_ELIZA_ENDPOINT: "https://api.elizacloud.ai",
      STAGING_ELIZACLOUD_API_KEY: "repo-key-must-not-be-used",
    });
    expectSuccessfulPreflight(configured);
  });

  test("rejects malformed production voice routing before publishing secrets", () => {
    const valid = {
      DEPLOY_ENVIRONMENT: "production",
      VOICE_REALTIME_WS_ENABLED: "true",
      CEREBRAS_API_KEY: "cerebras-production",
      CARTESIA_API_KEY: "cartesia-production",
      VOICE_REALTIME_ELIZA_AUTHORIZATION: "Bearer production-dedicated",
      PRODUCTION_REALTIME_CARTESIA_VOICE_ID:
        "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4",
      PRODUCTION_REALTIME_ELIZA_ENDPOINT: "https://api.elizacloud.ai",
    };
    for (const invalid of [
      { VOICE_REALTIME_ELIZA_AUTHORIZATION: "production-dedicated" },
      { VOICE_REALTIME_ELIZA_AUTHORIZATION: "Bearer production-dedicated " },
      {
        VOICE_REALTIME_ELIZA_AUTHORIZATION:
          "Bearer production-dedicated\nsecond-line",
      },
      { PRODUCTION_REALTIME_CARTESIA_VOICE_ID: "not-a-uuid" },
      {
        PRODUCTION_REALTIME_ELIZA_ENDPOINT: "https://api-staging.elizacloud.ai",
      },
      {
        PRODUCTION_REALTIME_ELIZA_ENDPOINT:
          "https://api.elizacloud.ai/api/v1/chat/completions",
      },
    ]) {
      const result = runPreflight({ ...valid, ...invalid });
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(1);
    }
  });
});
