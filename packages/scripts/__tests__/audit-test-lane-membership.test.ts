/**
 * Test-lane membership completeness contracts, exercised with synthetic
 * package fixtures, then checked against the real repository tree.
 */
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertExtraScriptNamesCurrent,
  classifyLaneDeclaration,
  computeTestLaneMembershipReport,
  EXTRA_SCRIPT_NAMES,
  extractKnownLaneNames,
  isTestLikeFile,
  TEST_LANE_MEMBERSHIP_EXCLUSIONS,
  testShapedScriptNames,
} from "../audit-test-lane-membership.mjs";

const ROOT_SCRIPTS = {
  "test:server": "node run-all-tests.mjs --lane=server --no-cloud",
  "test:client": "node run-all-tests.mjs --lane=client --no-cloud",
};

function pkg(dir, scripts, name = dir) {
  return { name, dir, packageJson: { name, scripts } };
}

function baseOptions(overrides = {}) {
  return {
    rootScripts: ROOT_SCRIPTS,
    testLaneDeclarations: new Map(),
    cloudRoots: [],
    candidateFiles: [],
    exclusions: new Map(),
    ...overrides,
  };
}

describe("test-shaped script and test-file detection", () => {
  test("recognizes the plain test script and every EXTRA_SCRIPT_NAMES entry", () => {
    expect(testShapedScriptNames({ test: "vitest run" })).toEqual(["test"]);
    for (const extra of EXTRA_SCRIPT_NAMES) {
      expect(testShapedScriptNames({ [extra]: "playwright test" })).toEqual([
        extra,
      ]);
    }
    expect(
      testShapedScriptNames({
        test: "vitest run",
        "test:e2e": "playwright test",
        build: "tsc",
      }),
    ).toEqual(["test", "test:e2e"]);
  });

  test("ignores absent, blank, and non-string script values", () => {
    expect(testShapedScriptNames(undefined)).toEqual([]);
    expect(testShapedScriptNames({})).toEqual([]);
    expect(testShapedScriptNames({ test: "" })).toEqual([]);
    expect(testShapedScriptNames({ test: "   " })).toEqual([]);
    expect(testShapedScriptNames({ test: 12 as unknown as string })).toEqual(
      [],
    );
  });

  test("matches *.test.*/*.spec.* in dot or underscore form, any extension", () => {
    for (const file of [
      "packages/foo/src/bar.test.ts",
      "packages/foo/src/bar.spec.mjs",
      "packages/foo/name_test.py",
      "packages/foo/name_spec.rs",
      "packages/foo/a.b.test.tsx",
    ]) {
      expect(isTestLikeFile(file)).toBe(true);
    }
  });

  test("does not match a bare 'test'/'spec' substring without a separator", () => {
    for (const file of [
      "packages/foo/testing.ts",
      "packages/foo/contest.ts",
      "packages/foo/specimen.ts",
      "packages/foo/index.ts",
    ]) {
      expect(isTestLikeFile(file)).toBe(false);
    }
  });
});

describe("known lane extraction and declaration validity", () => {
  test("extracts every --lane=<name> and --lane <name> from root scripts", () => {
    expect(
      extractKnownLaneNames({
        a: "run-all-tests.mjs --lane=server",
        b: "run-all-tests.mjs --lane client",
        c: "echo unrelated",
      }),
    ).toEqual(["client", "server"]);
    expect(extractKnownLaneNames({})).toEqual([]);
    expect(extractKnownLaneNames(undefined)).toEqual([]);
  });

  test("classifies absent, valid, and invalid testLanes declarations", () => {
    const known = ["client", "server"];
    expect(classifyLaneDeclaration(undefined, known)).toBe("absent");
    expect(classifyLaneDeclaration(["server"], known)).toBe("valid");
    expect(classifyLaneDeclaration(["server", "client"], known)).toBe("valid");
    expect(classifyLaneDeclaration("server", known)).toBe("invalid");
    expect(classifyLaneDeclaration([], known)).toBe("invalid");
    expect(classifyLaneDeclaration(["bogus"], known)).toBe("invalid");
    expect(classifyLaneDeclaration(["server", "bogus"], known)).toBe("invalid");
  });
});

