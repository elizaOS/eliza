#!/usr/bin/env node

/**
 * Validates a names-only Wrangler secret inventory before or after a protected
 * Worker deploy without accepting provider values, diagnostics, or ambiguity.
 */

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const BINDING_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

/** Parses a Wrangler secret-list response into valid binding names only. */
export function parseWorkerSecretBindingNames(output) {
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    fail("inventory_invalid", "Worker secret inventory is not valid JSON");
  }
  const entries = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.result)
      ? parsed.result
      : undefined;
  if (!entries)
    fail("inventory_invalid", "Worker secret inventory is not an array");

  const names = new Set();
  for (const entry of entries) {
    if (
      entry === null ||
      typeof entry !== "object" ||
      typeof entry.name !== "string" ||
      !BINDING_NAME.test(entry.name)
    ) {
      fail(
        "inventory_invalid",
        "Worker secret inventory contains an invalid name",
      );
    }
    names.add(entry.name);
  }
  return names;
}

/** Fails closed unless every required name appears in an existing or queued inventory. */
export function verifyWorkerSecretBindingNames({
  inventory,
  requiredNames,
  queuedNames = [],
}) {
  if (!Array.isArray(requiredNames) || !Array.isArray(queuedNames)) {
    fail(
      "request_invalid",
      "Worker secret binding verification requires name arrays",
    );
  }
  const available = parseWorkerSecretBindingNames(inventory);
  for (const name of [...requiredNames, ...queuedNames]) {
    if (typeof name !== "string" || !BINDING_NAME.test(name)) {
      fail(
        "request_invalid",
        "Worker secret binding verification received an invalid name",
      );
    }
  }
  for (const name of queuedNames) available.add(name);

  const missing = requiredNames.filter((name) => !available.has(name));
  if (missing.length > 0) {
    fail(
      "binding_absent",
      `Required Worker secret binding name(s) are absent: ${missing.join(" ")}`,
    );
  }
}

function main() {
  const args = process.argv.slice(2);
  const requiredNames = [];
  const queuedNames = [];
  let destination = requiredNames;
  for (const arg of args) {
    if (arg === "--required") {
      destination = requiredNames;
      continue;
    }
    if (arg === "--queued") {
      destination = queuedNames;
      continue;
    }
    destination.push(arg);
  }
  if (requiredNames.length === 0) {
    fail(
      "request_invalid",
      "Worker secret binding verification requires required names",
    );
  }
  verifyWorkerSecretBindingNames({
    inventory: readFileSync(0, "utf8"),
    requiredNames,
    queuedNames,
  });
  process.stdout.write(
    `Verified ${requiredNames.length} required Worker secret binding names; values were not read.\n`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    main();
  } catch (error) {
    // error-policy:J1 The CLI boundary reports only safe binding names and no provider payload.
    const message =
      error instanceof Error
        ? error.message
        : "Worker secret binding verification failed";
    process.stderr.write(`::error::${message}\n`);
    process.exitCode = 1;
  }
}
