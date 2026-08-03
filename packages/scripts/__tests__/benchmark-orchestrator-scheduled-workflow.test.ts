/**
 * Pins the scheduled orchestrator lane to deterministic Python and data preflight.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const workflow = readFileSync(
  new URL(
    "../../../.github/workflows/benchmark-orchestrator-scheduled.yml",
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

describe("scheduled benchmark orchestrator workflow", () => {
  test("installs hash-locked Python dependencies before provisioning", () => {
    const install = extractStep("Install scheduled benchmark Python dependencies");
    expect(install).toContain("python -m pip install");
    expect(install).toContain("--require-hashes");
    expect(install).toContain("requirements-scheduled.lock");
    expect(workflow.indexOf("- name: Install scheduled benchmark Python dependencies")).toBeLessThan(
      workflow.indexOf("- name: Provision scheduled benchmark inputs"),
    );
  });

  test("preflights immutable inputs before the model run", () => {
    const preflight = extractStep("Provision scheduled benchmark inputs");
    expect(preflight).toContain("set -euo pipefail");
    expect(preflight).toContain("python -m benchmarks.orchestrator.scheduled_preflight");
    expect(preflight).toContain('--benchmarks "$BENCHMARKS"');
    expect(preflight).not.toContain("continue-on-error");
    expect(preflight).not.toContain("|| true");
  });

  test("keeps tee behind pipefail so benchmark failures remain failures", () => {
    const run = extractStep("Run core registry subset on a real model");
    expect(run).toContain("set -eo pipefail");
    expect(run).toContain("--model-profile scheduled-core");
    expect(run).toContain("2>&1 | tee orchestrator-scheduled.log");
    expect(run).not.toContain("continue-on-error");
    expect(run).not.toContain("|| true");
  });

  test("uses the publication-ready benchmark set in every default", () => {
    const expected = [
      "action-calling",
      "bfcl",
      "context_bench",
      "mint",
      "tau_bench",
    ];
    const defaults = [
      ...workflow.matchAll(
        /(?:default:\s*|inputs\.benchmarks\s*\|\|\s*)["']([^"']+)["']/g,
      ),
    ]
      .map((match) => match[1])
      .filter((value) => value.includes(","));

    expect(defaults).toHaveLength(4);
    for (const value of defaults) {
      expect(value.split(",").sort()).toEqual(expected);
    }
    expect(workflow).not.toContain("action-calling,agentbench");
  });
});
