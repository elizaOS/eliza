/** Collects fresh, reconciled Vitest fragments from compound package scripts. */
import { randomUUID } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { MAX_JUNIT_BYTES, parseJunitSummary } from "./junit-summary.ts";

/** Opt in only in the package cwd selected by the parent test runner. */
export function compoundVitestEvidence(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
) {
  const directory = env.ELIZA_TEST_EVIDENCE_DIR;
  const owner = env.ELIZA_TEST_EVIDENCE_CWD;
  if (!directory || !owner || path.resolve(owner) !== path.resolve(cwd))
    return {};
  if (!path.isAbsolute(directory))
    throw new Error("Compound test evidence directory must be absolute");
  // Consume the handshake in this Vitest process before it starts workers.
  // Tests may spawn intentionally failing runners in the same cwd; those
  // descendants must not publish into the enclosing package's evidence.
  // The parent shell retains its environment for the next actual suite.
  delete env.ELIZA_TEST_EVIDENCE_DIR;
  delete env.ELIZA_TEST_EVIDENCE_CWD;
  return {
    reporters: ["default", "junit"] as ["default", "junit"],
    outputFile: { junit: path.join(directory, `${randomUUID()}.xml`) },
  };
}

export function readCompoundTestEvidence(directory: string) {
  const files = readdirSync(directory).sort();
  if (files.length === 0) return null;
  const total: ReturnType<typeof parseJunitSummary> = {
    tests: 0,
    failures: 0,
    errors: 0,
    skipped: 0,
    executedTests: 0,
    files: [],
  };
  let bytes = 0;
  for (const name of files) {
    const file = path.join(directory, name);
    const stat = lstatSync(file);
    if (!name.endsWith(".xml") || !stat.isFile() || stat.isSymbolicLink())
      throw new Error(
        "Compound test evidence must contain regular JUnit files",
      );
    bytes += stat.size;
    if (bytes > MAX_JUNIT_BYTES)
      throw new Error(
        `Compound JUnit artifacts exceed ${MAX_JUNIT_BYTES} bytes`,
      );
    const report = parseJunitSummary(readFileSync(file, "utf8"));
    for (const key of [
      "tests",
      "failures",
      "errors",
      "skipped",
      "executedTests",
    ] as const)
      total[key] += report[key];
    total.files.push(...report.files);
  }
  return total;
}
