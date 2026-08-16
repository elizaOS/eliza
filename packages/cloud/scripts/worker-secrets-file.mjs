/**
 * Materializes configured Worker secrets in a runner-private JSON file for an
 * atomic Wrangler code-and-secrets deployment, then removes only files it owns.
 */

import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  lstatSync,
  openSync,
  readdirSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

const SECRET_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const OWNED_FILE_PATTERN =
  /^eliza-worker-secrets-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/;

/** Build the exact nonblank string-valued secret payload named by the caller. */
export function buildWorkerSecrets(names, environment = process.env) {
  if (!Array.isArray(names)) {
    throw new Error("Worker secret names must be an array");
  }

  const secrets = Object.create(null);
  const seen = new Set();
  for (const name of names) {
    if (typeof name !== "string" || !SECRET_NAME_PATTERN.test(name)) {
      throw new Error("Worker secret name is invalid");
    }
    if (seen.has(name)) {
      throw new Error(`Worker secret name is duplicated: ${name}`);
    }
    seen.add(name);

    const value = environment[name];
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(`Worker secret ${name} is missing or blank`);
    }
    secrets[name] = value;
  }
  return secrets;
}

function resolveRunnerTemp(runnerTemp) {
  if (typeof runnerTemp !== "string" || !isAbsolute(runnerTemp)) {
    throw new Error("Runner temp directory must be an absolute path");
  }
  const resolved = realpathSync(runnerTemp);
  if (!lstatSync(resolved).isDirectory()) {
    throw new Error("Runner temp path is not a directory");
  }
  return resolved;
}

/** Write one mode-0600 JSON file beneath the exact runner temp directory. */
export function createWorkerSecretsFile({
  runnerTemp,
  names,
  environment = process.env,
}) {
  const resolvedRunnerTemp = resolveRunnerTemp(runnerTemp);
  const secrets = buildWorkerSecrets(names, environment);
  const outputPath = join(
    resolvedRunnerTemp,
    `eliza-worker-secrets-${randomUUID()}.json`,
  );

  let descriptor;
  try {
    descriptor = openSync(outputPath, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(secrets)}\n`, {
      encoding: "utf8",
    });
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(outputPath, 0o600);
    return outputPath;
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(outputPath);
    } catch {
      // error-policy:J6 Cleanup is best effort after file creation failed.
    }
    throw error;
  }
}

/** Remove only a regular, non-symlink file created by this module. */
export function removeWorkerSecretsFile({ runnerTemp, filePath }) {
  const resolvedRunnerTemp = resolveRunnerTemp(runnerTemp);
  if (
    typeof filePath !== "string" ||
    !isAbsolute(filePath) ||
    realpathSync(dirname(filePath)) !== resolvedRunnerTemp ||
    !OWNED_FILE_PATTERN.test(basename(filePath))
  ) {
    throw new Error("Worker secrets file is outside the owned runner path");
  }

  let stat;
  try {
    stat = lstatSync(filePath);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("Worker secrets path is not an owned regular file");
  }
  unlinkSync(filePath);
}

/** Remove every owned Worker-secrets file directly beneath runner temp. */
export function removeWorkerSecretsFiles({ runnerTemp }) {
  const resolvedRunnerTemp = resolveRunnerTemp(runnerTemp);
  for (const entry of readdirSync(resolvedRunnerTemp)) {
    if (!OWNED_FILE_PATTERN.test(entry)) continue;
    removeWorkerSecretsFile({
      runnerTemp: resolvedRunnerTemp,
      filePath: join(resolvedRunnerTemp, entry),
    });
  }
}

function usage() {
  throw new Error(
    "Usage: worker-secrets-file.mjs create <runner-temp> <NAME...> | remove <runner-temp> <file> | remove-all <runner-temp>",
  );
}

function main() {
  const [operation, runnerTemp, ...args] = process.argv.slice(2);
  if (operation === "create" && runnerTemp && args.length > 0) {
    process.stdout.write(
      `${createWorkerSecretsFile({ runnerTemp, names: args })}\n`,
    );
    return;
  }
  if (operation === "remove" && runnerTemp && args.length === 1) {
    removeWorkerSecretsFile({ runnerTemp, filePath: args[0] });
    return;
  }
  if (operation === "remove-all" && runnerTemp && args.length === 0) {
    removeWorkerSecretsFiles({ runnerTemp });
    return;
  }
  usage();
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    main();
  } catch (error) {
    // error-policy:J1 The CLI boundary reports only the typed operation failure.
    process.stderr.write(
      `${error instanceof Error ? error.message : "Worker secrets file operation failed"}\n`,
    );
    process.exitCode = 1;
  }
}
