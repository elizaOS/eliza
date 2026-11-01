#!/usr/bin/env bun
/** Supply the native fallback binding without changing the canonical Pages bindings. */
import { spawnSync } from "node:child_process";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { ELIZA_DOMAIN_CONTRACTS } from "@elizaos/plugin-elizacloud/cloud-config/domain-contract";
import {
  type NativeAuthCallback,
  nativeSignInCallbackFallback,
  selectNativeAuthCallback,
} from "../../app/functions/_middleware.ts";

const BINDING = "ELIZA_NATIVE_AUTH_CALLBACKS_JSON";
type Environment = "staging" | "production";
type Config = Record<string, unknown>;

const object = (value: unknown): Config => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("pages_config_invalid");
  }
  return value as Config;
};

function selectedConfig(config: Config, environment: Environment): Config {
  const environments = config.env === undefined ? {} : object(config.env);
  const selected =
    environments[environment === "production" ? "production" : "preview"];
  return selected === undefined ? config : object(selected);
}

export function callbacks(
  raw: unknown,
  environment: Environment,
): NativeAuthCallback[] {
  if (raw === undefined || raw === "") return [];
  // The serving boundary validates the entire list even when no entry matches.
  selectNativeAuthCallback(
    raw,
    new URL(ELIZA_DOMAIN_CONTRACTS[environment].cloudAppOrigin),
  );
  const entries = JSON.parse(raw as string) as NativeAuthCallback[];
  const contract = ELIZA_DOMAIN_CONTRACTS[environment];
  const origins = new Set([contract.cloudAppOrigin, contract.marketingOrigin]);
  if (
    entries.some((entry) => !origins.has(new URL(entry.redirectUri).origin))
  ) {
    throw new Error("native_callback_environment_mismatch");
  }
  return entries;
}

export function prepareConfig(
  canonical: Config,
  canonicalDirectory: string,
  environment: Environment,
  configured: string | undefined,
  existing: Config,
): { config: Config; count: number; source: "configured" | "preserved" } {
  const config = structuredClone(canonical);
  if (
    typeof config.name !== "string" ||
    typeof config.pages_build_output_dir !== "string"
  ) {
    throw new Error("pages_config_invalid");
  }
  config.pages_build_output_dir = path.resolve(
    canonicalDirectory,
    config.pages_build_output_dir,
  );
  const selected = selectedConfig(config, environment);
  const vars = selected.vars === undefined ? {} : object(selected.vars);
  const old = selectedConfig(existing, environment);
  const oldVars = old.vars === undefined ? {} : object(old.vars);
  const source = configured?.trim() ? "configured" : "preserved";
  const raw =
    source === "configured" ? configured : (oldVars[BINDING] ?? vars[BINDING]);
  const entries = callbacks(raw, environment);
  if (raw !== undefined) vars[BINDING] = raw;
  selected.vars = vars;
  return { config, count: entries.length, source };
}

async function existingConfig(
  project: string,
  directory: string,
): Promise<Config> {
  const temporary = await mkdtemp(path.join(directory, "read-pages-"));
  try {
    // Read-only. Capture provider output privately; it can contain unrelated bindings.
    const result = spawnSync(
      "bunx",
      [
        "wrangler@4.100.0",
        "pages",
        "download",
        "config",
        project,
        "--cwd",
        temporary,
      ],
      {
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
        timeout: 60_000,
      },
    );
    if (result.status !== 0 || result.error)
      throw new Error("pages_existing_config_unavailable");
    return object(
      Bun.TOML.parse(
        await readFile(path.join(temporary, "wrangler.toml"), "utf8"),
      ),
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function verifyCallbacks(
  config: Config,
  environment: Environment,
  request: (url: URL, init?: RequestInit) => Promise<Response> = fetch,
): Promise<number> {
  const vars = object(selectedConfig(config, environment).vars ?? {});
  const entries = callbacks(vars[BINDING], environment);
  for (const callback of entries) {
    const url = new URL(callback.redirectUri);
    url.searchParams.set("code", "native-callback-deployment-probe");
    url.searchParams.set("state", "a".repeat(43));
    const expected = nativeSignInCallbackFallback(url, callback);
    const response = await request(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
    });
    if (response.status !== 200)
      throw new Error("native_callback_status_mismatch");
    for (const [key, value] of expected.headers) {
      if (response.headers.get(key) !== value)
        throw new Error("native_callback_headers_mismatch");
    }
    if ((await response.text()) !== (await expected.text()))
      throw new Error("native_callback_body_mismatch");
  }
  return entries.length;
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (
      !key?.startsWith("--") ||
      !value ||
      value.startsWith("--") ||
      flags.has(key)
    ) {
      throw new Error("pages_callback_arguments_invalid");
    }
    flags.set(key, value);
  }
  const environment = flags.get("--environment");
  if (environment !== "production" && environment !== "staging")
    throw new Error("pages_callback_environment_invalid");
  if (command === "prepare") {
    const canonicalPath = flags.get("--canonical");
    const outputRoot = flags.get("--output-root");
    if (!canonicalPath || !outputRoot || flags.size !== 3)
      throw new Error("pages_callback_arguments_invalid");
    const canonical = object(
      Bun.TOML.parse(await readFile(canonicalPath, "utf8")),
    );
    if (typeof canonical.name !== "string")
      throw new Error("pages_config_invalid");
    await mkdir(outputRoot, { recursive: true, mode: 0o700 });
    const configured = process.env[BINDING];
    const existing = configured?.trim()
      ? {}
      : await existingConfig(canonical.name, outputRoot);
    const prepared = prepareConfig(
      canonical,
      path.dirname(path.resolve(canonicalPath)),
      environment,
      configured,
      existing,
    );
    const directory = await mkdtemp(path.join(outputRoot, "native-callbacks-"));
    await writeFile(
      path.join(directory, "wrangler.json"),
      `${JSON.stringify(prepared.config, null, 2)}\n`,
      { mode: 0o600 },
    );
    if (process.env.GITHUB_OUTPUT)
      await appendFile(process.env.GITHUB_OUTPUT, `directory=${directory}\n`);
    console.log(
      JSON.stringify({
        nativeCallbacks: prepared.count,
        source: prepared.source,
        prepared: true,
      }),
    );
  } else if (command === "verify") {
    const configPath = flags.get("--config");
    if (!configPath || flags.size !== 2)
      throw new Error("pages_callback_arguments_invalid");
    const count = await verifyCallbacks(
      object(JSON.parse(await readFile(configPath, "utf8"))),
      environment,
    );
    console.log(JSON.stringify({ nativeCallbacks: count, verified: true }));
  } else {
    throw new Error("pages_callback_arguments_invalid");
  }
}

if (import.meta.main) {
  main().catch(() => {
    // Provider, configuration and response data must not enter release logs.
    console.error("Native callback configuration or verification failed");
    process.exitCode = 1;
  });
}
