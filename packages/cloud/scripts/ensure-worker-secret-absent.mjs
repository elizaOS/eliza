/**
 * Removes one Cloudflare Worker secret by inspecting the names-only Wrangler
 * inventory before and after deletion. It can target either the deployed
 * configuration or the latest version prepared for a later code deployment;
 * neither mode depends on provider error prose or reads secret values.
 *
 * "Absent" covers every binding form of the name, not just `secret_text`:
 * with `keep_vars = true` a remotely configured `plain_text` var survives
 * deploys even after its spelling leaves wrangler.toml, is invisible to
 * `wrangler secret list`, and collides with a later `secret put` (CF 10053 —
 * activation run 31970252094 failed on exactly this stale-binding state). The
 * CLI therefore also sweeps the deployed script-settings surface and removes a
 * same-name `plain_text` binding via the settings API, round-tripping every
 * other binding exactly as the API returned it so secret values are inherited,
 * never read or rewritten.
 */

import { readFileSync } from "node:fs";
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
  const result = await execFileAsync("bunx", ["wrangler@4.100.0", ...args], {
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

/**
 * Resolve the deployed script name for an optional Wrangler environment from
 * the wrangler.toml in the working directory: an `[env.<env>]` `name` override
 * wins, otherwise Wrangler's `<top-level name>-<env>` convention applies.
 */
export function parseWranglerScriptName(tomlSource, environment) {
  const lines = tomlSource.split("\n");
  let topLevelName = null;
  let envName = null;
  let section = "";
  for (const line of lines) {
    const sectionMatch = line.match(/^\s*\[([^\]]+)\]/);
    if (sectionMatch) {
      section = sectionMatch[1];
      continue;
    }
    const nameMatch = line.match(/^\s*name\s*=\s*"([^"]+)"/);
    if (!nameMatch) continue;
    if (section === "" && topLevelName === null) topLevelName = nameMatch[1];
    if (environment && section === `env.${environment}` && envName === null) {
      envName = nameMatch[1];
    }
  }
  if (envName) return envName;
  if (!topLevelName) throw new Error("wrangler.toml has no top-level name");
  return environment ? `${topLevelName}-${environment}` : topLevelName;
}

const CF_API_BASE = "https://api.cloudflare.com/client/v4";

/**
 * Remove a stale `plain_text` binding of `name` from the DEPLOYED script
 * settings. Reads the current bindings, and when the name is present as
 * `plain_text`, PATCHes back the identical list minus that one entry —
 * `secret_text` bindings round-trip without a value, which the settings API
 * treats as "inherit the existing secret". Fail-closed: an unreadable or
 * unwritable settings surface throws rather than reporting absence.
 */
export async function removeStalePlaintextBinding({
  name,
  scriptName,
  accountId,
  apiToken,
  fetchImpl = fetch,
}) {
  if (!SECRET_NAME_PATTERN.test(name)) {
    throw new Error("Worker secret name is invalid");
  }
  if (!scriptName || !accountId || !apiToken) {
    throw new Error("Cloudflare script, account, and token are required");
  }
  const settingsUrl = `${CF_API_BASE}/accounts/${accountId}/workers/scripts/${scriptName}/settings`;
  const authHeaders = { Authorization: `Bearer ${apiToken}` };

  const readBindings = async () => {
    const response = await fetchImpl(settingsUrl, { headers: authHeaders });
    if (!response.ok) {
      throw new Error(
        `Worker settings read failed with status ${response.status}`,
      );
    }
    const body = await response.json();
    const bindings = body?.result?.bindings;
    if (!Array.isArray(bindings)) {
      throw new Error("Worker settings response had no bindings array");
    }
    return bindings;
  };

  const bindings = await readBindings();
  const stale = bindings.filter(
    (binding) => binding?.name === name && binding?.type === "plain_text",
  );
  if (stale.length === 0) return "already-absent";

  const kept = bindings.filter(
    (binding) => !(binding?.name === name && binding?.type === "plain_text"),
  );
  const form = new FormData();
  form.append(
    "settings",
    new Blob([JSON.stringify({ bindings: kept })], {
      type: "application/json",
    }),
  );
  const patch = await fetchImpl(settingsUrl, {
    method: "PATCH",
    headers: authHeaders,
    body: form,
  });
  if (!patch.ok) {
    throw new Error(
      `Worker settings binding removal failed with status ${patch.status}`,
    );
  }

  const after = await readBindings();
  if (
    after.some(
      (binding) => binding?.name === name && binding?.type === "plain_text",
    )
  ) {
    throw new Error(
      `Worker settings still contain a plain_text binding for ${name}`,
    );
  }
  return "removed";
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

  // The settings sweep targets the deployed script only; versioned mode
  // prepares a future upload and has no deployed surface of its own.
  if (versioned) return;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) {
    // Honest degradation for credential-less local runs: the deployed
    // settings surface is unreachable, so absence there is not claimed.
    process.stdout.write("settings: skipped (no Cloudflare credentials)\n");
    return;
  }
  const environmentArgs = validateWranglerEnvironmentArgs(wranglerArgs);
  const scriptName = parseWranglerScriptName(
    readFileSync("wrangler.toml", "utf8"),
    environmentArgs[1],
  );
  const settingsResult = await removeStalePlaintextBinding({
    name,
    scriptName,
    accountId,
    apiToken,
  });
  process.stdout.write(`settings: ${settingsResult}\n`);
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
