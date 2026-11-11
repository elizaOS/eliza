/**
 * Checks a rendered configuration offline.
 *
 * A Worker is bundled with `wrangler deploy --dry-run`, which compiles it and
 * validates its bindings. A Pages configuration is checked with
 * `wrangler pages functions build`, which reads the configuration as a Pages
 * project and compiles the Pages Functions. Neither uploads anything or
 * calls a Cloudflare API.
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseRenderedConfig } from "./render";

export interface CheckOptions {
  readonly configFile: string;
  /** Wrangler executable; found beside the Worker entry when omitted. */
  readonly wrangler?: string;
  /** Keep the bundle in this directory instead of a deleted temporary one. */
  readonly keepDir?: string;
}

export interface CheckResult {
  /** `worker` for a Worker dry run, `pages` for a Pages Functions build. */
  readonly kind: "worker" | "pages";
  readonly ok: boolean;
  /** What a passing check of this configuration does not establish. */
  readonly notValidated: readonly string[];
  readonly exitCode: number | null;
  readonly wrangler: string;
  readonly entry: string;
  readonly outDir: string | null;
  /** Bundle files (source maps and notices excluded) with sizes in bytes. */
  readonly files: readonly { readonly name: string; readonly bytes: number }[];
  readonly bundleBytes: number;
  /** Wrangler's own "Total Upload" line, when it printed one. */
  readonly totalUpload: string | null;
  readonly output: string;
}

/** Where the upstream tree installs Wrangler when a component has none of its own. */
const UPSTREAM_WRANGLER = join(
  "packages",
  "cloud",
  "api",
  "node_modules",
  ".bin",
  "wrangler",
);

/**
 * Nearest `node_modules/.bin/wrangler` at or above `from`; failing that, the
 * API Worker's Wrangler of the upstream tree `from` is in.
 */
export function findWrangler(from: string): string | null {
  let dir = resolve(from);
  for (;;) {
    for (const candidate of [
      join(dir, "node_modules", ".bin", "wrangler"),
      join(dir, UPSTREAM_WRANGLER),
    ]) {
      if (existsSync(candidate)) return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function listFiles(
  dir: string,
  prefix = "",
): { name: string; bytes: number }[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    const path = join(dir, entry.name);
    return entry.isDirectory()
      ? listFiles(path, name)
      : [{ name, bytes: statSync(path).size }];
  });
}

/** No credential reaches a check, so it cannot act on an account. */
function offlineEnvironment(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    WRANGLER_SEND_METRICS: "false",
    CI: "1",
    NO_COLOR: "1",
  };
  for (const name of [
    "CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_API_KEY",
    "CLOUDFLARE_EMAIL",
    "CLOUDFLARE_ACCOUNT_ID",
    "CF_API_TOKEN",
    "CF_ACCOUNT_ID",
  ]) {
    delete env[name];
  }
  return env;
}

function resolveWrangler(options: CheckOptions, from: string): string {
  const wrangler = options.wrangler
    ? resolve(options.wrangler)
    : findWrangler(from);
  if (!wrangler || !existsSync(wrangler)) {
    throw new Error(
      `no wrangler found above ${from}; install the upstream tree or pass --wrangler`,
    );
  }
  return wrangler;
}

function finish(
  options: CheckOptions,
  outDir: string,
  run: ReturnType<typeof spawnSync>,
  result: Pick<CheckResult, "kind" | "wrangler" | "entry" | "notValidated">,
): CheckResult {
  const output = `${run.stdout ?? ""}${run.stderr ?? ""}${run.error ? `\n${run.error.message}` : ""}`;
  const files = existsSync(outDir)
    ? listFiles(outDir).filter((file) => !/\.map$|^README\.md$/.test(file.name))
    : [];
  const checked: CheckResult = {
    ...result,
    ok: run.status === 0 && files.length > 0,
    exitCode: run.status,
    outDir: options.keepDir ? outDir : null,
    files,
    bundleBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    totalUpload: output.match(/Total Upload:[^\n]*/)?.[0].trim() ?? null,
    output,
  };
  if (!options.keepDir) rmSync(outDir, { recursive: true, force: true });
  return checked;
}

