import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const workflow = readFileSync(
  new URL("../../../.github/workflows/chat-latency-live.yml", import.meta.url),
  "utf8",
);

function extractRun(stepName: string): string {
  const escaped = stepName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const body = workflow.match(
    new RegExp(
      `^      - name: ${escaped}\\n(?<step>[\\s\\S]*?)(?=^      - name: |$(?![\\s\\S]))`,
      "m",
    ),
  )?.groups?.step;
  const run = body?.match(/^ {8}run: \|\n(?<run>(?: {10}.*(?:\n|$))*)/m)?.groups
    ?.run;
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
    expect(workflow).toContain("if: github.event_name == 'workflow_dispatch'");
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

  test("keeps every live shell and embedded Node program syntactically valid", () => {
    const steps = [
      "Verify the exact deployed gateway SHA",
      "Probe Gemma and GLM reasoning modes on one runner",
      "Reverify the exact deployed gateway SHA",
      "Add privacy-safe timing table to summary",
      "Enforce probe result",
    ];
    for (const step of steps) {
      const shell = extractRun(step);
      const bash = spawnSync("bash", ["-n"], {
        input: shell,
        encoding: "utf8",
      });
      expect(bash.status, `${step}: ${bash.stderr}`).toBe(0);

      const nodeBody = shell.match(/<<'NODE'\n(?<node>[\s\S]*?)\nNODE(?:\n|$)/)
        ?.groups?.node;
      if (nodeBody) {
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
