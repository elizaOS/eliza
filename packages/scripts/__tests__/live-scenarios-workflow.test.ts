/**
 * Pins the credentialed scenario authority's clean-checkout prerequisites,
 * source-export conditions, and honest catalog ownership after no-op workflow
 * entry points are retired.
 */
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { main as auditScenarioCoverage } from "../check-scenario-workflow-coverage.mjs";
import { PLUGIN_ROUTE_COVERAGE } from "../e2e-coverage/manifest.ts";

const workflowPath = fileURLToPath(
  new URL("../../../.github/workflows/live-scenarios.yml", import.meta.url),
);
const agentPackagePath = fileURLToPath(
  new URL("../../agent/package.json", import.meta.url),
);
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const coverageAuditPath = fileURLToPath(
  new URL("../check-scenario-workflow-coverage.mjs", import.meta.url),
);
const workflowReadmePath = fileURLToPath(
  new URL("../../../.github/workflows/README.md", import.meta.url),
);

test("builds the dist-exported runtime packages before the scenario CLI starts", () => {
  const workflow = readFileSync(workflowPath, "utf8");
  const runStep = "- name: Run EA + connector live scenarios";

  expect(workflow).toMatch(
    /package_dirs=\([\s\S]*plugins\/plugin-local-inference[\s\S]*plugins\/plugin-app-control[\s\S]*plugins\/plugin-health[\s\S]*\)[\s\S]*for package_dir in "\$\{package_dirs\[@\]\}"/,
  );
  expect(workflow).toMatch(
    /package_dirs=\([\s\S]*plugins\/plugin-blocker[\s\S]*\)[\s\S]*for package_dir in "\$\{package_dirs\[@\]\}"/,
  );
  expect(workflow.indexOf("package_dirs=(")).toBeLessThan(
    workflow.indexOf(runStep),
  );
});

test("runs every live scenario root against workspace source exports", () => {
  const workflow = readFileSync(workflowPath, "utf8");
  const sourceConditionEntries = [
    ...workflow.matchAll(/NODE_OPTIONS: "--conditions=eliza-source"/g),
  ];
  expect(sourceConditionEntries).toHaveLength(3);
  expect(
    workflow.match(
      /if: \$\{\{ !cancelled\(\) && steps\.build\.outcome == 'success' && !inputs\.scenario_filter \}\}/g,
    ),
  ).toHaveLength(2);
});

test("includes the dynamically loaded app manager in the agent build graph", () => {
  const packageJson = JSON.parse(readFileSync(agentPackagePath, "utf8")) as {
    dependencies?: Record<string, string>;
  };
  expect(packageJson.dependencies?.["@elizaos/plugin-app-manager"]).toBe(
    "workspace:*",
  );
});

test("keeps retired no-op workflow entry points absent", () => {
  for (const workflow of ["gpu-bench-nightly.yml", "scenario-matrix.yml"]) {
    expect(existsSync(path.join(repoRoot, ".github/workflows", workflow))).toBe(
      false,
    );
  }

  const auditSource = readFileSync(coverageAuditPath, "utf8");
  expect(auditSource).not.toContain("ELIZA_SCENARIO_MATRIX_ENABLED");
  expect(auditSource).not.toContain("scenario-matrix.yml");

  const workflowReadme = readFileSync(workflowReadmePath, "utf8");
  expect(workflowReadme).toContain("tracked in #16449");
  expect(workflowReadme).not.toContain("packages/inference/voice-bench");
});

test("reports uncovered live-only scenarios as explicit deferrals", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "scenario-coverage-"));
  const reportDir = path.join(tempRoot, "report");
  try {
    expect(auditScenarioCoverage(["--report-dir", reportDir])).toBe(0);
    const summary = JSON.parse(
      readFileSync(path.join(reportDir, "workflow-coverage.json"), "utf8"),
    ) as {
      deferredLiveOnlyDefaultCount: number;
      deferredDefaultReasons: Record<string, string>;
      missingDefaultIds: string[];
    };
    expect(summary.missingDefaultIds).toEqual([]);
    expect(summary.deferredLiveOnlyDefaultCount).toBeGreaterThan(0);
    expect(Object.values(summary.deferredDefaultReasons)).toContainEqual(
      expect.stringContaining("#16448"),
    );
    expect(PLUGIN_ROUTE_COVERAGE["plugin-personal-assistant"]).toMatchObject({
      status: "exempt",
      reason: expect.stringContaining("live-scenarios.yml"),
    });
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}, 30_000);
