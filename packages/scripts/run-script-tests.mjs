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
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SaxesParser } from "saxes";
import { conditionalSkipBearingFiles } from "./audit-focused-skipped-tests.mjs";
import {
  atomicWriteJsonSync,
  resolveReportArtifactPath,
} from "./lib/report-artifact-path.mjs";
import { buildScriptTestInventory } from "./lib/script-test-inventory.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const SCRIPT_TEST_BUN_CONFIG = "packages/scripts/bunfig.script-tests.toml";
const ISOLATED_TEST_DRIVER = "packages/scripts/run-script-test-files.mjs";

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
  atomicWriteJsonSync(absolute, value);
}

function reportRecord(inventory, execution) {
  return {
    ...inventory,
    generatedAt: new Date().toISOString(),
    execution,
  };
}

function integerAttribute(attributes, name, label) {
  const raw = attributes[name];
  if (raw === undefined || !/^(?:0|[1-9]\d*)$/.test(raw)) {
    throw new Error(`JUnit ${label} has no valid ${name} count`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`JUnit ${label} has no safe ${name} count`);
  }
  return value;
}

function parseJunitDocument(xml) {
  const parser = new SaxesParser({ xmlns: false });
  const stack = [];
  let root;

  parser.on("doctype", () => {
    throw new Error("JUnit artifact may not contain a DOCTYPE");
  });
  parser.on("opentag", (tag) => {
    if (
      ![
        "testsuites",
        "testsuite",
        "properties",
        "property",
        "testcase",
        "failure",
        "skipped",
      ].includes(tag.name)
    ) {
      throw new Error(
        `JUnit artifact contains unsupported <${tag.name}> element`,
      );
    }
    const parent = stack.at(-1);
    const allowed =
      (tag.name === "testsuites" && parent === undefined) ||
      (tag.name === "testsuite" &&
        (parent?.name === "testsuites" || parent?.name === "testsuite")) ||
      (tag.name === "properties" && parent?.name === "testsuite") ||
      (tag.name === "property" && parent?.name === "properties") ||
      (tag.name === "testcase" && parent?.name === "testsuite") ||
      ((tag.name === "failure" || tag.name === "skipped") &&
        parent?.name === "testcase");
    if (!allowed) {
      throw new Error(
        `JUnit artifact contains <${tag.name}> in an invalid location`,
      );
    }
    if (tag.name === "testsuites" && root !== undefined) {
      throw new Error(
        "JUnit artifact must contain one complete testsuites root",
      );
    }
    if (tag.name === "properties") {
      if (Object.keys(tag.attributes).length > 0) {
        throw new Error("JUnit properties container may not have attributes");
      }
      if (parent.children.some(({ name }) => name === "properties")) {
        throw new Error(
          "JUnit testsuite may contain only one properties container",
        );
      }
    }
    if (tag.name === "property") {
      const attributeNames = Object.keys(tag.attributes).sort();
      if (
        attributeNames.length !== 2 ||
        attributeNames[0] !== "name" ||
        attributeNames[1] !== "value"
      ) {
        throw new Error(
          "JUnit property must contain only name and value attributes",
        );
      }
      const name = tag.attributes.name;
      const value = tag.attributes.value;
      if (
        typeof name !== "string" ||
        name.trim().length === 0 ||
        typeof value !== "string" ||
        value.trim().length === 0
      ) {
        throw new Error(
          "JUnit property must have nonempty name and value attributes",
        );
      }
      if (
        parent.children.some(
          (child) =>
            child.name === "property" && child.attributes.name === name,
        )
      ) {
        throw new Error(`JUnit properties contains duplicate name ${name}`);
      }
    }
    const node = {
      name: tag.name,
      attributes: tag.attributes,
      children: [],
    };
    if (parent) parent.children.push(node);
    else root = node;
    stack.push(node);
  });
  parser.on("closetag", () => {
    stack.pop();
  });
  parser.on("text", (text) => {
    if (text.trim() && !["failure", "skipped"].includes(stack.at(-1)?.name)) {
      throw new Error("JUnit artifact contains unexpected text content");
    }
  });
  parser.on("cdata", (text) => {
    if (text.trim() && !["failure", "skipped"].includes(stack.at(-1)?.name)) {
      throw new Error("JUnit artifact contains unexpected CDATA content");
    }
  });
  parser.write(xml).close();
  if (root?.name !== "testsuites" || stack.length !== 0) {
    throw new Error("JUnit artifact must contain one complete testsuites root");
  }
  return root;
}

