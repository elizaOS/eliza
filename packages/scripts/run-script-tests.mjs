#!/usr/bin/env node
/**
 * Executes every test-bearing file under packages/scripts from one fail-closed inventory.
 *
 * This tree has no package manifest and is invisible to workspace test fan-out,
 * so the runner passes each Git-discovered test to Bun explicitly and records
 * the exact target list before execution. Root tests and scenario CI both call
 * this entrypoint, keeping local, required, and evidence-producing lanes equal.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveReportArtifactPath } from "./lib/report-artifact-path.mjs";
import { buildScriptTestInventory } from "./lib/script-test-inventory.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

export function parseScriptTestArgs(args) {
  let reportPath;
  let junitPath;
  let inventoryOnly = false;
  let help = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--inventory") {
      if (inventoryOnly) {
        throw new Error("--inventory may be specified only once");
      }
      inventoryOnly = true;
      continue;
    }
    if (arg === "--report") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error("--report requires a file path");
      }
      if (reportPath !== undefined) {
        throw new Error("--report may be specified only once");
      }
      reportPath = value;
      index += 1;
      continue;
    }
    if (arg === "--junit") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error("--junit requires a file path");
      }
      if (junitPath !== undefined) {
        throw new Error("--junit may be specified only once");
      }
      junitPath = value;
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      if (help) throw new Error("help may be specified only once");
      help = true;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  if (inventoryOnly && junitPath !== undefined) {
    throw new Error("--inventory and --junit cannot be combined");
  }
  if (
    help &&
    (inventoryOnly || junitPath !== undefined || reportPath !== undefined)
  ) {
    throw new Error("help cannot be combined with execution arguments");
  }
  return { help, inventoryOnly, junitPath, reportPath };
}

function atomicWriteJson(file, value) {
  const { absolute } = resolveReportArtifactPath(REPO_ROOT, file, {
    extension: ".json",
    label: "--report",
  });
  mkdirSync(path.dirname(absolute), { recursive: true });
  const temporary = `${absolute}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, absolute);
}

function reportRecord(inventory, execution) {
  return {
    ...inventory,
    generatedAt: new Date().toISOString(),
    execution,
  };
}

function xmlAttribute(attributes, name) {
  const match = attributes.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`));
  return match?.[1];
}

function integerAttribute(attributes, name) {
  const raw = xmlAttribute(attributes, name);
  if (raw === undefined || !/^(?:0|[1-9]\d*)$/.test(raw)) {
    throw new Error(`JUnit root has no valid ${name} count`);
  }
  return Number(raw);
}

function decodeXmlAttribute(value) {
  const named = {
    "&amp;": "&",
    "&apos;": "'",
    "&gt;": ">",
    "&lt;": "<",
    "&quot;": '"',
  };
  return value.replace(/&(?:amp|apos|gt|lt|quot);/g, (entity) => named[entity]);
}

/** Validate Bun's JUnit artifact and bind it to the discovered source list. */
export function validateJunitEvidence(xml, inventoryFiles, junitPath) {
  if (!xml.trim()) throw new Error("JUnit artifact is empty");
  const roots = [...xml.matchAll(/<testsuites\b([^>]*)>/g)];
  if (roots.length !== 1 || !/<\/testsuites>\s*$/.test(xml)) {
    throw new Error("JUnit artifact must contain one complete testsuites root");
  }
  const attributes = roots[0][1];
  const tests = integerAttribute(attributes, "tests");
  const assertions = integerAttribute(attributes, "assertions");
  const failures = integerAttribute(attributes, "failures");
  const skipped = integerAttribute(attributes, "skipped");
  const testcaseCount = [...xml.matchAll(/<testcase\b/g)].length;
  if (testcaseCount !== tests) {
    throw new Error(
      `JUnit testcase count ${testcaseCount} does not match root tests=${tests}`,
    );
  }
  if (failures + skipped > tests) {
    throw new Error("JUnit failures plus skipped exceeds its test count");
  }

  const suiteFiles = new Set(
    [...xml.matchAll(/<testsuite\b[^>]*\bfile="([^"]+)"/g)].map((match) =>
      decodeXmlAttribute(match[1]),
    ),
  );
  const expectedFiles = new Set(inventoryFiles);
  const missingFiles = [...expectedFiles].filter(
    (file) => !suiteFiles.has(file),
  );
  const unexpectedFiles = [...suiteFiles].filter(
    (file) => !expectedFiles.has(file),
  );
  if (missingFiles.length > 0 || unexpectedFiles.length > 0) {
    throw new Error(
      `JUnit suite-file identity mismatch: ${missingFiles.length} missing, ${unexpectedFiles.length} unexpected`,
    );
  }
  return {
    status: "valid",
    path: junitPath,
    bytes: Buffer.byteLength(xml),
    sha256: createHash("sha256").update(xml).digest("hex"),
    tests,
    assertions,
    failures,
    skipped,
    suiteFileCount: suiteFiles.size,
  };
}

