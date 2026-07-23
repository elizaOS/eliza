/**
 * Pins the live LifeOps benchmark's provider and external-agent prerequisites.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const workflow = readFileSync(
  new URL("../../../.github/workflows/lifeops-bench.yml", import.meta.url),
  "utf8",
);

function extractStep(name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = workflow.match(
    new RegExp(
      `^      - name: ${escaped}\\n(?<body>[\\s\\S]*?)(?=^      - (?:name|uses): |$(?![\\s\\S]))`,
      "m",
    ),
  );
  if (!match?.groups?.body) {
    throw new Error(`Missing workflow step: ${name}`);
  }
  return match.groups.body;
}

describe("LifeOps benchmark workflow prerequisites", () => {
  test("skips unless both live provider secrets are configured", () => {
    const gate = extractStep("Check secrets");
    expect(gate).toContain(
      "CEREBRAS_API_KEY: $" + "{{ secrets.CEREBRAS_API_KEY }}",
    );
    expect(gate).toContain(
      "ANTHROPIC_API_KEY: $" + "{{ secrets.ANTHROPIC_API_KEY }}",
    );
    expect(gate).toContain('[ -z "$' + '{CEREBRAS_API_KEY:-}" ] ||');
    expect(gate).toContain('[ -z "$' + '{ANTHROPIC_API_KEY:-}" ]');

    const run = extractStep("Run lifeops multi-agent bench (matrix leg)");
    expect(run).toContain(
      "CEREBRAS_API_KEY: $" + "{{ secrets.CEREBRAS_API_KEY }}",
    );
    expect(run).toContain(
      "ANTHROPIC_API_KEY: $" + "{{ secrets.ANTHROPIC_API_KEY }}",
    );
  });

  test("installs and verifies Hermes before its matrix leg runs", () => {
    const install = extractStep("Install and verify Hermes agent");
    expect(install).toContain("matrix.agent == 'hermes'");
    expect(install).toContain('AGENT_INSTALL_TIMEOUT_SECONDS: "900"');
    expect(install).toContain(
      "python packages/benchmarks/lib/agent_install.py --agents hermes",
    );
    expect(
      workflow.indexOf("- name: Install and verify Hermes agent"),
    ).toBeLessThan(
      workflow.indexOf("- name: Run lifeops multi-agent bench (matrix leg)"),
    );
  });
});
