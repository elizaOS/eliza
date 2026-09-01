/**
 * Script-test discovery and execution-lane contracts are exercised with hostile
 * synthetic path sets, then checked against the complete real repository tree.
 */

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  atomicWriteFileSync,
  resolveReportArtifactPath,
} from "../lib/report-artifact-path.mjs";
import {
  buildScriptTestInventory,
  isScriptTestPath,
  SCRIPT_TEST_EXTENSIONS,
  SCRIPT_TEST_LANE_COMMANDS,
  SCRIPT_TEST_RUNNER,
} from "../lib/script-test-inventory.mjs";
import { spawnSync } from "../lib/spawn-sync-captured.mjs";
import {
  parseScriptTestArgs,
  runScriptTests,
  validateJunitEvidence,
} from "../run-script-tests.mjs";

const packageScripts = {
  "test:scripts": SCRIPT_TEST_RUNNER,
  ...SCRIPT_TEST_LANE_COMMANDS,
};
const ciWorkflow = `
jobs:
  tests:
    steps:
      - name: Script contract tests
        env:
          E2E_COVERAGE_GATE_ENFORCE: "1"
        run: bun run test:scripts
`;
const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "script-inventory-"));
  tempDirs.push(root);
  return root;
}

function inventory(candidateFiles: string[], options = {}) {
  return buildScriptTestInventory({
    candidateFiles,
    exclusions: new Map(),
    packageScripts,
    ciWorkflow,
    verifyReadable: false,
    ...options,
  });
}