function normalizeRepositoryIdentity(value) {
  return typeof value === "string" ? value.replaceAll("\\", "/") : value;
}

function reconcileTestcase(testcase, suiteFile) {
  const file = normalizeRepositoryIdentity(testcase.attributes.file);
  if (file !== suiteFile) {
    throw new Error(
      `JUnit testcase file ${file ?? "<missing>"} does not match suite file ${suiteFile}`,
    );
  }
  const assertions = integerAttribute(
    testcase.attributes,
    "assertions",
    "testcase",
  );
  const failures = testcase.children.filter(
    ({ name }) => name === "failure",
  ).length;
  const skipped = testcase.children.filter(
    ({ name }) => name === "skipped",
  ).length;
  if (failures > 1 || skipped > 1 || failures + skipped > 1) {
    throw new Error(
      "JUnit testcase may contain at most one failure or skipped result",
    );
  }
  return { tests: 1, assertions, failures, skipped };
}

function reconcileSuite(suite, inheritedFile, identities) {
  const file = normalizeRepositoryIdentity(suite.attributes.file);
  if (typeof file !== "string" || file.length === 0) {
    throw new Error("JUnit testsuite has no file identity");
  }
  if (inheritedFile !== undefined && file !== inheritedFile) {
    throw new Error(
      `JUnit nested testsuite file ${file} does not match parent file ${inheritedFile}`,
    );
  }
  const identity = `${file}\0${suite.attributes.name ?? ""}\0${suite.attributes.line ?? ""}`;
  if (identities.has(identity)) {
    throw new Error(`JUnit contains duplicate testsuite identity for ${file}`);
  }
  identities.add(identity);

  const actual = { tests: 0, assertions: 0, failures: 0, skipped: 0 };
  for (const child of suite.children) {
    if (child.name === "properties") continue;
    const counts =
      child.name === "testcase"
        ? reconcileTestcase(child, file)
        : reconcileSuite(child, file, identities);
    for (const key of Object.keys(actual)) actual[key] += counts[key];
  }
  for (const key of Object.keys(actual)) {
    const declared = integerAttribute(
      suite.attributes,
      key,
      `testsuite ${file}`,
    );
    if (declared !== actual[key]) {
      throw new Error(
        `JUnit testsuite ${file} ${key}=${declared} does not match nested ${key}=${actual[key]}`,
      );
    }
  }
  return actual;
}

/**
 * Validate Bun's JUnit artifact and bind it to the discovered source list.
 *
 * Skipped testcases are permitted only in suite files whose source carries a
 * statically classified runtime-conditional skip (platform/credential gates
 * like `const suite = GNU_SED ? describe : describe.skip`); the anti-larp
 * classifier in audit-focused-skipped-tests.mjs is the single authority for
 * that set. Any other skip means discovered coverage silently stopped running.
 */
export function validateJunitEvidence(
  xml,
  inventoryFiles,
  junitPath,
  classifyConditionalSkipFiles = conditionalSkipBearingFiles,
) {
  if (!xml.trim()) throw new Error("JUnit artifact is empty");
  const root = parseJunitDocument(xml);
  const directSuites = root.children.filter(({ name }) => name === "testsuite");
  if (directSuites.length !== root.children.length) {
    throw new Error(
      "JUnit testsuites root may contain only testsuite elements",
    );
  }
  const suiteFiles = new Set();
  const identities = new Set();
  const skipsByFile = new Map();
  const actual = { tests: 0, assertions: 0, failures: 0, skipped: 0 };
  for (const suite of directSuites) {
    const file = normalizeRepositoryIdentity(suite.attributes.file);
    if (suiteFiles.has(file)) {
      throw new Error(`JUnit contains duplicate top-level suite for ${file}`);
    }
    suiteFiles.add(file);
    const counts = reconcileSuite(suite, undefined, identities);
    if (counts.tests === 0) {
      throw new Error(
        `JUnit top-level testsuite ${file} contains zero testcases`,
      );
    }
    if (counts.skipped > 0) skipsByFile.set(file, counts.skipped);
    for (const key of Object.keys(actual)) actual[key] += counts[key];
  }
  for (const key of Object.keys(actual)) {
    const declared = integerAttribute(root.attributes, key, "root");
    if (declared !== actual[key]) {
      throw new Error(
        `JUnit root ${key}=${declared} does not match suite ${key}=${actual[key]}`,
      );
    }
  }
  const { tests, assertions, failures, skipped } = actual;
  if (tests === 0) {
    throw new Error("JUnit artifact contains zero tests");
  }
  const expectedFiles = new Set(
    inventoryFiles.map(normalizeRepositoryIdentity),
  );
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
  const skippedFiles = [...skipsByFile.keys()].sort();
  if (skippedFiles.length > 0) {
    const conditionalFiles = classifyConditionalSkipFiles(skippedFiles);
    const unauthorized = skippedFiles.filter(
      (file) => !conditionalFiles.has(file),
    );
    if (unauthorized.length > 0) {
      throw new Error(
        `JUnit artifact contains skipped test(s) in ${unauthorized.join(", ")}; ` +
          "skipped tests are only permitted in files whose skips are statically " +
          "classified as runtime-conditional (see packages/scripts/audit-focused-skipped-tests.mjs)",
      );
    }
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
    skippedFiles,
    suiteFileCount: suiteFiles.size,
  };
}

