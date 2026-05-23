import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { trainingStateRoot } from "./training-config.js";

export const ELIZA1_BUNDLE_STAGE_SCHEMA = "eliza1_bundle_stage";
export const ELIZA1_BUNDLE_STAGE_VERSION = 1;

export interface StageEliza1BundleOptions {
  trainingRoot?: string;
  python?: string;
  repoId?: string;
  tier?: string;
  localDir?: string;
  outputDir?: string;
  maxBytes?: number;
  apply?: boolean;
}

export interface Eliza1BundleStageManifest {
  schema: typeof ELIZA1_BUNDLE_STAGE_SCHEMA;
  schemaVersion: typeof ELIZA1_BUNDLE_STAGE_VERSION;
  generatedAt: string;
  trainingRoot: string;
  outputDir: string;
  manifestPath: string;
  command: string[];
  exitCode: number;
  repoId: string | null;
  tier: string | null;
  bundleDir: string | null;
  fileCount: number | null;
  plannedBytes: number | null;
  maxBytes: number | null;
  apply: boolean;
  stagedCount: number;
  plan: Record<string, unknown> | null;
}

export interface StageEliza1BundleResult {
  trainingRoot: string;
  outputDir: string;
  manifestPath: string;
  manifest: Eliza1BundleStageManifest;
  command: string[];
  stdout: string;
  stderr: string;
  exitCode: number;
  plan: Record<string, unknown> | null;
}

function collectProcess(
  command: string,
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolvePromise({ stdout, stderr, exitCode: code ?? 1 });
    });
  });
}

export function parseStageEliza1BundlePlan(
  stdout: string,
): Record<string, unknown> | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function buildStageEliza1BundleArgs(
  options: StageEliza1BundleOptions,
  resolved: { trainingRoot: string },
): string[] {
  const scriptPath = join(
    resolved.trainingRoot,
    "scripts",
    "manifest",
    "stage_hf_eliza1_bundle.py",
  );
  const args = [scriptPath, "--tier", options.tier ?? "0_8b"];
  if (options.repoId?.trim()) args.push("--repo-id", options.repoId.trim());
  if (options.localDir?.trim())
    args.push("--local-dir", resolve(options.localDir.trim()));
  if (
    typeof options.maxBytes === "number" &&
    Number.isFinite(options.maxBytes)
  ) {
    args.push("--max-bytes", String(Math.max(1, Math.floor(options.maxBytes))));
  }
  if (options.apply === true) args.push("--apply");
  return args;
}

function safeTimestamp(value: string): string {
  return value.replace(/[:.]/g, "-");
}

function stringField(
  record: Record<string, unknown> | null,
  key: string,
): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function numberField(
  record: Record<string, unknown> | null,
  key: string,
): number | null {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stagedCount(record: Record<string, unknown> | null): number {
  const staged = record?.staged;
  return Array.isArray(staged) ? staged.length : 0;
}

export function buildEliza1BundleStageManifest(input: {
  generatedAt: string;
  trainingRoot: string;
  outputDir: string;
  manifestPath: string;
  command: string[];
  exitCode: number;
  plan: Record<string, unknown> | null;
}): Eliza1BundleStageManifest {
  return {
    schema: ELIZA1_BUNDLE_STAGE_SCHEMA,
    schemaVersion: ELIZA1_BUNDLE_STAGE_VERSION,
    generatedAt: input.generatedAt,
    trainingRoot: input.trainingRoot,
    outputDir: input.outputDir,
    manifestPath: input.manifestPath,
    command: input.command,
    exitCode: input.exitCode,
    repoId: stringField(input.plan, "repoId"),
    tier: stringField(input.plan, "tier"),
    bundleDir: stringField(input.plan, "bundleDir"),
    fileCount: numberField(input.plan, "fileCount"),
    plannedBytes: numberField(input.plan, "plannedBytes"),
    maxBytes: numberField(input.plan, "maxBytes"),
    apply: input.plan?.apply === true,
    stagedCount: stagedCount(input.plan),
    plan: input.plan,
  };
}

export async function stageEliza1Bundle(
  options: StageEliza1BundleOptions = {},
): Promise<StageEliza1BundleResult> {
  const trainingRoot = resolve(
    options.trainingRoot ?? join(process.cwd(), "packages", "training"),
  );
  const command = options.python ?? "python3";
  const args = buildStageEliza1BundleArgs(options, { trainingRoot });
  const generatedAt = new Date().toISOString();
  const outputDir =
    options.outputDir ??
    join(
      trainingStateRoot(),
      "models",
      "staged-bundles",
      `${options.tier ?? "0_8b"}-${safeTimestamp(generatedAt)}`,
    );
  await mkdir(outputDir, { recursive: true });
  const proc = await collectProcess(command, args, trainingRoot);
  if (proc.exitCode !== 0) {
    throw new Error(
      `stage_hf_eliza1_bundle.py exited with code ${proc.exitCode}: ${
        proc.stderr || proc.stdout
      }`,
    );
  }
  const plan = parseStageEliza1BundlePlan(proc.stdout);
  const manifestPath = join(outputDir, "eliza1-bundle-stage-manifest.json");
  const manifest = buildEliza1BundleStageManifest({
    generatedAt,
    trainingRoot,
    outputDir,
    manifestPath,
    command: [command, ...args],
    exitCode: proc.exitCode,
    plan,
  });
  await writeFile(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  return {
    trainingRoot,
    outputDir,
    manifestPath,
    manifest,
    command: [command, ...args],
    stdout: proc.stdout,
    stderr: proc.stderr,
    exitCode: proc.exitCode,
    plan,
  };
}
