#!/usr/bin/env node
/**
 * Runs every workflow test file in its own Bun process, sequentially. The
 * Smithers integration suites exercise child-process pipes heavily; a single
 * long-lived Bun test process can corrupt its Linux epoll/stdio state and then
 * fail unrelated files. Process isolation releases that state between files,
 * while merged JUnit output lets the repository prove real testcases ran.
 */

import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const pluginRoot = path.resolve(path.dirname(scriptPath), "..");
const defaultTestRoot = path.join(pluginRoot, "__tests__");
const TEST_FILE_PATTERN = /\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/;

export function discoverWorkflowTestFiles(root = defaultTestRoot) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolutePath);
      } else if (entry.isFile() && TEST_FILE_PATTERN.test(entry.name)) {
        files.push(path.relative(pluginRoot, absolutePath));
      }
    }
  };
  visit(root);
  return files.sort();
}

export function parseWorkflowTestArgs(argv) {
  let reporter;
  let reporterOutfile;
  for (const arg of argv) {
    if (arg === "--reporter=junit") {
      reporter = "junit";
    } else if (arg.startsWith("--reporter-outfile=")) {
      reporterOutfile = arg.slice("--reporter-outfile=".length);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if ((reporter === "junit") !== Boolean(reporterOutfile)) {
    throw new Error(
      "JUnit evidence requires both --reporter=junit and --reporter-outfile=<path>",
    );
  }
  return { reporterOutfile };
}

function runOneTestFile(file, bunBinary, fragmentPath, onChild) {
  return new Promise((resolve) => {
    const args = ["test", "--isolate"];
    if (fragmentPath) {
      args.push("--reporter=junit", `--reporter-outfile=${fragmentPath}`);
    }
    args.push(file);
    const child = spawn(bunBinary, args, {
      cwd: pluginRoot,
      env: process.env,
      stdio: "inherit",
    });
    onChild(child);
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      onChild(undefined);
      resolve(result);
    };
    child.once("error", (error) => {
      process.stderr.write(
        `[plugin-workflow:test] could not start ${file}: ${error.message}\n`,
      );
      settle(127);
    });
    child.once("close", (code, signal) => {
      settle(code ?? (signal ? 1 : 0));
    });
  });
}

function readJunitFragment(fragmentPath, file) {
  const xml = readFileSync(fragmentPath, "utf8");
  const root = xml.match(/<testsuites\b([^>]*)>/);
  if (!root) throw new Error(`JUnit fragment has no testsuites root: ${file}`);
  const counts = {};
  for (const name of ["tests", "assertions", "failures", "skipped"]) {
    const raw = root[1].match(new RegExp(`\\b${name}="(\\d+)"`))?.[1];
    if (raw === undefined) {
      throw new Error(`JUnit fragment has no ${name} count: ${file}`);
    }
    counts[name] = Number(raw);
  }
  const bodyStart = root.index + root[0].length;
  const bodyEnd = xml.lastIndexOf("</testsuites>");
  if (bodyEnd < bodyStart) {
    throw new Error(`JUnit fragment has an incomplete root: ${file}`);
  }
  return { body: xml.slice(bodyStart, bodyEnd).trim(), counts };
}

export function mergeWorkflowJunit(fragments, destination) {
  const totals = { tests: 0, assertions: 0, failures: 0, skipped: 0 };
  const bodies = [];
  for (const { file, path: fragmentPath } of fragments) {
    const { body, counts } = readJunitFragment(fragmentPath, file);
    for (const name of Object.keys(totals)) totals[name] += counts[name];
    bodies.push(body);
  }
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(
    destination,
    `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites tests="${totals.tests}" assertions="${totals.assertions}" failures="${totals.failures}" skipped="${totals.skipped}">\n${bodies.join("\n")}\n</testsuites>\n`,
  );
}

export async function runWorkflowTestFiles({
  bunBinary = process.env.BUN_BIN?.trim() || "bun",
  files = discoverWorkflowTestFiles(),
  reporterOutfile,
} = {}) {
  if (files.length === 0) {
    process.stderr.write("[plugin-workflow:test] no test files found\n");
    return 2;
  }

  const fragmentDirectory = reporterOutfile
    ? mkdtempSync(path.join(os.tmpdir(), "eliza-workflow-junit-"))
    : undefined;
  const fragments = files.map((file, index) => ({
    file,
    path: fragmentDirectory
      ? path.join(fragmentDirectory, `${index}.xml`)
      : undefined,
  }));
  let activeChild;
  let interrupted = false;
  const setActiveChild = (child) => {
    activeChild = child;
  };
  const forwardSignal = (signal) => {
    interrupted = true;
    activeChild?.kill(signal);
  };
  const onInterrupt = () => forwardSignal("SIGINT");
  const onTerminate = () => forwardSignal("SIGTERM");
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onTerminate);

  try {
    for (const [index, fragment] of fragments.entries()) {
      process.stdout.write(
        `[plugin-workflow:test] ${index + 1}/${files.length} ${fragment.file}\n`,
      );
      const exitCode = await runOneTestFile(
        fragment.file,
        bunBinary,
        fragment.path,
        setActiveChild,
      );
      if (interrupted) return 1;
      if (exitCode !== 0) {
        process.stderr.write(
          `[plugin-workflow:test] failed (${exitCode}): ${fragment.file}\n`,
        );
        return exitCode;
      }
    }
    if (reporterOutfile) mergeWorkflowJunit(fragments, reporterOutfile);
    process.stdout.write(
      `[plugin-workflow:test] passed ${files.length}/${files.length} isolated test files\n`,
    );
    return 0;
  } finally {
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onTerminate);
    if (fragmentDirectory) {
      rmSync(fragmentDirectory, { recursive: true, force: true });
    }
  }
}

if (import.meta.main || process.argv[1] === scriptPath) {
  try {
    const options = parseWorkflowTestArgs(process.argv.slice(2));
    process.exitCode = await runWorkflowTestFiles(options);
  } catch (error) {
    // error-policy:J1 the executable boundary converts orchestration failures into a non-zero result.
    process.stderr.write(
      `[plugin-workflow:test] ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
