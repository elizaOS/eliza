/**
 * Locks the mission-critical live/provisioning workflows to closed diagnostics
 * without executing provider, deployment, or infrastructure mutations.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "../../..");
const cleanupArrayExpansion = '"$' + '{cleanup_paths[@]}"';

interface WorkflowStep {
  name?: string;
  run?: string;
  with?: Record<string, string>;
}

interface WorkflowJob {
  steps?: WorkflowStep[];
}

interface Workflow {
  jobs?: Record<string, WorkflowJob>;
}

function read(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), "utf8");
}

function parseWorkflow(relativePath: string): Workflow {
  return Bun.YAML.parse(read(relativePath)) as Workflow;
}

function workflowStep(
  workflow: Workflow,
  jobName: string,
  stepName: string,
): WorkflowStep {
  const step = workflow.jobs?.[jobName]?.steps?.find(
    (candidate) => candidate.name === stepName,
  );
  if (!step) throw new Error(`Missing workflow step ${jobName}:${stepName}`);
  return step;
}

describe("mission workflow diagnostic redaction", () => {
  test("app live suppresses credentialed output and uploads only the closed backend receipt", () => {
    const workflow = parseWorkflow(".github/workflows/app-live-e2e.yml");
    const missionSpec =
      /test\/ui-smoke\/(?:live-agent-chat|vault-routing|wallet-keys|vault-modal-interactions|settings-sections-interactions|provider-config|cloud-live)\.spec\.ts/;
    const credentialedSteps = Object.values(workflow.jobs ?? {})
      .flatMap((job) => job.steps ?? [])
      .filter((step) => missionSpec.test(step.run ?? ""));
    expect(credentialedSteps).toHaveLength(4);
    for (const step of credentialedSteps) {
      const run = step.run ?? "";
      expect(run).toMatch(/^set -euo pipefail/);
      expect(run).toContain(">/dev/null 2>&1");
      expect(run).toContain("category=");
      expect(run).toContain("raw-output=suppressed");
    }

    const upload = workflowStep(
      workflow,
      "app-live-chat",
      "Upload live-chat artifacts",
    );
    const artifactPaths = (upload.with?.path ?? "")
      .split("\n")
      .map((entry) => entry.trim())
      .filter(Boolean);
    expect(artifactPaths).toEqual(["e2e-recordings/app-live/backend.log"]);
  });

  test("settings failure stops the second credentialed run without exposing child bytes", () => {
    const workflow = parseWorkflow(".github/workflows/app-live-e2e.yml");
    const run = workflowStep(
      workflow,
      "app-live-chat",
      "Run settings + vault live-stack deep e2e",
    ).run;
    if (!run) throw new Error("Missing settings/vault run script");

    const directory = mkdtempSync(join(tmpdir(), "closed-e2e-workflow-"));
    const binDirectory = join(directory, "bin");
    const callLog = join(directory, "bun-calls.log");
    mkdirSync(binDirectory);
    writeFileSync(
      join(binDirectory, "bun"),
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$CALL_LOG"
printf '%s\\n' 'agent_config={apiKey:sk-live,email:user@example.com}'
printf '%s\\n' 'provider response with wallet and agent identifier' >&2
exit 17
`,
      { mode: 0o755 },
    );

    try {
      const result = spawnSync("bash", ["-c", run], {
        encoding: "utf8",
        env: {
          ...process.env,
          CALL_LOG: callLog,
          PATH: `${binDirectory}:${process.env.PATH ?? ""}`,
        },
      });
      expect(result.status).toBe(17);
      expect(readFileSync(callLog, "utf8").trim().split("\n")).toHaveLength(1);
      expect(`${result.stdout}${result.stderr}`).toContain(
        "category=settings-vault-failed",
      );
      expect(`${result.stdout}${result.stderr}`).not.toContain("sk-live");
      expect(`${result.stdout}${result.stderr}`).not.toContain(
        "user@example.com",
      );
      expect(`${result.stdout}${result.stderr}`).not.toContain(
        "provider response",
      );
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  test("shared app harness never forwards child bytes or onboarding bodies", () => {
    const harness = read(
      "packages/app-core/scripts/playwright-ui-live-stack.ts",
    );
    expect(harness).toContain("attachSafeChildOutputObserver");
    expect(harness).not.toMatch(/\.(?:stdout|stderr)\.on\(["']data["']/);
    expect(harness).not.toMatch(/\.(?:stdout|stderr)\.pipe\(/);
    expect(harness).not.toContain("process.stdout.write(output)");
    expect(harness).not.toContain("appendFileSync(backendLogPath, output)");
    expect(harness).not.toContain('logs.join("")');
    expect(harness).not.toContain("await response.text()");
    expect(harness).toContain("category=first-run-rejected");
    expect(harness).toContain("response-body=suppressed");
    expect(harness).not.toContain(
      'console.error("[playwright-ui-live-stack] proxy error:", error)',
    );
  });

  test("provisioning keeps journals private and emits allowlisted unit state", () => {
    const workflow = read(
      ".github/workflows/deploy-eliza-provisioning-worker.yml",
    );
    const health = workflow.slice(workflow.indexOf("- name: Health check"));

    expect(health).toContain("report_unit_diagnostic() {");
    expect(health).toContain("--property=LoadState");
    expect(health).toContain("--property=ActiveState");
    expect(health).toContain("--property=Result");
    expect(health).toContain("unit-state category=");
    expect(health).toContain("worker|router|backup|nginx");
    expect(health).toContain("component=$" + "{label}");
    expect(health).not.toMatch(/echo[^\n]*\$\{unit\}/);
    expect(health).not.toMatch(/systemctl status\b/);
    expect(health).not.toMatch(/echo "\$(?:BACKUP_|ROUTER_)?JOURNAL"/);
    expect(health).not.toMatch(/journalctl[^\n]*\|\s*tail/);
    expect(health).not.toMatch(/echo[^\n]*\$\{AGENT_ROUTER_PUBLIC_HOST\}/);

    expect(health).toContain("BACKUP_JOURNAL=$(sudo journalctl");
    expect(health).toContain("JOURNAL=$(sudo journalctl");
    expect(health).toContain("ROUTER_JOURNAL=$(sudo journalctl");
    expect(health).toContain('grep -qE "$FATAL_LOG_PATTERN"');
  });

  test("Headscale projects remote output to fixed receipts and never prints node or journal lines", () => {
    const workflow = parseWorkflow(
      ".github/workflows/arm-headscale-control-plane.yml",
    );
    const converge = workflowStep(
      workflow,
      "arm",
      "Inspect or converge Headscale control plane",
    ).run;
    expect(converge).toContain('> "$arm_stdout" 2> "$arm_stderr"');
    expect(converge).toContain("category=headscale-converge-passed");
    expect(converge).toContain(
      "grep -hEo 'category=(headscale|cp-router)-[a-z0-9-]+'",
    );
    expect(converge).toContain('case "$safe_category" in');
    expect(converge).toContain("headscale-*|cp-router-*)");
    expect(converge).toContain('*) safe_category="headscale-remote-failed" ;;');
    expect(converge).toContain("category=$safe_category");
    expect(converge).toContain("raw-output=suppressed");
    expect(converge).toContain('rm -f -- "$' + '{cleanup_paths[@]}"');
    expect(converge).not.toContain('cat "$arm_stdout"');
    expect(converge).not.toContain('cat "$arm_stderr"');

    const script = read(
      "packages/cloud/scripts/admin/arm-headscale-control-plane.mjs",
    );
    expect(script).not.toMatch(/systemctl status headscale\b/);
    expect(script).not.toMatch(/journalctl -u headscale\b/);
    expect(script).not.toMatch(/echo "\$CP_ROUTER_HOST/);
    expect(script).toContain(
      "FINAL_STATUS_JSON=$(sudo tailscale status --json 2>/dev/null || true)",
    );
    expect(script).toContain(
      "FINAL_PREFS_JSON=$(sudo tailscale debug prefs 2>/dev/null || true)",
    );
    expect(script).toContain('.BackendState == "Running"');
    expect(script).toContain(
      '[ "\\$' + '{FINAL_CONTROL_URL%/}" = "\\$' + '{LOGIN_SERVER%/}" ]',
    );
    expect(script).toContain("category=cp-router-live-proof-failed");
    expect(script).toContain("category=cp-router-control-url-mismatch");
    expect(script).toContain("category=cp-router-durable-proof-failed");
    expect(script).toContain('headscale users create "$user" >/dev/null');
  });

  test("Railway deploy and DNS handoff retain raw provider output only in private files", () => {
    const workflow = parseWorkflow(".github/workflows/deploy-tunnel-proxy.yml");
    const deploy = workflowStep(
      workflow,
      "deploy",
      "Deploy tunnel-proxy source to Railway",
    ).run;
    expect(deploy).toContain('> "$railway_stdout" 2> "$railway_stderr"');
    expect(deploy).toContain("category=railway-deploy-passed");
    expect(deploy).toContain("provider-output=suppressed");
    expect(deploy).toContain('rm -f -- "$' + '{cleanup_paths[@]}"');
    expect(deploy).not.toContain('cat "$railway_stdout"');
    expect(deploy).not.toContain('cat "$railway_stderr"');

    const handoff = workflowStep(
      workflow,
      "deploy",
      "Validate reviewed Railway DNS handoff",
    ).run;
    const summary = handoff.slice(handoff.indexOf("GITHUB_STEP_SUMMARY") - 500);
    expect(summary).not.toContain('jq . "$inventory"');
    expect(handoff).toContain("category=dns-inventory-ready");
    expect(handoff).toContain("values=suppressed");
    expect(handoff).toContain('rm -f -- "$' + '{cleanup_paths[@]}"');
    expect(handoff).not.toContain(
      "copy the exact inventory from this run summary",
    );
  });

  test("mission Railway steps close provider streams and destroy private captures", () => {
    const workflow = parseWorkflow(".github/workflows/deploy-tunnel-proxy.yml");
    const checks = [
      {
        name: "Verify exact Railway target",
        category: "railway-target-verified",
        privatePaths: ["$status_path", "$provider_stderr"],
      },
      {
        name: "Converge non-secret Railway variables and signing secret",
        category: "railway-variables-published",
        privatePaths: ["$provider_stdout", "$provider_stderr"],
      },
      {
        name: "Converge persistent tsnet volume",
        category: "railway-volume-ready",
        privatePaths: ["$volumes_path", "$provider_stderr"],
      },
      {
        name: "Mint proxy key and publish it without exposing the value",
        category: "railway-proxy-key-published",
        privatePaths: ["$railway_stdout", "$railway_stderr"],
      },
      {
        name: "Converge exact Railway custom domains",
        category: "railway-domain-created",
        privatePaths: ["$domains_path", "$created_path", "$provider_stderr"],
      },
      {
        name: "Validate reviewed Railway DNS handoff",
        category: "dns-inventory-ready",
        privatePaths: ["$apex_status", "$wildcard_status", "$provider_stderr"],
      },
      {
        name: "Verify Railway domain ownership and certificates",
        category: "railway-domains-verified",
        privatePaths: ["$status_path", "$provider_stderr"],
      },
    ] as const;

    for (const check of checks) {
      const run = workflowStep(workflow, "deploy", check.name).run ?? "";
      expect(run).toContain("umask 077");
      expect(run).toContain(`category=${check.category}`);
      expect(run).toContain("provider-output=suppressed");
      expect(run).toContain(`shred -u -- ${cleanupArrayExpansion}`);
      expect(run).toContain(`rm -f -- ${cleanupArrayExpansion}`);
      for (const privatePath of check.privatePaths) {
        expect(run).not.toContain(`cat "${privatePath}"`);
      }
    }

    for (const stepName of [
      "Converge exact Railway custom domains",
      "Validate reviewed Railway DNS handoff",
      "Verify Railway domain ownership and certificates",
    ]) {
      const run = workflowStep(workflow, "deploy", stepName).run ?? "";
      expect(run).not.toMatch(
        /echo[^\n]*\$(?:domain(?!_)|requested_domain\b|TUNNEL_PROXY_HOST\b)/,
      );
    }
  });

  test("hostile Railway variable output cannot reach logs and is removed", () => {
    const workflow = parseWorkflow(".github/workflows/deploy-tunnel-proxy.yml");
    const run =
      workflowStep(
        workflow,
        "deploy",
        "Converge non-secret Railway variables and signing secret",
      ).run ?? "";
    const directory = mkdtempSync(join(tmpdir(), "railway-vars-redaction-"));
    const binDirectory = join(directory, "bin");
    mkdirSync(binDirectory);
    writeFileSync(
      join(binDirectory, "railway"),
      `#!/usr/bin/env bash
printf '%s\\n' 'provider-json agent_config token=provider-secret-canary user=private.person+ci@example.invalid id=11111111-2222-4333-8444-555555555555'
printf '%s\\n' 'provider-stderr wallet=provider-wallet-canary' >&2
exit "\${RAILWAY_STUB_EXIT:-0}"
`,
      { mode: 0o755 },
    );

    try {
      const baseEnv = {
        ...process.env,
        HEADSCALE_PUBLIC_URL: "https://headscale.example.invalid",
        PATH: `${binDirectory}:${process.env.PATH ?? ""}`,
        RAILWAY_ENVIRONMENT_ID: "environment-canary",
        RAILWAY_PROJECT_ID: "project-canary",
        RAILWAY_SERVICE_ID: "service-canary",
        RUNNER_TEMP: directory,
        TARGET_ENVIRONMENT: "staging",
        TUNNEL_HOSTNAME_SIGNING_SECRET:
          "signing-secret-canary-that-is-long-enough",
        TUNNEL_PROXY_HOST: "tunnel.example.invalid",
      };
      for (const [stubExit, expectedStatus, expectedCategory] of [
        [undefined, 0, "category=railway-variables-published"],
        ["23", 23, "category=railway-variables-config-failed"],
      ] as const) {
        const result = spawnSync("bash", ["-c", run], {
          encoding: "utf8",
          env: {
            ...baseEnv,
            ...(stubExit ? { RAILWAY_STUB_EXIT: stubExit } : {}),
          },
        });
        const output = `${result.stdout}${result.stderr}`;
        expect(result.status).toBe(expectedStatus);
        expect(output).toContain(expectedCategory);
        for (const canary of [
          "provider-secret-canary",
          "private.person+ci@example.invalid",
          "11111111-2222-4333-8444-555555555555",
          "provider-wallet-canary",
        ]) {
          expect(output).not.toContain(canary);
        }
        expect(existsSync(join(directory, "railway-variables.stdout"))).toBe(
          false,
        );
        expect(existsSync(join(directory, "railway-variables.stderr"))).toBe(
          false,
        );
      }
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  }, 15_000);

  test("hostile Railway domain output is reduced to fixed roles and removed", () => {
    const workflow = parseWorkflow(".github/workflows/deploy-tunnel-proxy.yml");
    const converge =
      workflowStep(workflow, "deploy", "Converge exact Railway custom domains")
        .run ?? "";
    const verify =
      workflowStep(
        workflow,
        "deploy",
        "Verify Railway domain ownership and certificates",
      ).run ?? "";
    const directory = mkdtempSync(join(tmpdir(), "railway-domain-redaction-"));
    const binDirectory = join(directory, "bin");
    const outputPath = join(directory, "github-output");
    mkdirSync(binDirectory);
    writeFileSync(outputPath, "");
    writeFileSync(
      join(binDirectory, "railway"),
      `#!/usr/bin/env bash
if [ "$1" != "domain" ]; then
  exit 64
fi
case "$2" in
  list)
    printf '%s\\n' '{"domains":[],"agent_config":"provider-domain-secret-canary"}'
    ;;
  status)
    printf '{"domain":{"domain":"%s","type":"custom","targetPort":8080,"syncStatus":"ACTIVE","verification":{"verified":true,"token":"provider-token-canary"},"certificate":{"status":"CERTIFICATE_STATUS_TYPE_VALID"}},"ownerEmail":"domain.owner@example.invalid"}\\n' "$3"
    ;;
  *)
    printf '%s\\n' '{"domainId":"66666666-7777-4888-8999-000000000000","providerResponse":"provider-create-canary"}'
    ;;
esac
printf '%s\\n' 'provider-stderr nodeId=provider-node-canary wallet=provider-wallet-canary' >&2
exit 0
`,
      { mode: 0o755 },
    );

    const env = {
      ...process.env,
      GITHUB_OUTPUT: outputPath,
      PATH: `${binDirectory}:${process.env.PATH ?? ""}`,
      RAILWAY_ENVIRONMENT_ID: "environment-canary",
      RAILWAY_PROJECT_ID: "project-canary",
      RAILWAY_SERVICE_ID: "service-canary",
      RUNNER_TEMP: directory,
      TUNNEL_PROXY_HOST: "private-tunnel.example.invalid",
    };

    try {
      for (const [script, expectedCategory] of [
        [converge, "category=railway-domain-created"],
        [verify, "category=railway-domains-verified"],
      ] as const) {
        const result = spawnSync("bash", ["-c", script], {
          encoding: "utf8",
          env,
        });
        const output = `${result.stdout}${result.stderr}`;
        expect(result.status).toBe(0);
        expect(output).toContain(expectedCategory);
        expect(output).toContain("role=apex");
        expect(output).toContain("role=wildcard");
        for (const canary of [
          "private-tunnel.example.invalid",
          "provider-domain-secret-canary",
          "provider-token-canary",
          "domain.owner@example.invalid",
          "66666666-7777-4888-8999-000000000000",
          "provider-create-canary",
          "provider-node-canary",
          "provider-wallet-canary",
        ]) {
          expect(output).not.toContain(canary);
        }
      }

      for (const privateFile of [
        "railway-domains.json",
        "railway-domain-created.json",
        "railway-domain-converge.stderr",
        "railway-domain-converge-transform.stderr",
        "railway-domain-verification.json",
        "railway-domain-verification.stderr",
        "railway-domain-verification-transform.stderr",
      ]) {
        expect(existsSync(join(directory, privateFile))).toBe(false);
      }
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});