describe("computeTestLaneMembershipReport", () => {
  test("passes a package under plugins/ with no other declaration", () => {
    const report = computeTestLaneMembershipReport(
      baseOptions({
        packages: [pkg("plugins/plugin-example", { test: "vitest run" })],
      }),
    );
    expect(report.relevantPackages).toBe(1);
    expect(report.pluginsOk).toBe(1);
    expect(report.documentedExclusions).toEqual([]);
  });

  test("passes a package with a valid declared test lane", () => {
    const report = computeTestLaneMembershipReport(
      baseOptions({
        packages: [pkg("packages/widgets", { test: "vitest run" })],
        testLaneDeclarations: new Map([["packages/widgets", ["server"]]]),
      }),
    );
    expect(report.laneOk).toBe(1);
  });

  test("passes a package inside a cloud bespoke root in either nesting direction", () => {
    // Root nested under the package dir (e.g. cloudRoutingTests = routing/src).
    const nestedRoot = computeTestLaneMembershipReport(
      baseOptions({
        packages: [pkg("packages/cloud/routing", { test: "bun test" })],
        cloudRoots: ["packages/cloud/routing/src"],
      }),
    );
    expect(nestedRoot.cloudOk).toBe(1);

    // Package nested under the root (e.g. cloudServicesRoot = services/, over
    // every services/* leaf package).
    const nestedPackage = computeTestLaneMembershipReport(
      baseOptions({
        packages: [pkg("packages/cloud/services/leaf", { test: "bun test" })],
        cloudRoots: ["packages/cloud/services"],
      }),
    );
    expect(nestedPackage.cloudOk).toBe(1);
  });

  test("violation: an unaccounted test-shaped script throws an actionable error", () => {
    expect(() =>
      computeTestLaneMembershipReport(
        baseOptions({
          packages: [pkg("packages/orphan", { test: "vitest run" })],
        }),
      ),
    ).toThrow(/packages\/orphan.*test-shaped script.*\[test\]/s);
    try {
      computeTestLaneMembershipReport(
        baseOptions({
          packages: [pkg("packages/orphan", { test: "vitest run" })],
        }),
      );
      throw new Error("expected computeTestLaneMembershipReport to throw");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("(a) under plugins/");
      expect(message).toContain("(b) declaring elizaos.scripts.testLanes");
      expect(message).toContain("(c) inside a");
      expect(message).toContain("(d) named in TEST_LANE_MEMBERSHIP_EXCLUSIONS");
    }
  });

  test("violation: a maintained test file with no test-shaped script (elizaresearch class)", () => {
    expect(() =>
      computeTestLaneMembershipReport(
        baseOptions({
          packages: [pkg("packages/site", {})],
          candidateFiles: ["packages/site/lifecycle.test.mjs"],
        }),
      ),
    ).toThrow(/packages\/site.*no test-shaped script/s);
  });

  test("documented exclusion: a still-true entry passes and is reported", () => {
    const report = computeTestLaneMembershipReport(
      baseOptions({
        packages: [pkg("packages/legacy", { test: "vitest run" })],
        exclusions: new Map([
          ["packages/legacy", "tracked in #99999, needs an owner decision"],
        ]),
      }),
    );
    expect(report.documentedExclusions).toEqual([
      {
        dir: "packages/legacy",
        reason: "tracked in #99999, needs an owner decision",
      },
    ]);
  });

  test("stale exclusion: package is now covered by a declared lane", () => {
    expect(() =>
      computeTestLaneMembershipReport(
        baseOptions({
          packages: [pkg("packages/legacy", { test: "vitest run" })],
          testLaneDeclarations: new Map([["packages/legacy", ["server"]]]),
          exclusions: new Map([
            ["packages/legacy", "tracked in #99999, needs an owner decision"],
          ]),
        }),
      ),
    ).toThrow(/stale exclusion.*packages\/legacy.*now covered/s);
  });

  test("stale exclusion: package no longer has a test-shaped script or test file", () => {
    expect(() =>
      computeTestLaneMembershipReport(
        baseOptions({
          packages: [pkg("packages/legacy", { build: "tsc" })],
          exclusions: new Map([
            ["packages/legacy", "tracked in #99999, needs an owner decision"],
          ]),
        }),
      ),
    ).toThrow(/stale exclusion.*packages\/legacy.*no longer has/s);
  });

  test("stale exclusion: path does not name a real workspace package", () => {
    expect(() =>
      computeTestLaneMembershipReport(
        baseOptions({
          packages: [pkg("packages/legacy", { test: "vitest run" })],
          exclusions: new Map([
            ["packages/deleted", "tracked in #99999, needs an owner decision"],
          ]),
        }),
      ),
    ).toThrow(/exclusion path is not a workspace package: packages\/deleted/);
  });

  test("exclusion requires a durable reason", () => {
    expect(() =>
      computeTestLaneMembershipReport(
        baseOptions({
          packages: [pkg("packages/legacy", { test: "vitest run" })],
          exclusions: new Map([["packages/legacy", "todo"]]),
        }),
      ),
    ).toThrow(/durable reason/);
  });

  test("an invalid testLanes declaration is always a hard failure, exclusion map notwithstanding", () => {
    expect(() =>
      computeTestLaneMembershipReport(
        baseOptions({
          packages: [pkg("packages/typo", { test: "vitest run" })],
          testLaneDeclarations: new Map([["packages/typo", "server"]]),
          exclusions: new Map([
            ["packages/typo", "tracked in #99999, needs an owner decision"],
          ]),
        }),
      ),
    ).toThrow(/invalid.*elizaos\.scripts\.testLanes/s);
  });

  test("a package with neither a test-shaped script nor a test file is not relevant", () => {
    const report = computeTestLaneMembershipReport(
      baseOptions({
        packages: [pkg("packages/docs-only", { build: "tsc" })],
      }),
    );
    expect(report.relevantPackages).toBe(0);
  });
});

