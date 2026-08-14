/**
 * Validates affected-scoped test lane markers in CI workflows (#19351).
 *
 * These tests ensure that test lanes gated on changed paths (affected-scoped)
 * are visibly distinct from passing lanes when zero packages execute. The
 * "— not affected" marker and GitHub notice output make the vacuous case clear.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const ciWorkflowPath = join(repoRoot, ".github", "workflows", "ci.yml");

describe("affected-scoped test lane markers (#19351)", () => {
  const ciContent = readFileSync(ciWorkflowPath, "utf8");

  const lanes = [
    { name: "server", jobName: "tests_server" },
    { name: "client", jobName: "tests_client" },
    { name: "plugins", jobName: "tests_plugins" },
    { name: "e2e shard", jobName: "smoke" },
    { name: "smoke lane", jobName: "smoke_lanes" },
  ];

  test("all affected-scoped lanes have '— not affected' markers", () => {
    for (const { name } of lanes) {
      expect(
        ciContent,
        `lane "${name}" should have '— not affected' marker`,
      ).toContain(`— not affected (${name})`);
    }
  });

  test("all '— not affected' markers use GitHub notice output", () => {
    for (const { name } of lanes) {
      const marker = `— not affected (${name})`;
      const markerIndex = ciContent.indexOf(marker);
      expect(markerIndex, `marker "${marker}" should be found`).toBeGreaterThan(
        -1,
      );

      const section = ciContent.slice(
        markerIndex,
        markerIndex + 500,
      );
      expect(
        section,
        `lane "${name}" should use GitHub notice output`,
      ).toContain("::notice::Lane not affected by changes");
    }
  });

  test("'— not affected' markers include vacuous-case message", () => {
    for (const { name } of lanes) {
      const marker = `— not affected (${name})`;
      const markerIndex = ciContent.indexOf(marker);
      const section = ciContent.slice(
        markerIndex,
        markerIndex + 500,
      );
      expect(
        section,
        `lane "${name}" should document zero packages executed`,
      ).toContain("0 packages executed");
    }
  });

  test("no lanes use the old 'No affected' naming", () => {
    // Ensure all old-style messages have been replaced
    expect(ciContent).not.toContain("No affected server lane");
    expect(ciContent).not.toContain("No affected client lane");
    expect(ciContent).not.toContain("No affected plugin lane");
    expect(ciContent).not.toContain("No affected e2e shard");
    expect(ciContent).not.toContain("No affected smoke lane");
    expect(ciContent).not.toContain("No server test lane is affected");
    expect(ciContent).not.toContain("No client test lane is affected");
    expect(ciContent).not.toContain("No deterministic E2E lane is affected");
    expect(ciContent).not.toContain("No desktop, cloud, or deterministic E2E");
  });

  test("'— not affected' steps maintain conditional gates", () => {
    // Verify each not-affected step has its conditional if clause
    const gateTests = [
      {
        lane: "server",
        gate: "needs.changes.outputs.server != 'true'",
      },
      {
        lane: "client",
        gate: "needs.changes.outputs.client != 'true'",
      },
      {
        lane: "plugins",
        gate: "needs.changes.outputs.plugins != 'true'",
      },
      {
        lane: "e2e shard",
        gate: "needs.changes.outputs.zero_key != 'true'",
      },
      {
        lane: "smoke lane",
        gate: "needs.changes.outputs.desktop != 'true' && needs.changes.outputs.cloud != 'true' && needs.changes.outputs.zero_key != 'true'",
      },
    ];

    for (const { lane, gate } of gateTests) {
      const marker = `— not affected (${lane})`;
      const markerIndex = ciContent.indexOf(marker);
      const section = ciContent.slice(markerIndex, markerIndex + 300);

      expect(
        section,
        `lane "${lane}" should have correct conditional gate`,
      ).toContain(`if: ${gate}`);
    }
  });
});
