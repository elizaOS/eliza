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
    /bun test --conditions=eliza-source "\$\{shared_tests\[@\]\}" --coverage/,
  );
  expect(workflow).toContain(
    "packages/tools/voice-evidence-harness/src/cli-run.test.ts",
  );
  expect(workflow).toMatch(
    /bun test --conditions=eliza-source "\$\{process_isolated_tests\[\$index\]\}" --coverage/,
  );
});

test("Bun suites with conflicting process-global module mocks run separately", () => {
  const workflow = readFileSync(workflowPath, "utf8");
  const chatGroupArm =
    "packages/cloud/api/__tests__/chat-completions-optimistic-billing.test.ts|packages/cloud/api/__tests__/chat-completions-passthrough-streaming.test.ts)";
  const cloudApiArm = [
    "packages/cloud/api/*.test.ts|packages/cloud/api/*.test.tsx|packages/cloud/api/*.spec.ts|packages/cloud/api/*.spec.tsx|packages/cloud/shared/*.test.ts|packages/cloud/shared/*.test.tsx|packages/cloud/shared/*.spec.ts|packages/cloud/shared/*.spec.tsx)",
    '                process_isolated_tests+=("$test_file")',
  ].join("\n");
  const isolatedSuites = [
    "packages/cloud/shared/*.test.ts",
    "packages/tools/voice-evidence-harness/src/cli-run.test.ts",
  ];

  expect(workflow).toContain(chatGroupArm);
  expect(workflow).toContain(cloudApiArm);
  expect(workflow.indexOf(chatGroupArm)).toBeLessThan(
    workflow.indexOf(cloudApiArm),
  );

  for (const suite of isolatedSuites) {
    expect(workflow).toContain(suite);
  }
});

test("changed Vitest coverage tests use package-aware source configuration", () => {
  const workflow = readFileSync(workflowPath, "utf8");
  expect(workflow).toMatch(
    /node packages\/scripts\/run-changed-vitest-coverage[.]mjs "\$\{changed_tests\[@\]\}"/,
  );
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
