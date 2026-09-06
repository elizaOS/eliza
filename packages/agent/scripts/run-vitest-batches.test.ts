/** Tests batch admission and filesystem evidence reconciliation with deterministic malformed-report fixtures. */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import {
  createBatches,
  createVitestInvocation,
  mergeAgentJunit,
  parseAgentTestArgs,
  positiveInteger,
  resolveBunExecutable,
} from "./run-vitest-batches.mjs";

const fixtureRoot = mkdtempSync(path.join(tmpdir(), "agent-test-runner-"));

function fixtureFile(...segments: string[]): string {
  const filePath = path.join(fixtureRoot, ...segments);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, "fixture");
  return filePath;
}

afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe("agent Vitest batch orchestration", () => {
  test("requires complete reporter arguments and rejects unsupported overrides", () => {
    for (const args of [
      ["--reporter=junit"],
      ["--outputFile.junit=report.xml"],
      ["--reporter=default"],
      ["--outputFile.junit="],
      ["--passWithNoTests"],
      [
        "--reporter=junit",
        "--outputFile.junit=one.xml",
        "--outputFile.junit=two.xml",
      ],
    ]) {
      expect(() => parseAgentTestArgs(args)).toThrow();
    }
    expect(
      parseAgentTestArgs([
        "--reporter=default",
        "--reporter=junit",
        "--outputFile.junit=report.xml",
      ]).reporterOutfile,
    ).toBe("report.xml");
  });

  test("missing, malformed and forged batch evidence cannot publish an aggregate", () => {
    const fragment = path.join(fixtureRoot, "invalid-fragment.xml");
    const destination = path.join(fixtureRoot, "invalid-aggregate.xml");
    expect(() => mergeAgentJunit([fragment], destination)).toThrow();
    for (const xml of [
      "<testsuites>",
      '<testsuites tests="9"><testsuite tests="1"><testcase name="actual" /></testsuite></testsuites>',
      '<testsuites tests="1" failures="1"><testsuite tests="1" failures="1"><testcase name="failed"><failure>assertion</failure></testcase></testsuite></testsuites>',
    ]) {
      writeFileSync(fragment, xml);
      expect(() => mergeAgentJunit([fragment], destination)).toThrow();
      expect(existsSync(destination)).toBe(false);
    }
    expect(() => mergeAgentJunit([], destination)).toThrow();
  });

  test("keeps sorted file membership isolated and complete", () => {
    expect(createBatches(["a.test.ts", "b.test.ts", "c.test.ts"], 1)).toEqual([
      ["a.test.ts"],
      ["b.test.ts"],
      ["c.test.ts"],
    ]);
    expect(createBatches(["a.test.ts", "b.test.ts", "c.test.ts"], 2)).toEqual([
      ["a.test.ts", "b.test.ts"],
      ["c.test.ts"],
    ]);
  });

  test("uses defaults only when unset and rejects malformed values", () => {
    expect(positiveInteger(undefined, "TEST_VALUE", 4)).toBe(4);
    expect(positiveInteger("", "TEST_VALUE", 4)).toBe(4);
    expect(positiveInteger("8", "TEST_VALUE", 4)).toBe(8);
    for (const value of ["0", "-1", "1.5", "abc", "999999999999999999999"]) {
      expect(() => positiveInteger(value, "TEST_VALUE", 4)).toThrow(
        "TEST_VALUE must be a positive integer.",
      );
    }
  });

  test("prefers Bun's validated package-runner executable, including a quoted spaced path", () => {
    const bunExecutable = fixtureFile("Bun Runtime", "bun.exe");
    expect(
      resolveBunExecutable(
        {
          npm_execpath: `"${bunExecutable}"`,
          PATH: "",
        },
        "win32",
      ),
    ).toBe(bunExecutable);
  });

  test("rejects a bunx.cmd package runner and finds bun.exe through PATHEXT", () => {
    const bunxShim = fixtureFile("shim", "bunx.cmd");
    const bunExecutable = fixtureFile("PATH Runtime", "bun.exe");
    expect(
      resolveBunExecutable(
        {
          npm_execpath: bunxShim,
          PATH: `"${path.dirname(bunExecutable)}"`,
          PATHEXT: ".CMD;.EXE",
        },
        "win32",
      ),
    ).toBe(bunExecutable);
  });

  test("resolves the direct Unix Bun executable", () => {
    const bunExecutable = fixtureFile("unix-runtime", "bun");
    expect(
      resolveBunExecutable({ PATH: path.dirname(bunExecutable) }, "linux"),
    ).toBe(bunExecutable);
  });

  test("returns null instead of launching a shell shim when Bun is missing", () => {
    const bunxShim = fixtureFile("only-shim", "bunx.cmd");
    expect(
      resolveBunExecutable(
        {
          npm_execpath: bunxShim,
          PATH: path.dirname(bunxShim),
          PATHEXT: ".CMD;.BAT",
        },
        "win32",
      ),
    ).toBeNull();
  });

  test("builds a shell-free bun x Vitest invocation", () => {
    expect(
      createVitestInvocation("C:/Bun/bun.exe", [
        "src/a.test.ts",
        "src/b.test.ts",
      ]),
    ).toEqual({
      command: "C:/Bun/bun.exe",
      args: [
        "x",
        "vitest",
        "run",
        "--config",
        "vitest.config.ts",
        "src/a.test.ts",
        "src/b.test.ts",
      ],
    });
  });
});
