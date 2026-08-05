/**
 * Fail-closed deployment contracts for the staging realtime-voice soak.
 * Provider and bridge credentials must exist before a Worker advertising the
 * feature can deploy, while production may never inherit the repository Cloud
 * key as an implicit service authorization. Production remains deployable
 * while realtime is explicitly off; enabling it requires dedicated/provider
 * secrets so a managed deploy overwrites any stale Worker value first.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolveGnuBash } from "../lib/gnu-shell.mjs";

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
  jobs?: Record<string, { steps?: WorkflowStep[] }>;
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

function runPreflight(env: Record<string, string>) {
  return spawnSync(requirePreflightBash(), ["-c", preflight], {
    encoding: "utf8",
    env: {
      ...process.env,
      DEPLOY_ENVIRONMENT: "staging",
      DEEPGRAM_API_KEY: "deepgram-test",
      CARTESIA_API_KEY: "cartesia-test",
      FISH_AUDIO_API_KEY: "fish-test",
      FISH_AUDIO_REFERENCE_ID: "fish-reference-test",
      ELIZA_TTS_FISH_ENABLED: "false",
      FISH_AUDIO_MODEL: "s2.1-pro",
      FISH_AUDIO_SAMPLE_RATE: "16000",
      FISH_AUDIO_FIRST_AUDIO_TIMEOUT_MS: "1500",
      VOICE_REALTIME_ELIZA_AUTHORIZATION: "Bearer dedicated-test",
      VOICE_REALTIME_WS_ENABLED: "false",
      STAGING_ELIZACLOUD_API_KEY: "",
      PRODUCTION_REALTIME_WS_ENABLED: "false",
      PRODUCTION_REALTIME_CARTESIA_VOICE_ID: "",
      PRODUCTION_REALTIME_ELIZA_ENDPOINT: "",
      ...env,
    },
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
  });

  test("gates realtime secret publication behind explicit opt-in", () => {
    expect(publishStep.run).toContain(
      "is gated by VOICE_REALTIME_WS_ENABLED; skipping",
    );
    expect(publishStep.run).toContain(
      "DEEPGRAM_API_KEY|CARTESIA_API_KEY|VOICE_REALTIME_ELIZA_AUTHORIZATION",
    );
    expect(publishStep.run).toContain(
      "FISH_AUDIO_API_KEY|FISH_AUDIO_REFERENCE_ID",
    );
    expect(publishStep.run).toContain(
      "is gated by realtime voice and ELIZA_TTS_FISH_ENABLED; skipping",
    );
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
    expect(deployStep.run).toContain(
      '--var FISH_AUDIO_SAMPLE_RATE:"$FISH_AUDIO_SAMPLE_RATE"',
    );
  });

  test("keeps production wrangler vars and workflow env realtime-off with no dedicated-secret advertisement", () => {
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
    expect(publishStep.env?.VOICE_REALTIME_WS_ENABLED).toContain(
      "vars.VOICE_REALTIME_WS_ENABLED",
    );
    expect(publishStep.env?.PRODUCTION_REALTIME_WS_ENABLED).toBe("false");
    expect(productionVars).not.toContain("VOICE_REALTIME_CARTESIA_VOICE_ID");
    expect(productionVars).not.toContain("VOICE_REALTIME_ELIZA_ENDPOINT");
    expect(publishStep.env?.PRODUCTION_REALTIME_CARTESIA_VOICE_ID).toBe("");
    expect(publishStep.env?.PRODUCTION_REALTIME_ELIZA_ENDPOINT).toBe("");
    expect(wrangler).not.toContain("VOICE_AMBIENT_ENABLED");
    expect(wrangler).not.toContain("VOICE_AMBIENT_PENDANT_BASE_URL");
  });

  test("deploy Worker passes the same fail-closed runtime realtime opt-in as secrets", () => {
    const runtimeFlag = deployStep.env?.VOICE_REALTIME_WS_ENABLED;
    expect(runtimeFlag).toBe(publishStep.env?.VOICE_REALTIME_WS_ENABLED);
    expect(runtimeFlag).toContain("steps.env.outputs.deploy_environment");
    expect(runtimeFlag).toContain("!= 'production'");
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
    expect(deployStep.env?.VOICE_REALTIME_WS_ENABLED).toContain(
      "&& 'true' || 'false'",
    );

    const frontendRealtimeFlags = workflowSource.match(
      /VITE_VOICE_REALTIME_WS: \$\{\{[^}]*vars\.VOICE_REALTIME_WS_ENABLED[^}]*&& '1' \|\| '0' \}\}/g,
    );
    expect(frontendRealtimeFlags?.length).toBeGreaterThanOrEqual(2);
    for (const flag of frontendRealtimeFlags ?? []) {
      expect(flag).toContain("inputs.environment == 'production'");
      expect(flag).toContain("github.ref == 'refs/heads/main'");
      expect(flag).toContain("vars.VOICE_REALTIME_WS_ENABLED");
    }
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

// Skip the executed preflight cases when no bash >= 4 is reachable (macOS
// /bin/bash 3.2 without a brew-installed bash); CI runs on Linux and keeps
// full executed coverage.
const executedDescribe = GNU_BASH ? describe : describe.skip;
executedDescribe(
  "Cloud CF realtime voice deploy preflight (executed verbatim)",
  () => {
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

    test("requires every realtime provider and bridge secret in opted-in staging", () => {
      for (const missing of [
        "DEEPGRAM_API_KEY",
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
          VOICE_REALTIME_WS_ENABLED: "true",
        });
        expect(result.status, `${result.stdout}${result.stderr}`).toBe(1);
      }

      const configured = runPreflight({
        ELIZA_TTS_FISH_ENABLED: "true",
        VOICE_REALTIME_WS_ENABLED: "true",
      });
      expect(configured.status).toBe(0);
    });

    test("constructs the staging fallback only after truthy opt-in and a nonblank source key", () => {
      const configured = spawnSync(
        requirePreflightBash(),
        [
          "-c",
          `${preflight}\nprintf '<%s>' "$VOICE_REALTIME_ELIZA_AUTHORIZATION"`,
        ],
        {
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

    test("keeps disabled production deployable but fails a future enable without dedicated secrets", () => {
      const disabled = runPreflight({
        DEPLOY_ENVIRONMENT: "production",
        DEEPGRAM_API_KEY: "",
        CARTESIA_API_KEY: "",
        VOICE_REALTIME_ELIZA_AUTHORIZATION: "",
        STAGING_ELIZACLOUD_API_KEY: "repo-key-must-not-be-used",
      });
      expect(disabled.status).toBe(0);
      expect(disabled.stdout).not.toContain("Bearer repo-key-must-not-be-used");

      const missingDedicated = runPreflight({
        DEPLOY_ENVIRONMENT: "production",
        PRODUCTION_REALTIME_WS_ENABLED: "true",
        DEEPGRAM_API_KEY: "",
        CARTESIA_API_KEY: "",
        VOICE_REALTIME_ELIZA_AUTHORIZATION: "",
        STAGING_ELIZACLOUD_API_KEY: "repo-key-must-not-be-used",
      });
      expect(missingDedicated.status).toBe(1);
      expect(missingDedicated.stdout).toContain(
        "Production realtime voice is enabled",
      );
      expect(missingDedicated.stdout).toContain("DEEPGRAM_API_KEY");
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
        PRODUCTION_REALTIME_WS_ENABLED: "true",
        DEEPGRAM_API_KEY: "deepgram-production",
        CARTESIA_API_KEY: "cartesia-production",
        VOICE_REALTIME_ELIZA_AUTHORIZATION: "Bearer production-dedicated",
        PRODUCTION_REALTIME_CARTESIA_VOICE_ID: "production-voice-id",
        PRODUCTION_REALTIME_ELIZA_ENDPOINT:
          "https://api.elizacloud.ai/api/v1/chat/completions",
        STAGING_ELIZACLOUD_API_KEY: "repo-key-must-not-be-used",
      });
      expect(configured.status).toBe(0);
    });
  },
);
