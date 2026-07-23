/**
 * Script-test discovery and execution-lane contracts are exercised with hostile
 * synthetic path sets, then checked against the complete real repository tree.
 */

import { describe, expect, test } from "bun:test";
import { resolveReportArtifactPath } from "../lib/report-artifact-path.mjs";
import {
  buildScriptTestInventory,
  SCRIPT_TEST_LANE_COMMANDS,
  SCRIPT_TEST_RUNNER,
} from "../lib/script-test-inventory.mjs";
import {
  parseScriptTestArgs,
  runScriptTests,
  validateJunitEvidence,
} from "../run-script-tests.mjs";

const packageScripts = {
  "test:scripts": SCRIPT_TEST_RUNNER,
  ...SCRIPT_TEST_LANE_COMMANDS,
};
const scenarioWorkflow = `
steps:
  - name: Complete packages/scripts test sweep
    run: bun run test:scripts
`;

function inventory(candidateFiles: string[], options = {}) {
  return buildScriptTestInventory({
    candidateFiles,
    exclusions: new Map(),
    packageScripts,
    scenarioWorkflow,
    verifyReadable: false,
    ...options,
  });
}

describe("packages/scripts executable-test inventory", () => {
  test("discovers every supported extension, nested location, separator, and case", () => {
    const files = [
      "packages/scripts/root.test.ts",
      "packages\\scripts\\cloud\\nested.SPEC.MTS",
      "packages/scripts/a/b/c.test.cts",
      "packages/scripts/a/b/c.spec.js",
      "packages/scripts/a/b/c.test.jsx",
      "packages/scripts/a/b/c.spec.mjs",
      "packages/scripts/a/b/c.test.cjs",
      "packages/scripts/a/b/not-a-test.ts",
      "packages/other/ignored.test.ts",
    ];
    expect(inventory(files).files.map(({ file }) => file)).toEqual([
      "packages/scripts/a/b/c.spec.js",
      "packages/scripts/a/b/c.spec.mjs",
      "packages/scripts/a/b/c.test.cjs",
      "packages/scripts/a/b/c.test.cts",
      "packages/scripts/a/b/c.test.jsx",
      "packages/scripts/cloud/nested.SPEC.MTS",
      "packages/scripts/root.test.ts",
    ]);
  });

  test("rejects empty inventories and case-colliding paths", () => {
    expect(() => inventory(["packages/scripts/helper.ts"])).toThrow(
      "discovered zero",
    );
    expect(() =>
      inventory(["packages/scripts/a.test.ts", "packages/SCRIPTS/A.TEST.TS"]),
    ).toThrow("case-colliding");
  });

  test("requires exact, reasoned, non-stale exclusions", () => {
    const file = "packages/scripts/flaky.test.ts";
    expect(
      inventory([file, "packages/scripts/still-running.test.ts"], {
        exclusions: new Map([
          [file, "requires a hardware fixture unavailable in CI"],
        ]),
      }).excluded,
    ).toEqual([
      {
        file,
        reason: "requires a hardware fixture unavailable in CI",
      },
    ]);
    expect(() =>
      inventory([file, "packages/scripts/still-running.test.ts"], {
        exclusions: new Map([[file, "short"]]),
      }),
    ).toThrow("durable reason");
    expect(() =>
      inventory([file, "packages/scripts/still-running.test.ts"], {
        exclusions: new Map([
          [
            "packages/scripts/deleted.test.ts",
            "tracked by a durable external prerequisite",
          ],
        ]),
      }),
    ).toThrow("stale exclusion");
  });

  test("fails when root or scenario execution lanes drift", () => {
    const files = ["packages/scripts/example.test.ts"];
    expect(() =>
      inventory(files, {
        packageScripts: { ...packageScripts, "test:scripts": "bun test" },
      }),
    ).toThrow("test:scripts must be exactly");
    expect(() =>
      inventory(files, {
        packageScripts: { ...packageScripts, test: "node workspace-tests.mjs" },
      }),
    ).toThrow("package.json test must be exactly");
    expect(() => inventory(files, { scenarioWorkflow: "steps: []" })).toThrow(
      "must own exactly one",
    );
    expect(() =>
      inventory(files, {
        scenarioWorkflow: `
steps:
  - name: Complete packages/scripts test sweep
    if: false
    # run: bun run test:scripts
`,
      }),
    ).toThrow("may not carry a step-level condition");
    expect(() =>
      inventory(files, {
        scenarioWorkflow: `
steps:
  - name: Complete packages/scripts test sweep
    continue-on-error: true
    run: bun run test:scripts
`,
      }),
    ).toThrow("may not continue on error");
    expect(() =>
      inventory(files, {
        scenarioWorkflow: `
steps:
  - name: Complete packages/scripts test sweep
    # run: bun run test:scripts
`,
      }),
    ).toThrow("must execute");
    expect(() =>
      inventory(files, {
        scenarioWorkflow: `
steps:
  - name: Complete packages/scripts test sweep
    with:
      run: bun run test:scripts
  - run: bun run test:scripts
`,
      }),
    ).toThrow("must execute");
    expect(() =>
      inventory(files, {
        scenarioWorkflow: `${scenarioWorkflow}${scenarioWorkflow}`,
      }),
    ).toThrow("must own exactly one");
  });

  test("parses runner input strictly and preserves child failure", () => {
    expect(
      parseScriptTestArgs(["--inventory", "--report", "report.json"]),
    ).toEqual({
      help: false,
      inventoryOnly: true,
      junitPath: undefined,
      reportPath: "report.json",
    });
    expect(parseScriptTestArgs(["--junit", "junit.xml"])).toEqual({
      help: false,
      inventoryOnly: false,
      junitPath: "junit.xml",
      reportPath: undefined,
    });
    expect(() => parseScriptTestArgs(["--unknown"])).toThrow(
      "unknown argument",
    );
    expect(() => parseScriptTestArgs(["--help", "--unknown"])).toThrow(
      "unknown argument",
    );
    expect(() => parseScriptTestArgs(["--help", "--inventory"])).toThrow(
      "cannot be combined",
    );
    expect(() => parseScriptTestArgs(["--report", "-h"])).toThrow(
      "requires a file path",
    );
    expect(() =>
      parseScriptTestArgs(["--inventory", "--junit", "junit.xml"]),
    ).toThrow("cannot be combined");
    const synthetic = inventory(["packages/scripts/example.test.ts"]);
    expect(() =>
      runScriptTests({
        inventory: synthetic,
        junitPath: "package.json",
        spawn: () => ({ error: undefined, signal: null, status: 0 }),
      }),
    ).toThrow("under reports/");
    const status = runScriptTests({
      inventory: synthetic,
      spawn: () => ({ error: undefined, signal: null, status: 19 }),
    });
    expect(status).toBe(19);
  });

  test("records a failed terminal report when Bun cannot start", () => {
    const synthetic = inventory(["packages/scripts/example.test.ts"]);
    const reports: Array<{
      execution: {
        command?: string[];
        exitCode?: number;
        spawnError?: string;
        status: string;
      };
    }> = [];
    expect(() =>
      runScriptTests({
        inventory: synthetic,
        junitPath: "reports/script-tests/runner-command.xml",
        reportPath: "reports/script-tests/inventory.json",
        spawn: () => ({
          error: new Error("executable unavailable"),
          signal: null,
          status: null,
        }),
        writeReport: (_path: string, report: (typeof reports)[number]) => {
          reports.push(report);
        },
      }),
    ).toThrow("could not start Bun");
    expect(reports.map(({ execution }) => execution.status)).toEqual([
      "running",
      "failed",
    ]);
    expect(reports.at(-1)?.execution).toMatchObject({
      exitCode: 1,
      spawnError: "executable unavailable",
      status: "failed",
    });
    const command = reports[0]?.execution.command ?? [];
    expect(command.indexOf("--reporter=junit")).toBeLessThan(
      command.indexOf("packages/scripts/example.test.ts"),
    );
    expect(command.indexOf("--reporter-outfile")).toBe(-1);
    expect(
      command.findIndex((argument) =>
        argument.startsWith("--reporter-outfile="),
      ),
    ).toBeLessThan(command.indexOf("packages/scripts/example.test.ts"));
  });

  test("contains generated evidence under canonical reports paths", () => {
    expect(
      resolveReportArtifactPath(
        "/tmp/example-repository",
        "reports\\script-tests\\junit.xml",
        { extension: ".xml", label: "--junit" },
      ).relative,
    ).toBe("reports/script-tests/junit.xml");
    for (const unsafe of [
      "/tmp/junit.xml",
      "C:\\temp\\junit.xml",
      "junit.xml",
      "reports/../package.json",
      "reports//junit.xml",
      "reports/junit.json",
    ]) {
      expect(() =>
        resolveReportArtifactPath("/tmp/example-repository", unsafe, {
          extension: ".xml",
          label: "--junit",
        }),
      ).toThrow();
    }
  });

  test("binds JUnit counts and suite identities to the discovered files", () => {
    const xml = `<?xml version="1.0"?>
      <testsuites tests="1" assertions="2" failures="0" skipped="0">
        <testsuite file="packages/scripts/example.test.ts">
          <testcase name="works" assertions="2" />
        </testsuite>
      </testsuites>`;
    expect(
      validateJunitEvidence(
        xml,
        ["packages/scripts/example.test.ts"],
        "reports/junit.xml",
      ),
    ).toMatchObject({
      status: "valid",
      tests: 1,
      assertions: 2,
      failures: 0,
      skipped: 0,
      suiteFileCount: 1,
    });
    expect(() =>
      validateJunitEvidence(
        xml,
        ["packages/scripts/missing.test.ts"],
        "reports/junit.xml",
      ),
    ).toThrow("suite-file identity mismatch");
    expect(() =>
      validateJunitEvidence(
        xml.replace('tests="1"', 'tests="2"'),
        ["packages/scripts/example.test.ts"],
        "reports/junit.xml",
      ),
    ).toThrow("testcase count");
    expect(() =>
      validateJunitEvidence('<testsuites tests="0">', [], "reports/junit.xml"),
    ).toThrow("complete testsuites root");
  });

  test("the real repository has one executing lane for every discovered test", () => {
    const result = buildScriptTestInventory();
    expect(result.discoveredCount).toBeGreaterThan(100);
    expect(result.excluded).toEqual([]);
    expect(
      result.files.some(
        ({ file }) =>
          file === "packages/scripts/cloud/admin/bridge-reply-verdict.test.ts",
      ),
    ).toBe(true);
    expect(
      result.files.some(
        ({ file }) =>
          file ===
          "packages/scripts/test-console/__tests__/connections-coverage.test.ts",
      ),
    ).toBe(true);
    for (const entry of result.files) {
      expect(entry.lanes).toHaveLength(3);
      expect(entry.bytes).toBeGreaterThan(0);
      expect(entry.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(result.inventorySha256).toMatch(/^[a-f0-9]{64}$/);
  });
});
