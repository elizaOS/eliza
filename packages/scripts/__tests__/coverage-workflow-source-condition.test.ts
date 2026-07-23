/**
 * Pins the clean-checkout coverage lane to source workspace exports so changed
 * Bun and Vitest tests do not depend on prebuilt package artifacts.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const workflowPath = fileURLToPath(
  new URL("../../../.github/workflows/coverage-gate.yml", import.meta.url),
);

test("changed Bun coverage tests use eliza-source workspace exports", () => {
  const workflow = readFileSync(workflowPath, "utf8");
  expect(workflow).toMatch(
    /bun test --conditions=eliza-source "\$\{changed_tests\[\$index\]\}" --coverage/,
  );
});

test("every changed Bun suite gets a fresh process for module-mock isolation", () => {
  const workflow = readFileSync(workflowPath, "utf8");
  expect(workflow).toContain(`for index in "\${!changed_tests[@]}"; do`);
  expect(workflow).toMatch(
    /merge-lcov-reports[.]mjs --remove-inputs coverage\/bun\/lcov[.]info "\$\{isolated_lcov_files\[@\]\}"/,
  );
  expect(workflow).not.toContain("shared_tests");
  expect(workflow).not.toContain("process_isolated_tests");
});

test("changed Vitest coverage tests use package-aware source configuration", () => {
  const workflow = readFileSync(workflowPath, "utf8");
  expect(workflow).toMatch(
    /node packages\/scripts\/run-changed-vitest-coverage[.]mjs "\$\{changed_tests\[@\]\}"/,
  );
  const runner = readFileSync(
    fileURLToPath(
      new URL("../run-changed-vitest-coverage.mjs", import.meta.url),
    ),
    "utf8",
  );
  expect(runner).toContain("vitest.changed-coverage.config.ts");
  expect(runner).toContain("ELIZA_CHANGED_VITEST_CONFIG: group.configPath");
  expect(runner).toContain(
    "ELIZA_CHANGED_VITEST_REPO_ROOT: path.resolve(repoRoot)",
  );
});

test("coverage CI enforces source presence without percentage floors", () => {
  const workflow = readFileSync(workflowPath, "utf8");
  expect(workflow).not.toContain("-v threshold=");
  expect(workflow).toContain('COVERAGE_GATE_ENFORCE: "1"');
  expect(workflow).toContain(
    "::error::changed executable source requires LCOV, but the changed tests produced no report",
  );

  const defaultConfig = readFileSync(
    fileURLToPath(
      new URL("../../test/vitest/default.config.ts", import.meta.url),
    ),
    "utf8",
  );
  expect(defaultConfig).not.toContain("thresholds:");
});

test("cloud/shared coverage resolves the real plugin-sql node source before builds", async () => {
  const { default: config } = await import("../../cloud/shared/vitest.config");
  const aliases = config.resolve?.alias;
  expect(Array.isArray(aliases)).toBe(true);
  if (!Array.isArray(aliases)) {
    throw new Error(
      "Expected cloud/shared Vitest aliases to use the ordered array form",
    );
  }

  const pluginSqlAlias = aliases.find(
    (entry) =>
      typeof entry === "object" &&
      entry !== null &&
      "find" in entry &&
      entry.find instanceof RegExp &&
      entry.find.test("@elizaos/plugin-sql"),
  );
  expect(pluginSqlAlias).toBeDefined();
  if (!pluginSqlAlias || typeof pluginSqlAlias !== "object") {
    throw new Error("Expected an exact @elizaos/plugin-sql source alias");
  }
  if (
    !("find" in pluginSqlAlias) ||
    !(pluginSqlAlias.find instanceof RegExp) ||
    !("replacement" in pluginSqlAlias)
  ) {
    throw new Error(
      "Expected the plugin-sql alias to use a RegExp and replacement path",
    );
  }
  expect(pluginSqlAlias.find.source).toBe("^@elizaos\\/plugin-sql$");
  expect(pluginSqlAlias.find.flags).toBe("");
  expect(pluginSqlAlias.find.test("@elizaos/plugin-sql/schema")).toBe(false);
  expect(pluginSqlAlias.replacement).toBe(
    fileURLToPath(
      new URL("../../../plugins/plugin-sql/src/index.node.ts", import.meta.url),
    ),
  );
  expect(config.test?.pool).toBe("threads");
});

test("Node is available before changed-source classification", () => {
  const workflow = readFileSync(workflowPath, "utf8");
  const setupNode = workflow.indexOf(
    "- name: Setup Node.js for source classification",
  );
  const determineChanged = workflow.indexOf("- name: Determine changed files");

  expect(setupNode).toBeGreaterThan(-1);
  expect(workflow).toContain(
    "uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e",
  );
  expect(workflow).toContain(`node-version: \${{ env.NODE_VERSION }}`);
  expect(setupNode).toBeLessThan(determineChanged);
});
