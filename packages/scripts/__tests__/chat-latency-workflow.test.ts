import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const workflow = readFileSync(
  new URL("../../../.github/workflows/chat-latency-live.yml", import.meta.url),
  "utf8",
);

function extractEmbeddedNode(stepName: string): string {
  const nodeBody = extractRun(stepName).match(
    /<<'NODE'\n(?<node>[\s\S]*?)\nNODE(?:\n|$)/,
  )?.groups?.node;
  if (!nodeBody) {
    throw new Error(`Missing embedded Node program for ${stepName}`);
  }
  return nodeBody;
}

// Executes the bind step's embedded program exactly as the runner does
// (`node --input-type=module -` with the heredoc on stdin), with a fully
// controlled environment so match/mismatch outcomes are deterministic.
function runBindProgram(env: Record<string, string>): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(process.execPath, ["--input-type=module", "-"], {
    input: extractEmbeddedNode("Bind checkout to the requested gateway SHA"),
    encoding: "utf8",
    env,
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function extractRun(stepName: string): string {
  const escaped = stepName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const body = workflow.match(
    new RegExp(
      `^      - name: ${escaped}\\n(?<step>[\\s\\S]*?)(?=^      - name: |$(?![\\s\\S]))`,
      "m",
    ),
  )?.groups?.step;
  const run = body?.match(/^ {8}run: \|\n(?<run>(?:(?: {10}.*)?(?:\n|$))*)/m)
    ?.groups?.run;
  if (!run) throw new Error(`Missing run body for ${stepName}`);
  return run
    .split("\n")
    .map((line) => line.replace(/^ {10}/, ""))
    .join("\n");
}

describe("chat latency live workflow", () => {
  test("keeps paid live probes manual and production environment-gated", () => {
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).not.toContain("pull_request_target:");
    expect(workflow).toContain("github.event_name == 'workflow_dispatch'");
    expect(workflow).toMatch(/environment: \$\{\{ inputs\.environment \}\}/);
    expect(workflow).toContain("- staging");
    expect(workflow).toContain("- production");
  });

  test("compares direct and gateway from one fixed runner contract", () => {
    expect(workflow).not.toContain("matrix:");
    expect(workflow).toContain("--target paired");
    expect(workflow).toContain("--direct-base-url");
    expect(workflow).toContain("--gateway-base-url");
    expect(workflow).toContain("alternates target-first order exactly");
    expect(workflow).toContain("runs-on: ubuntu-24.04");
    expect(workflow).toContain("https://api.cerebras.ai");
    expect(workflow).toContain("https://api-staging.elizacloud.ai");
    expect(workflow).toContain("https://api.elizacloud.ai");
  });

  test("covers Gemma and GLM with reasoning omitted and disabled", () => {
    for (const probeCase of [
      "gemma-4-31b@omit@512",
      "gemma-4-31b@none@512",
      "zai-glm-4.7@omit@4096",
      "zai-glm-4.7@none@4096",
      "zai-glm-4.7@none@512",
    ]) {
      expect(workflow).toContain(`--case ${probeCase}`);
    }
  });

  test("uses secrets only through an environment variable and retains evidence", () => {
    expect(workflow).toContain("secrets.CEREBRAS_API_KEY");
    expect(workflow).toContain("secrets.ELIZACLOUD_API_KEY");
    expect(workflow).toContain(
      "--direct-api-key-env CEREBRAS_CHAT_LATENCY_API_KEY",
    );
    expect(workflow).toContain(
      "--gateway-api-key-env ELIZA_CLOUD_CHAT_LATENCY_API_KEY",
    );
    expect(workflow).not.toContain("--api-key ${{");
    const liveJobHeader = workflow.slice(
      workflow.indexOf("  live:"),
      workflow.indexOf("    steps:", workflow.indexOf("  live:")),
    );
    expect(liveJobHeader).not.toContain("secrets.");
    const probeStep = workflow.slice(
      workflow.indexOf("- name: Probe Gemma and GLM"),
      workflow.indexOf(
        "- name: Add privacy-safe timing table",
        workflow.indexOf("- name: Probe Gemma and GLM"),
      ),
    );
    expect(probeStep).toContain("secrets.CEREBRAS_API_KEY");
    expect(probeStep).toContain("secrets.ELIZACLOUD_API_KEY");
    expect(workflow).toContain("Upload exact-SHA latency evidence");
    expect(workflow).toContain("retention-days: 14");
    expect(workflow).toContain("Verify the exact deployed gateway SHA");
    expect(workflow).toContain("Reverify the exact deployed gateway SHA");
    expect(workflow).toContain("Gateway changed during the benchmark");
    expect(workflow).toContain("expected_gateway_sha");
  });

  test("runs the privacy and parser self-test before live requests", () => {
    expect(workflow).toContain(
      "node --test packages/scripts/cloud/chat-latency.test.mjs",
    );
    expect(workflow).toContain("needs: contract");
    expect(workflow).toContain("Enforce probe result");
    expect(workflow).toContain(
      "node --test packages/scripts/cloud/inference-auth-latency.test.mjs",
    );
  });

  test("feature refs deploy one exact version to an isolated auth Worker", () => {
    const isolated = workflow.slice(workflow.indexOf("\n  auth-isolated:"));
    expect(isolated).toContain("environment: staging");
    expect(isolated).toContain("bun-version: 1.3.14");
    expect(isolated).toContain("wrangler versions upload");
    expect(isolated).toContain(
      "node packages/shared/scripts/generate-keywords.mjs",
    );
    expect(isolated).toContain("--keep-vars");
    expect(isolated).not.toContain("--preview-alias");
    expect(isolated).toContain("preview_urls = false");
    expect(isolated).toContain("--config .wrangler-auth-probe.toml");
    expect(isolated).not.toContain("wrangler deploy");
    expect(isolated).toContain(
      "Create an isolated suspended-auth staging fixture",
    );
    expect(isolated).toContain("Create an isolated diagnostic Worker");
    expect(isolated).toContain('"/workers/workers"');
    expect(isolated).toContain("body?.result?.deployed_on != null");
    expect(isolated).toContain("workerState?.result?.deployed_on");
    expect(isolated).toContain("workers_dev = true");
    expect(isolated).toContain("Delete isolated auth Worker");
    expect(isolated).toContain(
      "Delete isolated suspended-auth staging fixture",
    );
    expect(isolated).toContain("previews_enabled: false");
    expect(isolated).toContain(
      "versions: [{ percentage: 100, version_id: versionId }]",
    );
    expect(isolated).toContain('"/workers/scripts/" + worker + "/deployments"');
    expect(isolated).toContain("activeDeployment?.id !== deploymentId");
    expect(isolated).toContain("deployedVersions[0]?.version_id !== versionId");
    expect(isolated).toContain('"/workers/subdomain"');
    expect(isolated).toContain("REDIS_RATE_LIMITING:false");
    expect(isolated).toContain("--hit-count 30");
    expect(isolated).toContain("--miss-count 10");
    expect(isolated).toContain(
      "--suspended-api-key-env AUTH_PROBE_SUSPENDED_API_KEY",
    );
    expect(isolated).toContain("INFERENCE_AUTH_PROBE_TOKEN");
    expect(isolated).toContain(
      "JSON.stringify({ DATABASE_URL: databaseUrl, INFERENCE_AUTH_PROBE_TOKEN: token })",
    );
    expect(isolated).toContain(
      'rm -f "$config" "$RUNNER_TEMP/auth-probe-secrets.json"',
    );
    expect(isolated).toContain(`ELIZA_DEPLOY_COMMIT:\${GITHUB_SHA}`);
    expect(isolated).toContain(
      "Isolated deployment remained on the exact checkout",
    );
    expect(isolated).toContain("attempt <= 24");
    expect(isolated).toContain("consecutiveExactResponses === 3");
    expect(isolated).toContain("steps.auth-probe.outcome != 'skipped'");
    expect(isolated).toContain('wrangler tail "$AUTH_PROBE_WORKER_NAME" \\');
    expect(isolated).not.toContain("--sampling-rate");
    expect(isolated).toContain('--version-id "$AUTH_PROBE_VERSION_ID"');
    expect(isolated).toContain("waitForInferenceAuthTail");
    expect(isolated).toContain("sleep 5");
    expect(isolated).toContain(
      'set +e\n          node --input-type=module - "$raw_tail"',
    );
    expect(isolated).toContain('readiness_status="$?"\n          set -e');
    expect(isolated).toContain(
      "Worker Tail observed an authenticated readiness trace",
    );
    expect(isolated).toContain("sanitizeInferenceAuthTail");
    expect(isolated).toContain("safe.slice(-2_000)");
    expect(isolated).not.toContain("[process.argv[2], process.argv[3]]");
    expect(isolated).toContain("inference-auth-worker-logs-");
    expect(isolated).toContain('rm -f "$raw_tail" "$tail_log"');
  });

  test("collects statistical warm evidence plus cold and post-idle labels", () => {
    expect(workflow).toContain('default: "30"');
    expect(workflow).toContain("--idle-ms 30000");
    expect(workflow).toContain("--pair-interval-ms 1500");
    expect(workflow).toContain("below the");
    expect(workflow).toContain("lowest Cloud organization tier");
    expect(workflow).toContain("idles before every target labeled post-idle");
    expect(workflow).toContain("p50/p90/p95");
    expect(workflow).toContain("cold/warm/post-idle");
  });

  describe("checkout binding to the requested gateway SHA (#16185)", () => {
    const shaA = "a".repeat(40);
    const shaB = "b".repeat(40);

    test("orders the bind step inside the live job before the health check and paid probe", () => {
      const liveIndex = workflow.indexOf("\n  live:");
      const bindIndex = workflow.indexOf(
        "- name: Bind checkout to the requested gateway SHA",
      );
      const verifyIndex = workflow.indexOf(
        "- name: Verify the exact deployed gateway SHA",
      );
      const probeIndex = workflow.indexOf(
        "- name: Probe Gemma and GLM reasoning modes on one runner",
      );
      expect(liveIndex).toBeGreaterThan(-1);
      expect(bindIndex).toBeGreaterThan(liveIndex);
      expect(bindIndex).toBeLessThan(verifyIndex);
      expect(verifyIndex).toBeLessThan(probeIndex);
    });

    test("passes when the checkout equals expected_gateway_sha", () => {
      const result = runBindProgram({
        EXPECTED_GATEWAY_SHA: shaA,
        GITHUB_SHA: shaA,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(
        "matches the requested gateway deployment",
      );
    });

    test("fails on a checkout/deployment mismatch before any benchmark command", () => {
      const result = runBindProgram({
        EXPECTED_GATEWAY_SHA: shaA,
        GITHUB_SHA: shaB,
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("does not match expected_gateway_sha");
    });

    test("fails when the checkout SHA is missing entirely", () => {
      const result = runBindProgram({ EXPECTED_GATEWAY_SHA: shaA });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("does not match expected_gateway_sha");
    });

    test("keeps the 40-character validation on expected_gateway_sha", () => {
      const result = runBindProgram({
        EXPECTED_GATEWAY_SHA: "deadbeef",
        GITHUB_SHA: shaA,
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("40-character lowercase commit");
    });

    test("documents the dispatch sequence and emits both SHAs in the summary", () => {
      expect(workflow).toContain("Dispatch sequence for exact artifacts");
      expect(workflow).toContain("checkout SHA == deployed SHA");
      const summary = extractRun("Add privacy-safe timing table to summary");
      expect(summary).toContain(
        '"Checkout: " + (process.env.GITHUB_SHA ?? "unknown")',
      );
      expect(summary).toContain("process.env.ELIZA_GATEWAY_DEPLOY_SHA");
    });
  });

  test("keeps every live shell and embedded Node program syntactically valid", () => {
    const steps = [
      "Bind checkout to the requested gateway SHA",
      "Verify the exact deployed gateway SHA",
      "Probe Gemma and GLM reasoning modes on one runner",
      "Reverify the exact deployed gateway SHA",
      "Add privacy-safe timing table to summary",
      "Enforce probe result",
      "Bind isolated deployment checkout to the requested SHA",
      "Generate source-mode keyword data",
      "Create an isolated authenticated probe control",
      "Create an isolated suspended-auth staging fixture",
      "Create an isolated diagnostic Worker",
      "Upload a non-deployed exact-SHA Worker version",
      "Deploy exact version to the isolated Worker subdomain",
      "Verify isolated deployment serves the exact checkout",
      "Capture 30 cache hits and 10 unique controlled KV misses",
      "Reverify exact isolated deployment after capture",
      "Add auth timing distribution to summary",
      "Delete isolated auth Worker",
      "Delete isolated suspended-auth staging fixture",
      "Enforce auth probe result",
    ];
    for (const step of steps) {
      const shell = extractRun(step);
      const bash = spawnSync("bash", ["-n"], {
        input: shell,
        encoding: "utf8",
      });
      expect(bash.status, `${step}: ${bash.stderr}`).toBe(0);
      expect(bash.stderr, `${step}: ${bash.stderr}`).not.toContain(
        "here-document at line",
      );

      const nodeBodies = [
        ...shell.matchAll(/<<'NODE'\n(?<node>[\s\S]*?)\nNODE(?:\n|$)/g),
      ].map((match) => match.groups?.node);
      for (const nodeBody of nodeBodies) {
        if (!nodeBody) throw new Error(`${step}: empty embedded Node program`);
        const node = spawnSync(
          process.execPath,
          ["--input-type=module", "--check"],
          { input: nodeBody, encoding: "utf8" },
        );
        expect(node.status, `${step}: ${node.stderr}`).toBe(0);
      }
    }
  });
});
