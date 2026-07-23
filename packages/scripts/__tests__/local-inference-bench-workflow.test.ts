/**
 * Pins the real Local Inference benchmark to a healthy backend-only process.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const workflow = readFileSync(
  new URL(
    "../../../.github/workflows/local-inference-bench.yml",
    import.meta.url,
  ),
  "utf8",
);

function extractStep(stepName: string): string {
  const escaped = stepName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const step = workflow.match(
    new RegExp(
      `^      - name: ${escaped}\\n(?<body>[\\s\\S]*?)(?=^      - name: |^  [a-zA-Z0-9_-]+:|$(?![\\s\\S]))`,
      "m",
    ),
  )?.groups?.body;
  if (!step) {
    throw new Error(`Missing workflow step: ${stepName}`);
  }
  return step;
}

describe("Local Inference Bench workflow", () => {
  test("boots the API without coupling model downloads to Vite", () => {
    const boot = extractStep("Boot backend agent");
    expect(boot).toContain("bun run start");
    expect(boot).not.toContain("bun run dev");
    expect(boot).not.toContain("ELIZA_PORT");
    expect(boot).toContain(".ci-logs/agent.log");
  });

  test("waits for the runtime and deferred feature routes", () => {
    const boot = extractStep("Boot backend agent");
    expect(boot).toContain(".ready == true");
    expect(boot).toContain('.runtime == "ok"');
    expect(boot).toContain('.database == "ok"');
    expect(boot).toContain(".plugins.failed == 0");
    expect(boot).toContain(".deferredBoot.settled == true");
    expect(boot).toContain("exit 1");
  });

  test("teardown and evidence target the backend process", () => {
    expect(extractStep("Tear down backend agent")).toContain("/tmp/agent.pid");
    const upload = extractStep("Upload agent server log");
    expect(upload).toContain("path: .ci-logs/agent.log");
    expect(upload).toMatch(/if: \$\{\{ always\(\) \}\}/);
  });
});