describe("assertExtraScriptNamesCurrent", () => {
  const tempDirs: string[] = [];
  function tempRoot() {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "test-lane-membership-"),
    );
    tempDirs.push(root);
    return root;
  }

  test("does not throw against the real repository", () => {
    const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");
    expect(() => assertExtraScriptNamesCurrent(repoRoot)).not.toThrow();
  });

  test("throws when the local copy drifts from run-all-tests.mjs", () => {
    const root = tempRoot();
    fs.mkdirSync(path.join(root, "packages", "scripts"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "packages", "scripts", "run-all-tests.mjs"),
      'const EXTRA_SCRIPT_NAMES = [\n  "test:integration",\n  "test:e2e",\n];\n',
    );
    expect(() => assertExtraScriptNamesCurrent(root)).toThrow(
      "EXTRA_SCRIPT_NAMES drifted",
    );
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the real repository", () => {
  test("has one accounting mechanism for every test-bearing package", () => {
    const report = computeTestLaneMembershipReport();
    expect(report.totalPackages).toBeGreaterThan(100);
    expect(report.relevantPackages).toBeGreaterThan(100);
    expect(
      report.pluginsOk +
        report.laneOk +
        report.cloudOk +
        report.documentedExclusions.length,
    ).toBe(report.relevantPackages);
    expect(report.documentedExclusions.map((entry) => entry.dir)).toEqual([
      "packages/app-core/platforms/electrobun",
      "packages/cloud/e2e",
      "packages/homepage",
    ]);
  }, 15_000);

  test("every documented exclusion in the shipped map is currently valid", () => {
    expect(TEST_LANE_MEMBERSHIP_EXCLUSIONS.size).toBe(3);
    expect(() => computeTestLaneMembershipReport()).not.toThrow();
  }, 15_000);
});
