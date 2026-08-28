/**
 * Fail-closed deployment contracts for realtime voice across staging and
 * production. Staging requires explicit credentials when opted in; production
 * stays enabled for phone and app voice while preserving and verifying the
 * dedicated provider and bridge bindings already managed on the Worker.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolveGnuBash } from "../lib/gnu-shell.mjs";
import { spawnSync } from "../lib/spawn-sync-captured.mjs";

const repoRoot = new URL("../../../", import.meta.url);

function read(path: string): string {
  return readFileSync(new URL(path, repoRoot), "utf8");
}

interface WorkflowStep {
  name?: string;
  env?: Record<string, string>;
  run?: string;
}

interface Workflow {
  jobs?: Record<string, { if?: string; steps?: WorkflowStep[] }>;
}

// The Worker and frontend builds live in the reusable release workflow that
// `cloud-cf-deploy.yml` calls after admission. The dispatch-only entry workflow
// is still read so no expression in either file escapes the balance contract.
const entrySource = read(".github/workflows/cloud-cf-deploy.yml");
const workflowSource = read(".github/workflows/cloud-cf-release.yml");
const workflow = Bun.YAML.parse(workflowSource) as Workflow;
const publishStep = workflow.jobs?.["deploy-api"]?.steps?.find(
  (step) => step.name === "Prepare Worker secrets for atomic deploy",
);
const deployStep = workflow.jobs?.["deploy-api"]?.steps?.find(
  (step) => step.name === "Deploy to Cloudflare Workers",
);
const verifyBindingsStep = workflow.jobs?.["deploy-api"]?.steps?.find(
  (step) => step.name === "Verify required Worker secret binding names",
);

if (!publishStep?.run) {
  throw new Error("Missing atomic Worker secret preparation workflow step");
}
if (!deployStep?.run) {
  throw new Error("Missing Deploy to Cloudflare Workers workflow step");
}
if (!verifyBindingsStep?.run) {
  throw new Error("Missing Worker binding verification workflow step");
}

const preflight = publishStep.run.slice(
  0,
  publishStep.run.indexOf("# The Worker is the gateway"),
);
const shellHelpers = publishStep.run.slice(
  0,
  publishStep.run.indexOf("# Construct the staging fallback"),
);
const productionVoiceCandidateFunction = publishStep.run
  .slice(
    publishStep.run.indexOf("verify_production_voice_secret_candidates() {"),
    publishStep.run.indexOf("# Like queue_secret"),
  )
  .replaceAll("$" + "{{ steps.env.outputs.wrangler_args }}", "");

// The executed cases run the workflow's VERBATIM preflight bash, which uses
// bash >= 4 `${1,,}` lowercasing (GitHub's Linux runners). macOS /bin/bash 3.2
// aborts on that expansion with "bad substitution", zeroing every gate the
// snippet enforces — so the executed cases only run where a modern bash
// resolves (Linux natively; macOS via `brew install bash`) and skip otherwise.
// The static expression-layer and wrangler assertions still run everywhere.
const GNU_BASH = resolveGnuBash();

function requirePreflightBash(): string {
  if (!GNU_BASH) {
    throw new Error(
      "preflight execution requires bash >= 4 (lowercase parameter expansion); install GNU bash",
    );
  }
  return GNU_BASH;
}

function runPreflight(env: Record<string, string>, after = "") {
  return spawnSync(requirePreflightBash(), ["-c", `${preflight}\n${after}`], {
    cwd: new URL("packages/cloud/api/", repoRoot).pathname,
    encoding: "utf8",
    env: {
      ...process.env,
      DEPLOY_ENVIRONMENT: "staging",
      DEEPGRAM_API_KEY: "deepgram-test",
      CARTESIA_API_KEY: "cartesia-test",
      CARTESIA_STT_USD_PER_CREDIT: "0.00005",
      CARTESIA_BATCH_STT_TIMEOUT_MS: "120000",
      FISH_AUDIO_API_KEY: "fish-test",
      FISH_AUDIO_REFERENCE_ID: "fish-reference-test",
      ELIZA_TTS_FISH_ENABLED: "false",
      FISH_AUDIO_DATA_GOVERNANCE_APPROVED: "false",
      FISH_AUDIO_MODEL: "s2.1-pro",
      FISH_AUDIO_SAMPLE_RATE: "16000",
      FISH_AUDIO_FIRST_AUDIO_TIMEOUT_MS: "1500",
      VOICE_REALTIME_ELIZA_AUTHORIZATION: "Bearer dedicated-test",
      VOICE_REALTIME_WS_ENABLED: "false",
      VOICE_BATCH_STT_PROVIDER: "",
      STAGING_ELIZACLOUD_API_KEY: "",
      ...env,
    },
  });
}

function runProductionVoiceCandidateCheck(
  existingNames: string[],
  queuedNames: string[],
) {
  const script = `${shellHelpers}
bunx() {
  if [[ "$1" == wrangler* && "$2" == "secret" && "$3" == "list" ]]; then
    printf '%s' '${JSON.stringify(existingNames.map((name) => ({ name })))}'
    return 0
  fi
  return 1
}
DEPLOY_ENVIRONMENT=production
VOICE_REALTIME_WS_ENABLED=true
worker_secret_names=(${queuedNames.map((name) => JSON.stringify(name)).join(" ")})
${productionVoiceCandidateFunction}
verify_production_voice_secret_candidates
`;
  return spawnSync(requirePreflightBash(), ["-c", script], {
    encoding: "utf8",
    env: process.env,
  });
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
    expect(entrySource).not.toContain("format('Bearer {0}'");
  });

  test("gates realtime secret publication behind explicit opt-in", () => {
    expect(publishStep.run).toContain(
      "is gated by VOICE_REALTIME_WS_ENABLED; skipping",
    );
    expect(publishStep.run).toContain(
      "realtime voice or VOICE_BATCH_STT_PROVIDER=cartesia",
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

  test("publishes deployment-owned Cartesia batch billing and timeout config", () => {
    expect(publishStep.env?.CARTESIA_STT_USD_PER_CREDIT).toBe(
      "$" + "{{ vars.CARTESIA_STT_USD_PER_CREDIT }}",
    );
    expect(publishStep.env?.CARTESIA_BATCH_STT_TIMEOUT_MS).toBe(
      "$" + "{{ vars.CARTESIA_BATCH_STT_TIMEOUT_MS }}",
    );
    expect(publishStep.run).toContain("CARTESIA_STT_USD_PER_CREDIT");
    expect(publishStep.run).toContain("CARTESIA_BATCH_STT_TIMEOUT_MS");
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

  test("keeps production realtime enabled and verifies managed secret bindings", () => {
    const wrangler = read("packages/cloud/api/wrangler.toml");
    expect(wrangler).toMatch(/^keep_vars = true$/m);
    const stagingVars = wrangler.slice(
      wrangler.indexOf("[env.staging.vars]"),
      wrangler.indexOf("[env.production.vars]"),
    );
    const productionVars = wrangler.slice(
      wrangler.indexOf("[env.production.vars]"),
    );
    // Both deployed environments intentionally serve realtime voice. Staging
    // still requires its repository opt-in; production is pinned on.
    expect(stagingVars).toContain('VOICE_REALTIME_WS_ENABLED = "true"');
    expect(productionVars).toContain('VOICE_REALTIME_WS_ENABLED = "true"');
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
    expect(publishStep.env?.VOICE_REALTIME_WS_ENABLED).toContain(
      "deploy_environment == 'production'",
    );
    expect(productionVars).not.toContain("VOICE_REALTIME_CARTESIA_VOICE_ID");
    expect(productionVars).not.toContain("VOICE_REALTIME_ELIZA_ENDPOINT");
    expect(verifyBindingsStep.run).toContain(
      '"VOICE_REALTIME_CARTESIA_VOICE_ID"',
    );
    expect(verifyBindingsStep.run).toContain('"VOICE_REALTIME_ELIZA_ENDPOINT"');
    expect(verifyBindingsStep.run).toContain(
      'process.env.DEPLOY_ENVIRONMENT === "production"',
    );
    expect(verifyBindingsStep.run).toContain(
      'process.env.VOICE_REALTIME_WS_ENABLED === "true"',
    );
    expect(publishStep.run).toContain(
      "verify_production_voice_secret_candidates || exit 1",
    );
    expect(publishStep.run).toContain(
      "missing existing or configured Worker binding name(s)",
    );
    expect(deployStep.run).toContain('--secrets-file "$WORKER_SECRETS_FILE"');
    expect(wrangler).not.toContain("VOICE_AMBIENT_ENABLED");
    expect(wrangler).not.toContain("VOICE_AMBIENT_PENDANT_BASE_URL");
  });

  test("deploy Worker passes the same fail-closed runtime realtime opt-in as secrets", () => {
    const runtimeFlag = deployStep.env?.VOICE_REALTIME_WS_ENABLED;
    expect(runtimeFlag).toBe(publishStep.env?.VOICE_REALTIME_WS_ENABLED);
    expect(runtimeFlag).toContain("steps.env.outputs.deploy_environment");
    expect(runtimeFlag).toContain("== 'production'");
    expect(runtimeFlag).toContain("vars.VOICE_REALTIME_WS_ENABLED");
    expect(runtimeFlag).toContain("&& 'true' || 'false'");
    expect(deployStep.run).toContain(
      '--var VOICE_REALTIME_WS_ENABLED:"$VOICE_REALTIME_WS_ENABLED"',
    );
  });

  test("runtime and frontend realtime stay enabled in production", () => {
    const wrangler = read("packages/cloud/api/wrangler.toml");
    const stagingVars = wrangler.slice(
      wrangler.indexOf("[env.staging.vars]"),
      wrangler.indexOf("[env.production.vars]"),
    );
    const productionVars = wrangler.slice(
      wrangler.indexOf("[env.production.vars]"),
    );
    // Staging and production both intentionally serve realtime voice.
    expect(stagingVars).toContain('VOICE_REALTIME_WS_ENABLED = "true"');
    expect(productionVars).toContain('VOICE_REALTIME_WS_ENABLED = "true"');
    expect(deployStep.env?.VOICE_REALTIME_WS_ENABLED).toBe(
      publishStep.env?.VOICE_REALTIME_WS_ENABLED,
    );
    expect(deployStep.env?.VOICE_REALTIME_WS_ENABLED).toContain(
      "&& 'true' || 'false'",
    );

    // Canonical production builds pin the voice UI on. Staging releases use the
    // repository variable through the same reusable build path.
    const flagPattern =
      /VITE_VOICE_REALTIME_WS: \$\{\{[^}]*vars\.VOICE_REALTIME_WS_ENABLED[^}]*&& '1' \|\| '0' \}\}/g;
    const releaseRealtimeFlags = workflowSource.match(flagPattern) ?? [];
    expect(releaseRealtimeFlags.length).toBeGreaterThanOrEqual(1);
    for (const flag of releaseRealtimeFlags) {
      expect(flag).toContain("inputs.target_environment == 'production'");
      expect(flag).toContain("|| contains");
      expect(flag).toContain("vars.VOICE_REALTIME_WS_ENABLED");
    }

    expect(entrySource).not.toContain("Build consolidated frontend artifact");
    expect(entrySource).not.toContain("VITE_VOICE_REALTIME_WS:");
    expect(entrySource).toContain(
      "uses: ./.github/workflows/cloud-cf-release.yml",
    );
  });

  test("every GitHub expression in the deploy workflow has balanced parentheses", () => {
    // A stray `)` inside `${{ ... }}` makes the whole workflow unparseable at
    // the GitHub layer (instant run failure with zero jobs) while remaining
    // invisible to the substring/regex assertions above. Balance-check every
    // expression so the parse error fails HERE, in a reviewable unit test.
    const expressions = [
      ...(workflowSource.match(/\$\{\{[\s\S]*?\}\}/g) ?? []),
      ...(entrySource.match(/\$\{\{[\s\S]*?\}\}/g) ?? []),
    ];
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

// Skip the executed preflight cases when no bash >= 4 is reachable (macOS
// /bin/bash 3.2 without a brew-installed bash); CI runs on Linux and keeps
// full executed coverage.
const executedDescribe = GNU_BASH ? describe : describe.skip;
executedDescribe(
  "Cloud CF realtime voice deploy preflight (executed verbatim)",
  () => {
    test("accepts a configured production voice binding without a pre-deploy write", () => {
      const result = runProductionVoiceCandidateCheck(
        [
          "VOICE_REALTIME_CARTESIA_VOICE_ID",
          "VOICE_REALTIME_ELIZA_AUTHORIZATION",
          "VOICE_REALTIME_ELIZA_ENDPOINT",
        ],
        ["CARTESIA_API_KEY"],
      );
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      expect(result.stdout).toContain(
        "Verified 4 existing or configured production voice binding names",
      );
    });

    test("fails before deploy when a production voice binding is neither existing nor configured", () => {
      const result = runProductionVoiceCandidateCheck(
        [
          "VOICE_REALTIME_CARTESIA_VOICE_ID",
          "VOICE_REALTIME_ELIZA_AUTHORIZATION",
          "VOICE_REALTIME_ELIZA_ENDPOINT",
        ],
        [],
      );
      expect(result.status).toBe(1);
      expect(`${result.stdout}${result.stderr}`).toContain("CARTESIA_API_KEY");
    });

    test("does not require realtime secrets when staging opt-in is absent", () => {
      const result = runPreflight({
        DEEPGRAM_API_KEY: "",
        CARTESIA_API_KEY: "",
        VOICE_REALTIME_ELIZA_AUTHORIZATION: "",
        STAGING_ELIZACLOUD_API_KEY: "repo-key-must-not-be-used",
        VOICE_REALTIME_WS_ENABLED: "false",
      });
      expect(result.status).toBe(0);
      expect(result.stdout).not.toContain("Bearer repo-key-must-not-be-used");
    });

    test("requires and publishes Cartesia batch provider billing authority independently of realtime", () => {
      const missingKey = runPreflight({
        CARTESIA_API_KEY: "",
        VOICE_BATCH_STT_PROVIDER: "cartesia",
        VOICE_REALTIME_WS_ENABLED: "false",
      });
      expect(missingKey.status).toBe(1);
      expect(missingKey.stdout).toContain("CARTESIA_API_KEY");

      const missingPrice = runPreflight({
        CARTESIA_STT_USD_PER_CREDIT: "",
        VOICE_BATCH_STT_PROVIDER: "cartesia",
        VOICE_REALTIME_WS_ENABLED: "false",
      });
      expect(missingPrice.status).toBe(1);
      expect(missingPrice.stdout).toContain("CARTESIA_STT_USD_PER_CREDIT");

      const configured = runPreflight({
        VOICE_BATCH_STT_PROVIDER: "cartesia",
        VOICE_REALTIME_WS_ENABLED: "false",
      });
      expect(configured.status).toBe(0);
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
      expect(configured.status).toBe(0);
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
      const configured = runPreflight(
        {
          VOICE_REALTIME_WS_ENABLED: "true",
          VOICE_REALTIME_ELIZA_AUTHORIZATION: "",
          STAGING_ELIZACLOUD_API_KEY: "stage-cloud-key",
        },
        `printf '<%s>' "$VOICE_REALTIME_ELIZA_AUTHORIZATION"`,
      );
      expect(configured.status).toBe(0);
      expect(configured.stdout).toBe("<Bearer stage-cloud-key>");

      const empty = runPreflight({
        VOICE_REALTIME_ELIZA_AUTHORIZATION: "",
        STAGING_ELIZACLOUD_API_KEY: " \t\n",
        VOICE_REALTIME_WS_ENABLED: "true",
      });
      expect(empty.status).toBe(1);
      expect(empty.stdout).not.toContain("Bearer ");
    });
  },
);