describe("packages/scripts executable-test inventory", () => {
  test("discovers every Bun dot/underscore test/spec form, extension, and case", () => {
    const files = [
      "packages/scripts/root.test.ts",
      "packages/cloud/scripts/nested.SPEC.MTS",
      "packages/scripts/a/b/c.test.cts",
      "packages/scripts/a/b/c.spec.js",
      "packages/scripts/a/b/c.test.jsx",
      "packages/scripts/a/b/c.spec.mjs",
      "packages/scripts/a/b/c.test.cjs",
      "packages/scripts/a/b/name_test.tsx",
      "packages/scripts/a/b/name_spec.js",
      "packages/scripts/a/b/_test.ts",
      "packages/scripts/a/b/_spec.mts",
      "packages/scripts/a/b/.test.ts",
      "packages/scripts/a/b/.spec.cjs",
      "packages/scripts/a/b/not-a-test.ts",
      "packages/other/ignored.test.ts",
      "scripts/tooling.test.mjs",
      "scripts/nested/deep/case.SPEC.TS",
      "scripts/not-a-test.mjs",
      "scripts-adjacent/ignored.test.mjs",
      "packages/ui/scripts/ignored.test.ts",
    ];
    expect(inventory(files).files.map(({ file }) => file)).toEqual([
      "packages/cloud/scripts/nested.SPEC.MTS",
      "packages/scripts/a/b/.spec.cjs",
      "packages/scripts/a/b/.test.ts",
      "packages/scripts/a/b/_spec.mts",
      "packages/scripts/a/b/_test.ts",
      "packages/scripts/a/b/c.spec.js",
      "packages/scripts/a/b/c.spec.mjs",
      "packages/scripts/a/b/c.test.cjs",
      "packages/scripts/a/b/c.test.cts",
      "packages/scripts/a/b/c.test.jsx",
      "packages/scripts/a/b/name_spec.js",
      "packages/scripts/a/b/name_test.tsx",
      "packages/scripts/root.test.ts",
      "scripts/nested/deep/case.SPEC.TS",
      "scripts/tooling.test.mjs",
    ]);
    expect(() =>
      inventory(["packages\\scripts\\cloud\\nested.test.ts"]),
    ).toThrow("backslash");
  });

  test("rejects empty inventories and case-colliding paths", () => {
    expect(() => inventory(["packages/scripts/helper.ts"])).toThrow(
      "discovered zero",
    );
    expect(() =>
      inventory(["packages/scripts/a.test.ts", "packages/SCRIPTS/A.TEST.TS"]),
    ).toThrow("case-colliding");
  });

  test("matches Bun's recursive discovery across every supported naming form", () => {
    const root = tempRoot();
    const forms = [
      (extension: string) => `dot.test.${extension}`,
      (extension: string) => `underscore_test.${extension}`,
      (extension: string) => `bare_test/_test.${extension}`,
      (extension: string) => `dot.spec.${extension}`,
      (extension: string) => `underscore_spec.${extension}`,
      (extension: string) => `bare_spec/_spec.${extension}`,
    ];
    const fixtures = SCRIPT_TEST_EXTENSIONS.flatMap((extension, index) =>
      forms.map(
        (form) =>
          `packages/scripts/nested/${form(index % 2 ? extension.toUpperCase() : extension)}`,
      ),
    );
    fixtures.push("packages/scripts/nested/not-a-test.ts");
    for (const file of fixtures) {
      const absolute = path.join(root, ...file.split("/"));
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(
        absolute,
        'import { expect, test } from "bun:test"; test("runs", () => expect(1).toBe(1));\n',
      );
    }
    const junit = path.join(root, "junit.xml");
    const result = spawnSync(
      "bun",
      [
        "test",
        "--reporter=junit",
        `--reporter-outfile=${junit}`,
        "packages/scripts",
      ],
      { cwd: root, encoding: "utf8" },
    );
    expect(result.status).toBe(0);
    const bunFiles = [
      ...fs
        .readFileSync(junit, "utf8")
        .matchAll(/<testsuite\b[^>]*\bfile="([^"]+)"/g),
    ]
      .map((match) => match[1].replaceAll("\\", "/"))
      .sort();
    const inventoryFiles = fixtures.filter(isScriptTestPath).sort();
    expect(bunFiles).toEqual(inventoryFiles);
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

  test("fails when root or CI execution lanes drift", () => {
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
    expect(() => inventory(files, { ciWorkflow: "jobs: {}" })).toThrow(
      "jobs.tests",
    );
    expect(() =>
      inventory(files, {
        ciWorkflow: `
jobs:
  tests:
    steps:
      - name: Script contract tests
        if: false
        env:
          E2E_COVERAGE_GATE_ENFORCE: "1"
        run: bun run test:scripts
`,
      }),
    ).toThrow("may not declare if");
    expect(() =>
      inventory(files, {
        ciWorkflow: `
jobs:
  tests:
    continue-on-error: true
    steps:
      - name: Script contract tests
        env:
          E2E_COVERAGE_GATE_ENFORCE: "1"
        run: bun run test:scripts
`,
      }),
    ).toThrow("tests job may not continue on error");
    expect(() =>
      inventory(files, {
        ciWorkflow: `
jobs:
  tests:
    steps:
      - name: Script contract tests
        env:
          E2E_COVERAGE_GATE_ENFORCE: "1"
`,
      }),
    ).toThrow("must be a string scalar");
    expect(() =>
      inventory(files, {
        ciWorkflow: `
jobs:
  disabled-copy:
    steps:
      - name: Script contract tests
        run: bun run test:scripts
  tests:
    steps: []
`,
      }),
    ).toThrow("must own exactly one");
    expect(() =>
      inventory(files, {
        ciWorkflow: `
jobs:
  tests:
    steps:
      - name: Script contract tests
        run: bun run test:scripts
`,
      }),
    ).toThrow("must enforce the E2E coverage gate");
    expect(() =>
      inventory(files, {
        ciWorkflow: `
jobs:
  tests:
    steps:
      - name: Script contract tests
        env:
          E2E_COVERAGE_GATE_ENFORCE: "1"
        run: |
          echo "bun run test:scripts"
`,
      }),
    ).toThrow("must use plain YAML scalar syntax");
    expect(() =>
      inventory(files, {
        ciWorkflow: `${ciWorkflow}
jobs:
  duplicate: {}
`,
      }),
    ).toThrow("Map keys must be unique");
    expect(() =>
      inventory(files, {
        ciWorkflow: `
base: &base
  run: bun run test:scripts
jobs:
  tests:
    steps:
      - name: Script contract tests
        <<: *base
        env:
          E2E_COVERAGE_GATE_ENFORCE: "1"
`,
      }),
    ).toThrow(/aliases|merge keys/);
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
    expect(command.slice(0, 3)).toEqual([
      "node",
      "packages/scripts/run-script-test-files.mjs",
      "--config=packages/scripts/bunfig.script-tests.toml",
    ]);
    expect(command).toContain("--concurrency=1");
    expect(
      command.findIndex((argument) => argument.startsWith("--junit=")),
    ).toBeLessThan(command.indexOf("packages/scripts/example.test.ts"));
  });

  test("records Bun child and JUnit evidence exits independently", () => {
    const file = "packages/scripts/example.test.ts";
    const synthetic = inventory([file]);
    const reports: Array<{
      execution: {
        childExitCode?: number | null;
        evidenceExitCode?: number | null;
        exitCode?: number;
        junit?: { status: string };
        status: string;
      };
    }> = [];
    const status = runScriptTests({
      inventory: synthetic,
      junitPath: "reports/script-tests/separate-exits.xml",
      reportPath: "reports/script-tests/separate-exits.json",
      spawn: () => ({ error: undefined, signal: null, status: 0 }),
      readJunit: () =>
        `<testsuites tests="1" assertions="1" failures="0" skipped="0">
          <testsuite name="${file}" file="${file}" tests="1" assertions="1" failures="0" skipped="0">
            <unsupported />
            <testcase name="works" file="${file}" assertions="1" />
          </testsuite>
        </testsuites>`,
      writeReport: (_path: string, report: (typeof reports)[number]) => {
        reports.push(report);
      },
    });
    expect(status).toBe(1);
    expect(reports.at(-1)?.execution).toMatchObject({
      status: "failed",
      exitCode: 1,
      childExitCode: 0,
      evidenceExitCode: 1,
      junit: { status: "invalid" },
    });

    reports.length = 0;
    const childFailure = runScriptTests({
      inventory: synthetic,
      junitPath: "reports/script-tests/child-failure.xml",
      reportPath: "reports/script-tests/child-failure.json",
      spawn: () => ({ error: undefined, signal: null, status: 19 }),
      readJunit: () =>
        `<testsuites tests="1" assertions="1" failures="0" skipped="0">
          <testsuite name="${file}" file="${file}" tests="1" assertions="1" failures="0" skipped="0">
            <testcase name="works" file="${file}" assertions="1" />
          </testsuite>
        </testsuites>`,
      writeReport: (_path: string, report: (typeof reports)[number]) => {
        reports.push(report);
      },
    });
    expect(childFailure).toBe(19);
    expect(reports.at(-1)?.execution).toMatchObject({
      status: "failed",
      exitCode: 19,
      childExitCode: 19,
      evidenceExitCode: 0,
      junit: { status: "valid" },
    });
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
      "reports/C:../package.xml",
      "reports/CON.xml",
      "reports/name.xml ",
      "reports/name.xml.",
    ]) {
      expect(() =>
        resolveReportArtifactPath("/tmp/example-repository", unsafe, {
          extension: ".xml",
          label: "--junit",
        }),
      ).toThrow();
    }

    const root = tempRoot();
    const outside = path.join(root, "outside");
    fs.mkdirSync(path.join(root, "reports"));
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(root, "reports", "script-tests"));
    expect(() =>
      resolveReportArtifactPath(root, "reports/script-tests/junit.xml", {
        extension: ".xml",
        label: "--junit",
      }),
    ).toThrow("symlinked parent");
  });

  test("uses an exclusive same-directory temporary and cleans failed writes", () => {
    const root = tempRoot();
    const reports = path.join(root, "reports");
    fs.mkdirSync(reports);
    const destination = path.join(reports, "result.json");
    const victim = path.join(root, "victim.txt");
    fs.writeFileSync(victim, "unchanged");
    const occupied = `${destination}.123.deadbeef.tmp`;
    fs.symlinkSync(victim, occupied);
    expect(() =>
      atomicWriteFileSync(destination, "replacement", {
        pid: 123,
        randomToken: "deadbeef",
      }),
    ).toThrow();
    expect(fs.readFileSync(victim, "utf8")).toBe("unchanged");
    expect(fs.existsSync(occupied)).toBe(false);
    expect(fs.existsSync(destination)).toBe(false);

    fs.mkdirSync(destination);
    const failedTemporary = `${destination}.456.cafefeed.tmp`;
    expect(() =>
      atomicWriteFileSync(destination, "replacement", {
        pid: 456,
        randomToken: "cafefeed",
      }),
    ).toThrow();
    expect(fs.existsSync(failedTemporary)).toBe(false);
  });

  test("rejects symlinked script-test sources", () => {
    const root = tempRoot();
    const source = path.join(root, "source.ts");
    const testFile = "packages/scripts/linked.test.ts";
    fs.writeFileSync(source, 'test("not repository-owned", () => {});\n');
    fs.mkdirSync(path.join(root, "packages", "scripts"), { recursive: true });
    fs.symlinkSync(source, path.join(root, ...testFile.split("/")));
    expect(() =>
      inventory([testFile], {
        repoRoot: root,
        verifyReadable: true,
      }),
    ).toThrow("may not traverse a symlink");
  });

  test("binds JUnit counts and suite identities to the discovered files", () => {
    const xml = `<?xml version="1.0"?>
      <testsuites tests="1" assertions="2" failures="0" skipped="0">
        <testsuite name="packages/scripts/example.test.ts" file="packages/scripts/example.test.ts" tests="1" assertions="2" failures="0" skipped="0">
          <testcase name="works" file="packages/scripts/example.test.ts" assertions="2" />
        </testsuite>
      </testsuites>`;
    const suiteXml = xml.slice(
      xml.indexOf("<testsuite "),
      xml.lastIndexOf("</testsuite>") + "</testsuite>".length,
    );
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
    expect(
      validateJunitEvidence(
        xml.replaceAll(
          "packages/scripts/example.test.ts",
          "packages\\scripts\\example.test.ts",
        ),
        ["packages/scripts/example.test.ts"],
        "reports/junit.xml",
      ),
    ).toMatchObject({
      status: "valid",
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
    ).toThrow("root tests");
    expect(() =>
      validateJunitEvidence('<testsuites tests="0">', [], "reports/junit.xml"),
    ).toThrow();
    expect(() =>
      validateJunitEvidence(
        `${xml.slice(0, -1)} garbage`,
        ["packages/scripts/example.test.ts"],
        "reports/junit.xml",
      ),
    ).toThrow();
    expect(() =>
      validateJunitEvidence(
        `<!DOCTYPE testsuites [<!ENTITY injected "x">]>${xml}`,
        ["packages/scripts/example.test.ts"],
        "reports/junit.xml",
      ),
    ).toThrow("DOCTYPE");
    expect(() =>
      validateJunitEvidence(
        xml.replace(
          "</testsuite>",
          '<testcase name="hidden failure" file="packages/scripts/example.test.ts" assertions="0"><failure>boom</failure></testcase></testsuite>',
        ),
        ["packages/scripts/example.test.ts"],
        "reports/junit.xml",
      ),
    ).toThrow(/tests|failures/);
    expect(() =>
      validateJunitEvidence(
        xml.replace("</testsuites>", `${suiteXml}</testsuites>`),
        ["packages/scripts/example.test.ts"],
        "reports/junit.xml",
      ),
    ).toThrow("duplicate top-level suite");
    expect(() =>
      validateJunitEvidence(
        xml.replace(
          'assertions="2" failures="0" skipped="0">',
          'assertions="2" failures="0" skipped="0"><failure>boom</failure>',
        ),
        ["packages/scripts/example.test.ts"],
        "reports/junit.xml",
      ),
    ).toThrow("invalid location");

    const zeroAssertions = xml.replaceAll('assertions="2"', 'assertions="0"');
    expect(
      validateJunitEvidence(
        zeroAssertions,
        ["packages/scripts/example.test.ts"],
        "reports/junit.xml",
      ),
    ).toMatchObject({ assertions: 0, status: "valid" });

    const skipped = xml
      .replaceAll('skipped="0"', 'skipped="1"')
      .replace('assertions="2" />', 'assertions="2"><skipped /></testcase>');
    expect(() =>
      validateJunitEvidence(
        skipped,
        ["packages/scripts/example.test.ts"],
        "reports/junit.xml",
        () => new Set(),
      ),
    ).toThrow(
      /skipped test\(s\) in packages\/scripts\/example\.test\.ts.*statically.*runtime-conditional/,
    );
    const classifierCalls: string[][] = [];
    expect(
      validateJunitEvidence(
        skipped,
        ["packages/scripts/example.test.ts"],
        "reports/junit.xml",
        (files: string[]) => {
          classifierCalls.push([...files]);
          return new Set(files);
        },
      ),
    ).toMatchObject({
      status: "valid",
      skipped: 1,
      skippedFiles: ["packages/scripts/example.test.ts"],
    });
    expect(classifierCalls).toEqual([["packages/scripts/example.test.ts"]]);
    expect(() =>
      validateJunitEvidence(
        skipped,
        ["packages/scripts/example.test.ts"],
        "reports/junit.xml",
        () => {
          throw new Error("classifier exploded");
        },
      ),
    ).toThrow("classifier exploded");
    expect(
      validateJunitEvidence(
        xml,
        ["packages/scripts/example.test.ts"],
        "reports/junit.xml",
        () => {
          throw new Error("zero-skip artifacts must not invoke the classifier");
        },
      ),
    ).toMatchObject({ status: "valid", skipped: 0, skippedFiles: [] });

    const emptySuite =
      '<testsuite name="packages/scripts/empty.test.ts" file="packages/scripts/empty.test.ts" tests="0" assertions="0" failures="0" skipped="0"></testsuite>';
    expect(() =>
      validateJunitEvidence(
        xml.replace(
          '<testsuites tests="1" assertions="2" failures="0" skipped="0">',
          '<testsuites tests="1" assertions="2" failures="0" skipped="0">' +
            emptySuite,
        ),
        ["packages/scripts/empty.test.ts", "packages/scripts/example.test.ts"],
        "reports/junit.xml",
      ),
    ).toThrow("contains zero testcases");

    expect(() =>
      validateJunitEvidence(
        '<testsuites tests="0" assertions="0" failures="0" skipped="0"></testsuites>',
        [],
        "reports/junit.xml",
      ),
    ).toThrow("contains zero tests");
    expect(() =>
      validateJunitEvidence(
        xml.replace(
          '<testsuites tests="1" assertions="2" failures="0" skipped="0">',
          '<testsuites tests="1" assertions="2" failures="0" skipped="0"><![CDATA[smuggled]]>',
        ),
        ["packages/scripts/example.test.ts"],
        "reports/junit.xml",
      ),
    ).toThrow("unexpected CDATA");
  });

  test("accepts exact Bun CI properties and rejects metadata smuggling", () => {
    const file = "packages/scripts/example.test.ts";
    const base = `<?xml version="1.0" encoding="UTF-8"?>
      <testsuites name="bun test" tests="1" assertions="2" failures="0" skipped="0" time="0.1">
        <testsuite name="${file}" file="${file}" tests="1" assertions="2" failures="0" skipped="0" time="0.1" hostname="runnervmvrwv9">
          METADATA
          <testcase name="works" classname="" time="0.01" file="${file}" line="1" assertions="2" />
        </testsuite>
      </testsuites>`;
    const exactBunCiMetadata = `<properties>
      <property name="ci" value="https://github.com/elizaOS/eliza/actions/runs/30391860793" />
      <property name="commit" value="5276c1b2ba32a51a938e8489b87a8c92e5ca03d8" />
    </properties>`;
    const documentWith = (metadata: string) =>
      base.replace("METADATA", metadata);

    expect(
      validateJunitEvidence(
        documentWith(exactBunCiMetadata),
        [file],
        "reports/junit.xml",
      ),
    ).toMatchObject({
      status: "valid",
      tests: 1,
      assertions: 2,
      suiteFileCount: 1,
    });

    const invalidMetadata = [
      {
        name: "root location",
        xml: documentWith("").replace(
          "<testsuites ",
          `${exactBunCiMetadata}<testsuites `,
        ),
      },
      {
        name: "property outside its container",
        xml: documentWith('<property name="ci" value="run" />'),
      },
      {
        name: "duplicate container",
        xml: documentWith(`${exactBunCiMetadata}${exactBunCiMetadata}`),
      },
      {
        name: "duplicate property name",
        xml: documentWith(
          '<properties><property name="ci" value="run" /><property name="ci" value="other" /></properties>',
        ),
      },
      {
        name: "missing name",
        xml: documentWith('<properties><property value="run" /></properties>'),
      },
      {
        name: "blank name",
        xml: documentWith(
          '<properties><property name="  " value="run" /></properties>',
        ),
      },
      {
        name: "missing value",
        xml: documentWith('<properties><property name="ci" /></properties>'),
      },
      {
        name: "blank value",
        xml: documentWith(
          '<properties><property name="ci" value="  " /></properties>',
        ),
      },
      {
        name: "extra property attribute",
        xml: documentWith(
          '<properties><property name="ci" value="run" file="smuggled.test.ts" /></properties>',
        ),
      },
      {
        name: "container attribute",
        xml: documentWith(
          '<properties tests="1"><property name="ci" value="run" /></properties>',
        ),
      },
      {
        name: "text content",
        xml: documentWith(
          '<properties>smuggled<property name="ci" value="run" /></properties>',
        ),
      },
      {
        name: "nested properties",
        xml: documentWith(
          '<properties><properties><property name="ci" value="run" /></properties></properties>',
        ),
      },
      {
        name: "testcase smuggling",
        xml: documentWith(
          `<properties><property name="ci" value="run"><testcase name="hidden" file="${file}" assertions="99" /></property></properties>`,
        ),
      },
    ];
    expect(
      invalidMetadata.map(({ name, xml }) => {
        try {
          validateJunitEvidence(xml, [file], "reports/junit.xml");
          return { name, rejected: false };
        } catch {
          return { name, rejected: true };
        }
      }),
    ).toEqual(invalidMetadata.map(({ name }) => ({ name, rejected: true })));
  });

  test("binds JUnit skip evidence to the real conditional-skip classifier", () => {
    // Platform-gated executed suites (`const suite = GNU_SED ? describe :
    // describe.skip`) are the only files permitted to report skips; a skip in
    // any other discovered file is silently-dropped coverage and must fail.
    const conditional =
      "packages/scripts/__tests__/cloud-cf-voice-deploy-workflow.test.ts";
    const unconditional =
      "packages/scripts/__tests__/script-test-inventory.test.ts";
    const junitFor = (file: string) => `<?xml version="1.0"?>
      <testsuites tests="2" assertions="2" failures="0" skipped="1">
        <testsuite name="${file}" file="${file}" tests="2" assertions="2" failures="0" skipped="1">
          <testcase name="works" file="${file}" assertions="2" />
          <testcase name="gated" file="${file}" assertions="0"><skipped /></testcase>
        </testsuite>
      </testsuites>`;
    expect(
      validateJunitEvidence(
        junitFor(conditional),
        [conditional],
        "reports/junit.xml",
      ),
    ).toMatchObject({
      status: "valid",
      skipped: 1,
      skippedFiles: [conditional],
    });
    expect(() =>
      validateJunitEvidence(
        junitFor(unconditional),
        [unconditional],
        "reports/junit.xml",
      ),
    ).toThrow("statically classified as runtime-conditional");
    // Fail-closed: a skipping suite file the classifier cannot read is a hard
    // error, never a pass.
    const unreadable = "packages/scripts/deleted-in-tree.test.ts";
    expect(() =>
      validateJunitEvidence(
        junitFor(unreadable),
        [unreadable],
        "reports/junit.xml",
      ),
    ).toThrow();
  });

  test("the real repository has one executing lane for every discovered test", () => {
    const result = buildScriptTestInventory();
    expect(result.discoveredCount).toBeGreaterThan(90);
    expect(result.excluded).toEqual([
      {
        file: "packages/scripts/__tests__/release-verdaccio.integration.test.ts",
        reason:
          "the release-candidate workflow owns this slow real-registry transport test",
      },
    ]);
    expect(
      result.files.some(
        ({ file }) =>
          file === "packages/cloud/scripts/admin/bridge-reply-verdict.test.ts",
      ),
    ).toBe(true);
    expect(
      result.files.some(
        ({ file }) =>
          file ===
          "packages/scripts/test-console/__tests__/connections-coverage.test.ts",
      ),
    ).toBe(true);
    // The #19445 gap: root-level scripts/ tests must be discovered, the
    // security-advisory-gate suite among them.
    expect(
      result.files.some(
        ({ file }) =>
          file === "scripts/security/security-advisory-gate.test.mjs",
      ),
    ).toBe(true);
    for (const entry of result.files) {
      expect(entry.lanes).toHaveLength(3);
      expect(entry.bytes).toBeGreaterThan(0);
      expect(entry.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(result.inventorySha256).toMatch(/^[a-f0-9]{64}$/);
  }, 15_000);
});
