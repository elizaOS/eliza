/**
 * Builds a deployment-owned provider-service entry as one immutable ESM
 * artifact. The output is checked with the same non-evaluating, closed-import
 * inspection used by the production service loader before it is published.
 */

import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { inspectPinnedSelfContainedModuleBytes } from "../src/provider-qualified/operator-file-security.ts";
import {
  PROVIDER_SERVICE_DEPLOYMENT_FACTORY_EXPORT,
  type ProviderServiceDeploymentModule,
} from "../src/provider-qualified/provider-service-entrypoint.ts";

const HELP = `Usage:
  bun scripts/build-provider-service-deployment-bundle.ts \\
    --entry <deployment-owned-entry.ts> --out <provider-service-adapter.mjs>

Builds one self-contained, content-pinned provider-service deployment module.
Existing outputs are never overwritten. The entry must export
createProviderCanaryServiceDeployment and must not embed private keys or use
runtime module loaders.
`;

function fail(message: string): never {
  throw new Error(`provider service bundle build refused: ${message}`);
}

export interface ProviderServiceBundleBuildInput {
  entryFile: string;
  outputFile: string;
}

export interface ProviderServiceBundleBuildResult {
  outputFile: string;
  sha256: string;
  bytes: number;
}

function regularOwnedInput(file: string): string {
  const absolute = path.resolve(file);
  if (realpathSync(absolute) !== absolute) {
    fail("entry path must contain no symlink component");
  }
  const metadata = lstatSync(absolute);
  const uid = process.getuid?.();
  if (
    !metadata.isFile() ||
    metadata.nlink !== 1 ||
    (uid !== undefined && metadata.uid !== uid)
  ) {
    fail("entry must be a single-linked file owned by the current user");
  }
  return absolute;
}

function absentOutput(file: string): string {
  const absolute = path.resolve(file);
  if (existsSync(absolute)) fail("output already exists");
  const parent = path.dirname(absolute);
  if (realpathSync(parent) !== parent) {
    fail("output directory must contain no symlink component");
  }
  const metadata = lstatSync(parent);
  const uid = process.getuid?.();
  if (!metadata.isDirectory() || (uid !== undefined && metadata.uid !== uid)) {
    fail("output directory must be owned by the current user");
  }
  return absolute;
}

/** Build and inspect exactly the bytes accepted by the deployment loader. */
export async function buildProviderServiceDeploymentBundle(
  input: ProviderServiceBundleBuildInput,
): Promise<ProviderServiceBundleBuildResult> {
  const entryFile = regularOwnedInput(input.entryFile);
  const outputFile = absentOutput(input.outputFile);
  if (entryFile === outputFile) fail("entry and output paths must differ");
  const temporaryDirectory = mkdtempSync(
    path.join(tmpdir(), "eliza-provider-service-bundle-"),
  );
  try {
    const result = await Bun.build({
      entrypoints: [entryFile],
      outdir: temporaryDirectory,
      naming: "provider-service-adapter.mjs",
      target: "node",
      format: "esm",
      bundle: true,
      splitting: false,
      minify: false,
      sourcemap: "none",
    });
    if (!result.success) {
      const messages = result.logs.map((log) => log.message).join("; ");
      fail(`Bun build failed${messages ? `: ${messages}` : ""}`);
    }
    const built = path.join(temporaryDirectory, "provider-service-adapter.mjs");
    const bytes = readFileSync(built);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    inspectPinnedSelfContainedModuleBytes(
      bytes,
      sha256,
      PROVIDER_SERVICE_DEPLOYMENT_FACTORY_EXPORT satisfies keyof ProviderServiceDeploymentModule,
    );
    writeFileSync(outputFile, bytes, { flag: "wx", mode: 0o600 });
    chmodSync(outputFile, 0o600);
    return Object.freeze({
      outputFile,
      sha256,
      bytes: bytes.byteLength,
    });
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function parseArgs(argv: readonly string[]): ProviderServiceBundleBuildInput {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  let entryFile: string | undefined;
  let outputFile: string | undefined;
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value) fail(`${flag ?? "argument"} requires a value`);
    if (flag === "--entry" && entryFile === undefined) entryFile = value;
    else if (flag === "--out" && outputFile === undefined) outputFile = value;
    else fail(`unsupported or repeated argument ${flag}`);
  }
  if (!entryFile || !outputFile) fail("--entry and --out are required");
  return { entryFile, outputFile };
}

async function main(): Promise<void> {
  const result = await buildProviderServiceDeploymentBundle(
    parseArgs(process.argv.slice(2)),
  );
  process.stdout.write(`${result.sha256}  ${result.outputFile}\n`);
}

if (import.meta.main) await main();