export function runScriptTests(options = {}) {
  const inventory =
    options.inventory ?? buildScriptTestInventory({ repoRoot: REPO_ROOT });
  const reportPath = options.reportPath;
  const junitPath = options.junitPath;
  const writeReport = options.writeReport ?? atomicWriteJson;
  const readJunit = options.readJunit ?? ((file) => readFileSync(file, "utf8"));
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
  const driverArgs = [
    ISOLATED_TEST_DRIVER,
    `--config=${SCRIPT_TEST_BUN_CONFIG}`,
    // Several real-harness suites create temporary workspace packages under
    // the repository so workspace discovery can exercise them. Separate Bun
    // processes isolate globals, but not that shared filesystem; serial file
    // execution prevents one suite's cleanup from deleting another's fixture.
    "--concurrency=1",
    "--timeout-ms=120000",
  ];
  if (absoluteJunitPath) {
    mkdirSync(path.dirname(absoluteJunitPath), { recursive: true });
    rmSync(absoluteJunitPath, { force: true });
    driverArgs.push(`--junit=${absoluteJunitPath}`);
  }
  driverArgs.push("--", ...inventory.files.map(({ file }) => file));

  if (normalizedReportPath) {
    writeReport(
      normalizedReportPath,
      reportRecord(inventory, {
        status: "running",
        childExitCode: null,
        evidenceExitCode: null,
        command: ["node", ...driverArgs],
        junit:
          normalizedJunitPath === undefined
            ? null
            : { status: "pending", path: normalizedJunitPath },
      }),
    );
  }

  const spawn = options.spawn ?? spawnSync;
  const result = spawn("node", driverArgs, {
    cwd: REPO_ROOT,
    env: process.env,
    stdio: "inherit",
    timeout: 20 * 60_000,
  });
  if (result.error) {
    if (normalizedReportPath) {
      writeReport(
        normalizedReportPath,
        reportRecord(inventory, {
          status: "failed",
          exitCode: 1,
          childExitCode: null,
          evidenceExitCode: null,
          signal: null,
          spawnError: result.error.message,
          command: ["node", ...driverArgs],
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
  const childExitCode =
    typeof result.status === "number" && result.signal === null
      ? result.status
      : 1;
  let evidenceExitCode = absoluteJunitPath ? 0 : null;
  let junit = null;
  if (absoluteJunitPath && normalizedJunitPath) {
    try {
      junit = validateJunitEvidence(
        readJunit(absoluteJunitPath),
        inventory.files.map(({ file }) => file),
        normalizedJunitPath,
      );
      if (junit.failures > 0) evidenceExitCode = 1;
    } catch (error) {
      // error-policy:J3 malformed, unreadable, or policy-violating JUnit
      // evidence becomes an explicit "invalid" record and a failing exit code
      // in the report — never a silently valid lane.
      junit = {
        status: "invalid",
        path: normalizedJunitPath,
        error: error instanceof Error ? error.message : String(error),
      };
      evidenceExitCode = 1;
    }
  }
  const exitCode = childExitCode || evidenceExitCode || 0;
  if (normalizedReportPath) {
    writeReport(
      normalizedReportPath,
      reportRecord(inventory, {
        status: exitCode === 0 ? "passed" : "failed",
        exitCode,
        childExitCode,
        evidenceExitCode,
        signal: result.signal ?? null,
        command: ["node", ...driverArgs],
        junit,
      }),
    );
  }
  return exitCode;
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