/**
 * Pages has no dry-run deploy. This compiles upstream's Pages Functions
 * against the rendered configuration, in a scratch project directory because
 * Wrangler only reads a Pages configuration named `wrangler.json`.
 */
function checkPagesConfig(
  options: CheckOptions,
  configFile: string,
  config: Record<string, unknown>,
): CheckResult {
  const buildOutput = resolve(
    dirname(configFile),
    String(config.pages_build_output_dir),
  );
  const functions = join(dirname(buildOutput), "functions");
  if (!existsSync(functions))
    throw new Error(`Pages Functions directory does not exist: ${functions}`);
  const wrangler = resolveWrangler(options, functions);

  const project = mkdtempSync(join(tmpdir(), "cloud-deploy-pages-"));
  const outDir = options.keepDir
    ? resolve(options.keepDir)
    : join(project, "out");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(project, "wrangler.json"),
    `${JSON.stringify({ ...config, pages_build_output_dir: buildOutput }, null, 2)}\n`,
  );
  const metadata = join(project, "build-metadata.json");
  const run = spawnSync(
    wrangler,
    [
      "pages",
      "functions",
      "build",
      functions,
      "--project-directory",
      project,
      "--outdir",
      outDir,
      "--build-metadata-path",
      metadata,
    ],
    {
      cwd: project,
      env: offlineEnvironment(),
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  // Wrangler writes the metadata only after it accepted the configuration
  // as a Pages project; without it the functions were built unconfigured.
  const configRead = existsSync(metadata);
  const result = finish(options, outDir, run, {
    kind: "pages",
    wrangler,
    entry: functions,
    notValidated: [
      "the web app build (the Vite output directory is neither built nor required to exist)",
      "service bindings and variables against a Cloudflare account",
      "a Pages deploy",
    ],
  });
  rmSync(project, { recursive: true, force: true });
  return configRead
    ? result
    : {
        ...result,
        ok: false,
        output: `${result.output}\nwrangler did not read the rendered configuration as a Pages project`,
      };
}

export function checkRenderedConfig(options: CheckOptions): CheckResult {
  const configFile = resolve(options.configFile);
  const config = parseRenderedConfig(readFileSync(configFile, "utf8"));
  if (typeof config.pages_build_output_dir === "string")
    return checkPagesConfig(options, configFile, config);
  if (typeof config.main !== "string")
    throw new Error(`${configFile} has no main entry`);
  const entry = resolve(dirname(configFile), config.main);
  if (!existsSync(entry))
    throw new Error(`Worker entry does not exist: ${entry}`);
  const wrangler = resolveWrangler(options, dirname(entry));

  const outDir = options.keepDir
    ? resolve(options.keepDir)
    : mkdtempSync(join(tmpdir(), "cloud-deploy-check-"));

  // A dry run otherwise builds the container image, which needs a Docker
  // daemon and base images. The Worker and its bindings are checked without.
  const hasContainers =
    Array.isArray(config.containers) && config.containers.length > 0;
  const run = spawnSync(
    wrangler,
    [
      "deploy",
      "--config",
      configFile,
      "--dry-run",
      "--outdir",
      outDir,
      ...(hasContainers ? ["--containers-rollout=none"] : []),
    ],
    {
      cwd: dirname(configFile),
      env: offlineEnvironment(),
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  return finish(options, outDir, run, {
    kind: "worker",
    wrangler,
    entry,
    notValidated: [
      ...(hasContainers
        ? ["the container image (not built; --containers-rollout=none)"]
        : []),
      "bindings, routes and resource ids against a Cloudflare account",
      "a deploy",
    ],
  });
}
