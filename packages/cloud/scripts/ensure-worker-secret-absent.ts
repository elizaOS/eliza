/**
 * Removes one Cloudflare Worker secret by inspecting the names-only Wrangler
 * inventory before and after deletion. It can target either the deployed
 * configuration or the latest version prepared for a later code deployment;
 * neither mode depends on provider error prose or reads secret values.
 */

import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SECRET_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const INVENTORY_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENVIRONMENT_PATTERN = /^[a-z][a-z0-9-]*$/;

/** Parse Wrangler's names-only JSON response into a set of binding names. */
export function parseWorkerSecretNames(output) {
  const parsed = JSON.parse(output);
  if (!Array.isArray(parsed)) {
    throw new Error("Wrangler secret inventory was not an array");
  }

  const names = new Set();
  for (const entry of parsed) {
    if (
      entry === null ||
      typeof entry !== "object" ||
      typeof entry.name !== "string" ||
      !INVENTORY_NAME_PATTERN.test(entry.name)
    ) {
      throw new Error("Wrangler secret inventory contained an invalid name");
    }
    names.add(entry.name);
  }
  return names;
}

function parseLatestWorkerVersion(output) {
  const parsed = JSON.parse(output);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("Wrangler version inventory was empty or invalid");
  }
  const versions = parsed.map((entry) => {
    if (
      entry === null ||
      typeof entry !== "object" ||
      typeof entry.id !== "string" ||
      entry.id.length === 0 ||
      !Number.isInteger(entry.number)
    ) {
      throw new Error("Wrangler version inventory contained an invalid entry");
    }
    return entry;
  });
  return versions.reduce((latest, entry) =>
    entry.number > latest.number ? entry : latest,
  );
}

function parseWorkerVersionSecretNames(output) {
  const parsed = JSON.parse(output);
  const bindings = parsed?.resources?.bindings;
  if (!Array.isArray(bindings)) {
    throw new Error("Wrangler version bindings were missing or invalid");
  }
  return parseWorkerSecretNames(
    JSON.stringify(
      bindings.filter((binding) => binding?.type === "secret_text"),
    ),
  );
}

/** Restrict passthrough arguments to Wrangler's optional environment selector. */
export function validateWranglerEnvironmentArgs(args) {
  if (args.length === 0) return [];
  if (
    args.length !== 2 ||
    args[0] !== "--env" ||
    !ENVIRONMENT_PATTERN.test(args[1])
  ) {
    throw new Error("Expected no Wrangler arguments or one --env selector");
  }
  return [...args];
}

async function runWrangler(args) {
  const result = await execFileAsync("bunx", ["wrangler@4.116.0", ...args], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  return result.stdout;
}

/**
 * Confirm that `name` is absent, returning whether this invocation may have
 * removed it. Any ambiguous deletion is treated as removal for rollback
 * ownership if a later names-only inventory proves the binding absent.
 */
export async function ensureWorkerSecretAbsent({
  name,
  wranglerArgs = [],
  versioned = false,
  attempts = 3,
  retryDelayMs = 10_000,
  run = runWrangler,
  sleep = (delay) => new Promise((resolve) => setTimeout(resolve, delay)),
}) {
  if (!SECRET_NAME_PATTERN.test(name)) {
    throw new Error("Worker secret name is invalid");
  }
  const validatedArgs = validateWranglerEnvironmentArgs(wranglerArgs);
  if (typeof versioned !== "boolean") {
    throw new Error("Versioned secret mode must be boolean");
  }
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error("Attempts must be a positive integer");
  }

  let deletionAttempted = false;
  const readSecretNames = async () => {
    if (!versioned) {
      return parseWorkerSecretNames(
        await run(["secret", "list", ...validatedArgs, "--format", "json"]),
      );
    }
    const latest = parseLatestWorkerVersion(
      await run(["versions", "list", ...validatedArgs, "--json"]),
    );
    return parseWorkerVersionSecretNames(
      await run(["versions", "view", latest.id, ...validatedArgs, "--json"]),
    );
  };
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const before = await readSecretNames();
      if (!before.has(name)) {
        return deletionAttempted ? "removed" : "already-absent";
      }

      deletionAttempted = true;
      await run([
        ...(versioned ? ["versions"] : []),
        "secret",
        "delete",
        name,
        ...validatedArgs,
      ]);

      const after = await readSecretNames();
      if (!after.has(name)) return "removed";
    } catch {
      // error-policy:J1 The CLI boundary retries without exposing provider output.
    }

    if (attempt < attempts) await sleep(retryDelayMs);
  }

  throw new Error(`Could not confirm Worker secret ${name} is absent`);
}

async function main() {
  const args = process.argv.slice(2);
  const versioned = args[0] === "--versions";
  if (versioned) args.shift();
  const [name, ...wranglerArgs] = args;
  if (!name) throw new Error("Worker secret name is required");
  const result = await ensureWorkerSecretAbsent({
    name,
    wranglerArgs,
    versioned,
  });
  process.stdout.write(`${result}\n`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    // error-policy:J1 The executable boundary reports only the typed operation failure.
    process.stderr.write(
      `${error instanceof Error ? error.message : "Worker secret removal failed"}\n`,
    );
    process.exitCode = 1;
  });
}
