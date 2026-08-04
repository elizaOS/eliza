#!/usr/bin/env node
/**
 * Runs script tests in isolated Bun processes with bounded concurrency and time.
 * Process isolation prevents one suite's global state or child processes from
 * wedging the complete CI lane; optional JUnit fragments are merged for the
 * inventory runner's existing evidence validation.
 */

import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runPool } from "./lib/test-task-pool.mjs";

function positiveInteger(value, flag) {
  if (!/^[1-9]\d*$/.test(value))
    throw new Error(`${flag} requires a positive integer`);
  return Number(value);
}

export function parseIsolatedScriptTestArgs(argv) {
  const separator = argv.indexOf("--");
  if (separator < 0) throw new Error("missing -- before test files");
  const options = {
    concurrency: 4,
    config: "packages/scripts/bunfig.script-tests.toml",
    junit: undefined,
    timeoutMs: 120_000,
  };
  for (const arg of argv.slice(0, separator)) {
    if (arg.startsWith("--concurrency=")) {
      options.concurrency = positiveInteger(arg.slice(14), "--concurrency");
    } else if (arg.startsWith("--config=")) {
      options.config = arg.slice(9);
    } else if (arg.startsWith("--junit=")) {
      options.junit = arg.slice(8);
    } else if (arg.startsWith("--timeout-ms=")) {
      options.timeoutMs = positiveInteger(arg.slice(13), "--timeout-ms");
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  const files = argv.slice(separator + 1);
  if (files.length === 0) throw new Error("no test files supplied");
  return { ...options, files };
}

function terminate(child) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    child.kill("SIGTERM");
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    // error-policy:J6 Process-group teardown can race with child exit; target the child as a best effort.
    child.kill("SIGTERM");
  }
}

function runOne(file, options, fragmentPath, active) {
  return new Promise((resolve) => {
    const args = [
      `--config=${options.config}`,
      "test",
      "--conditions=eliza-source",
    ];
    if (fragmentPath) {
      args.push("--reporter=junit", `--reporter-outfile=${fragmentPath}`);
    }
    args.push(file);
    const child = spawn("bun", args, {
      cwd: process.cwd(),
      detached: process.platform !== "win32",
      env: process.env,
      stdio: "inherit",
    });
    active.add(child);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      process.stderr.write(
        `[script-tests] timed out after ${options.timeoutMs}ms: ${file}\n`,
      );
      terminate(child);
    }, options.timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      active.delete(child);
      resolve({ error, exitCode: 1, file, timedOut });
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      active.delete(child);
      resolve({ exitCode: code ?? 1, file, signal, timedOut });
    });
  });
}

function rootCounts(xml, file) {
  const match = xml.match(/<testsuites\b([^>]*)>/);
  if (!match) throw new Error(`JUnit fragment has no testsuites root: ${file}`);
  const counts = {};
  for (const key of ["tests", "assertions", "failures", "skipped"]) {
    const value = match[1].match(new RegExp(`\\b${key}="(\\d+)"`))?.[1];
    if (value === undefined)
      throw new Error(`JUnit fragment has no ${key} count: ${file}`);
    counts[key] = Number(value);
  }
  const start = match.index + match[0].length;
  const end = xml.lastIndexOf("</testsuites>");
  if (end < start)
    throw new Error(`JUnit fragment has an incomplete root: ${file}`);
  return { body: xml.slice(start, end).trim(), counts };
}

function mergeJunit(fragments, destination) {
  const totals = { tests: 0, assertions: 0, failures: 0, skipped: 0 };
  const bodies = [];
  for (const { file, path: fragmentPath } of fragments) {
    const { body, counts } = rootCounts(
      readFileSync(fragmentPath, "utf8"),
      file,
    );
    for (const key of Object.keys(totals)) totals[key] += counts[key];
    bodies.push(body);
  }
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(
    destination,
    `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites tests="${totals.tests}" assertions="${totals.assertions}" failures="${totals.failures}" skipped="${totals.skipped}">\n${bodies.join("\n")}\n</testsuites>\n`,
  );
}

export async function runIsolatedScriptTests(options) {
  const temporary = options.junit
    ? mkdtempSync(path.join(os.tmpdir(), "eliza-script-tests-"))
    : undefined;
  const active = new Set();
  const stop = () => {
    for (const child of active) terminate(child);
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    const fragments = options.files.map((file, index) => ({
      file,
      path: temporary ? path.join(temporary, `${index}.xml`) : undefined,
    }));
    const results = await runPool(
      fragments,
      ({ file, path: fragmentPath }) =>
        runOne(file, options, fragmentPath, active),
      options.concurrency,
    );
    const failures = results.filter(
      (result) =>
        !result.ok || result.value.exitCode !== 0 || result.value.timedOut,
    );
    if (failures.length === 0 && options.junit)
      mergeJunit(fragments, options.junit);
    return failures.length === 0 ? 0 : 1;
  } finally {
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
    if (temporary) rmSync(temporary, { recursive: true, force: true });
  }
}

async function main() {
  const options = parseIsolatedScriptTestArgs(process.argv.slice(2));
  process.exitCode = await runIsolatedScriptTests(options);
}

if (import.meta.main || process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    // error-policy:J1 the executable boundary converts orchestration failures
    // into an observable non-zero result.
    process.stderr.write(
      `[script-tests] ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
