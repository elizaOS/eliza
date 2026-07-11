import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const workflow = readFileSync(
  new URL("../../../.github/workflows/chat-latency-live.yml", import.meta.url),
  "utf8",
);

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
    expect(workflow).toContain("--target direct");
    expect(workflow).toContain("--target gateway");
    expect(workflow).toContain(
      "Both commands execute in this same job so host, runner region, Node",
    );
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
      "zai-glm-4.7@none@512",
    ]) {
      expect(workflow).toContain(`--case ${probeCase}`);
    }
  });

  test("uses secrets only through an environment variable and retains evidence", () => {
    expect(workflow).toContain("secrets.CEREBRAS_API_KEY");
    expect(workflow).toContain("secrets.ELIZACLOUD_API_KEY");
    expect(workflow).toContain("--api-key-env CEREBRAS_CHAT_LATENCY_API_KEY");
    expect(workflow).toContain(
      "--api-key-env ELIZA_CLOUD_CHAT_LATENCY_API_KEY",
    );
    expect(workflow).not.toContain("--api-key ${{");
    expect(workflow).toContain("Upload exact-SHA latency evidence");
    expect(workflow).toContain("retention-days: 14");
  });

  test("runs the privacy and parser self-test before live requests", () => {
    expect(workflow).toContain(
      "node --test packages/scripts/cloud/chat-latency.test.mjs",
    );
    expect(workflow).toContain("needs: contract");
    expect(workflow).toContain("Enforce probe result");
  });
});
