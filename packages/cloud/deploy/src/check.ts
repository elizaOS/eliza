/**
 * Bundles a rendered Wrangler configuration with `wrangler deploy --dry-run`.
 * A dry run compiles the Worker and validates its bindings; it uploads
 * nothing and calls no Cloudflare API.
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
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
  readonly ok: boolean;
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

/** Nearest `node_modules/.bin/wrangler` at or above `from`. */
export function findWrangler(from: string): string | null {
  let dir = resolve(from);
  for (;;) {
    const candidate = join(dir, "node_modules", ".bin", "wrangler");
    if (existsSync(candidate)) return candidate;
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

export function checkRenderedConfig(options: CheckOptions): CheckResult {
  const configFile = resolve(options.configFile);
  const config = parseRenderedConfig(readFileSync(configFile, "utf8"));
  if (typeof config.main !== "string")
    throw new Error(`${configFile} has no main entry`);
  const entry = resolve(dirname(configFile), config.main);
  if (!existsSync(entry))
    throw new Error(`Worker entry does not exist: ${entry}`);

  const wrangler = options.wrangler
    ? resolve(options.wrangler)
    : findWrangler(dirname(entry));
  if (!wrangler || !existsSync(wrangler)) {
    throw new Error(
      `no wrangler found above ${dirname(entry)}; install the upstream tree or pass --wrangler`,
    );
  }

  const outDir = options.keepDir
    ? resolve(options.keepDir)
    : mkdtempSync(join(tmpdir(), "cloud-deploy-check-"));

  // No credential reaches the dry run, so it cannot act on an account.
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

  const run = spawnSync(
    wrangler,
    ["deploy", "--config", configFile, "--dry-run", "--outdir", outDir],
    {
      cwd: dirname(configFile),
      env,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  const output = `${run.stdout ?? ""}${run.stderr ?? ""}${run.error ? `\n${run.error.message}` : ""}`;
  const ok = run.status === 0;

  const files = existsSync(outDir)
    ? listFiles(outDir).filter((file) => !/\.map$|^README\.md$/.test(file.name))
    : [];
  const result: CheckResult = {
    ok,
    exitCode: run.status,
    wrangler,
    entry,
    outDir: options.keepDir ? outDir : null,
    files,
    bundleBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    totalUpload: output.match(/Total Upload:[^\n]*/)?.[0].trim() ?? null,
    output,
  };
  if (!options.keepDir) rmSync(outDir, { recursive: true, force: true });
  return result;
}