export function runScriptTests(options = {}) {
  const inventory =
    options.inventory ?? buildScriptTestInventory({ repoRoot: REPO_ROOT });
  const reportPath = options.reportPath;
  const junitPath = options.junitPath;
  const writeReport = options.writeReport ?? atomicWriteJson;
  const resolvedReport = reportPath
    ? resolveReportArtifactPath(REPO_ROOT, reportPath, {
        extension: ".json",
        label: "--report",
      })
    : undefined;
  const resolvedJunit = junitPath
    ? resolveReportArtifactPath(REPO_ROOT, junitPath, {
        extension: ".xml",
        label: "--junit",
      })
    : undefined;
  const normalizedReportPath = resolvedReport?.relative;
  const normalizedJunitPath = resolvedJunit?.relative;
  const absoluteJunitPath = resolvedJunit?.absolute;
  if (resolvedReport && absoluteJunitPath === resolvedReport.absolute) {
    throw new Error("--report and --junit must name different files");
  }
  const bunArgs = ["test", "--conditions=eliza-source"];
  if (absoluteJunitPath) {
    mkdirSync(path.dirname(absoluteJunitPath), { recursive: true });
    rmSync(absoluteJunitPath, { force: true });
    bunArgs.push("--reporter=junit", `--reporter-outfile=${absoluteJunitPath}`);
  }
  // Bun stops parsing test-runner options after positional test paths, so
  // evidence flags must precede every inventory entry.
  bunArgs.push(...inventory.files.map(({ file }) => file));

  if (normalizedReportPath) {
    writeReport(
      normalizedReportPath,
      reportRecord(inventory, {
        status: "running",
        command: ["bun", ...bunArgs],
        junit:
          normalizedJunitPath === undefined
            ? null
            : { status: "pending", path: normalizedJunitPath },
      }),
    );
  }

  const spawn = options.spawn ?? spawnSync;
  const result = spawn("bun", bunArgs, {
    cwd: REPO_ROOT,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) {
    if (normalizedReportPath) {
      writeReport(
        normalizedReportPath,
        reportRecord(inventory, {
          status: "failed",
          exitCode: 1,
          signal: null,
          spawnError: result.error.message,
          command: ["bun", ...bunArgs],
          junit:
            normalizedJunitPath === undefined
              ? null
              : { status: "missing", path: normalizedJunitPath },
        }),
      );
    }
    throw new Error("could not start Bun script-test runner", {
      cause: result.error,
    });
  }
  let status =
    typeof result.status === "number" && result.signal === null
      ? result.status
      : 1;
  let junit = null;
  if (absoluteJunitPath && normalizedJunitPath) {
    try {
      junit = validateJunitEvidence(
        readFileSync(absoluteJunitPath, "utf8"),
        inventory.files.map(({ file }) => file),
        normalizedJunitPath,
      );
      if (junit.failures > 0) status = status || 1;
    } catch (error) {
      junit = {
        status: "invalid",
        path: normalizedJunitPath,
        error: error instanceof Error ? error.message : String(error),
      };
      status = status || 1;
    }
  }
  if (normalizedReportPath) {
    writeReport(
      normalizedReportPath,
      reportRecord(inventory, {
        status: status === 0 ? "passed" : "failed",
        exitCode: status,
        signal: result.signal ?? null,
        command: ["bun", ...bunArgs],
        junit,
      }),
    );
  }
  return status;
}

function printUsage() {
  process.stdout.write(
    "Usage: node packages/scripts/run-script-tests.mjs [--inventory] [--report <path>] [--junit <path>]\n",
  );
}

function main() {
  const options = parseScriptTestArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return 0;
  }
  const inventory = buildScriptTestInventory({ repoRoot: REPO_ROOT });
  if (options.inventoryOnly) {
    const output = reportRecord(inventory, { status: "inventory-only" });
    if (options.reportPath) atomicWriteJson(options.reportPath, output);
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    return 0;
  }
  return runScriptTests({
    inventory,
    junitPath: options.junitPath,
    reportPath: options.reportPath,
  });
}

if (import.meta.main || process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (error) {
    // error-policy:J1 the executable boundary converts discovery or process
    // failures into an observable non-zero result.
    process.stderr.write(
      `[script-tests] ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
