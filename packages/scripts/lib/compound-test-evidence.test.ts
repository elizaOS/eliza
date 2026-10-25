/** Verifies compound-report reconciliation and package-scoped reporter ownership. */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compoundVitestEvidence,
  readCompoundTestEvidence,
} from "./compound-test-evidence.ts";

const roots: string[] = [];
function directory() {
  const dir = mkdtempSync(join(tmpdir(), "compound-evidence-"));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const report = (name: string, skipped = false) =>
  `<testsuites tests="1" failures="0" errors="0" skipped="${skipped ? 1 : 0}"><testsuite name="${name}" tests="1" failures="0" errors="0" skipped="${skipped ? 1 : 0}"><testcase name="case">${skipped ? "<skipped/>" : ""}</testcase></testsuite></testsuites>`;

test("each invocation gets a distinct report only in the owning package", () => {
  const dir = directory();
  const env = { ELIZA_TEST_EVIDENCE_DIR: dir, ELIZA_TEST_EVIDENCE_CWD: dir };
  const first = compoundVitestEvidence({ ...env }, dir);
  const second = compoundVitestEvidence({ ...env }, dir);
  expect(first.reporters).toEqual(["default", "junit"]);
  expect(first.outputFile?.junit).not.toBe(second.outputFile?.junit);
  expect(compoundVitestEvidence(env, join(dir, "fixture"))).toEqual({});
  expect(compoundVitestEvidence({}, dir)).toEqual({});
  compoundVitestEvidence(env, dir);
  expect(env).toEqual({});
});

test("reconciles every fragment and distinguishes missing from all-skipped evidence", () => {
  const dir = directory();
  expect(readCompoundTestEvidence(dir)).toBeNull();
  writeFileSync(join(dir, "one.xml"), report("one", true));
  expect(readCompoundTestEvidence(dir)?.executedTests).toBe(0);
  writeFileSync(join(dir, "two.xml"), report("two"));
  const result = readCompoundTestEvidence(dir);
  expect(result).toMatchObject({ tests: 2, skipped: 1, executedTests: 1 });
  expect(result?.files.map(({ file }) => file)).toEqual(["one", "two"]);
});

test("rejects an invalid sibling instead of accepting the successful fragment", () => {
  const dir = directory();
  writeFileSync(join(dir, "one.xml"), report("one"));
  writeFileSync(
    join(dir, "two.xml"),
    '<testsuites tests="2"><testsuite tests="0"/></testsuites>',
  );
  expect(() => readCompoundTestEvidence(dir)).toThrow();
});

test("does not read report symlinks", () => {
  const dir = directory();
  const external = directory();
  writeFileSync(join(external, "report.xml"), report("external"));
  symlinkSync(join(external, "report.xml"), join(dir, "report.xml"));
  expect(() => readCompoundTestEvidence(dir)).toThrow("regular JUnit files");
});
