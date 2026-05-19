import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { validateGithubLiveEvidence } from "./validate-capability-router-github-live-evidence.ts";

const CLOUD_ARTIFACT = "remote-capability-cloud-live-report";
const PROVIDER_ARTIFACT = "remote-capability-provider-live-report";

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const workspace =
    options.outputDir ??
    mkdtempSync(join(tmpdir(), "capability-router-github-live-artifacts-"));
  let removeWorkspace = options.outputDir === undefined;
  try {
    const runJson = runCommand("gh", [
      "run",
      "view",
      options.runId,
      "--json",
      "databaseId,event,status,conclusion,jobs",
    ]);
    const run = JSON.parse(runJson) as Parameters<
      typeof validateGithubLiveEvidence
    >[0];
    const failures = validateGithubLiveEvidence(run);
    if (failures.length > 0) {
      for (const failure of failures) {
        console.error(`${failure.path}: ${failure.message}`);
      }
      process.exitCode = 1;
      return;
    }

    runCommand("gh", [
      "run",
      "download",
      options.runId,
      "--dir",
      workspace,
      "--name",
      CLOUD_ARTIFACT,
      "--name",
      PROVIDER_ARTIFACT,
    ]);

    runCommand("bun", [
      "run",
      "test:remote-capabilities:validate-live-reports",
      "--kind",
      "cloud",
      "--expect-count",
      "1",
      "--max-age-minutes",
      String(options.maxAgeMinutes),
      "--max-future-minutes",
      "5",
      "--require-ci",
      "--require-file-identity",
      join(workspace, CLOUD_ARTIFACT),
    ]);
    runCommand("bun", [
      "run",
      "test:remote-capabilities:validate-live-reports",
      "--kind",
      "provider",
      "--expect-count",
      "3..4",
      "--max-age-minutes",
      String(options.maxAgeMinutes),
      "--max-future-minutes",
      "5",
      "--allowed-providers",
      "e2b,home-machine,mobile-companion,desktop-companion",
      "--require-providers",
      "e2b,home-machine,mobile-companion",
      "--require-ci",
      "--require-file-identity",
      join(workspace, PROVIDER_ARTIFACT),
    ]);

    removeWorkspace = !options.keepArtifacts && options.outputDir === undefined;
    console.log(
      `Capability-router GitHub live artifacts validated for run ${options.runId}.`,
    );
    if (options.keepArtifacts || options.outputDir !== undefined) {
      console.log(`Downloaded artifacts: ${workspace}`);
    }
  } finally {
    if (removeWorkspace) {
      rmSync(workspace, { force: true, recursive: true });
    }
  }
}

function parseArgs(args: string[]): {
  keepArtifacts: boolean;
  maxAgeMinutes: number;
  outputDir?: string;
  runId: string;
} {
  let keepArtifacts = false;
  let maxAgeMinutes = 90;
  let outputDir: string | undefined;
  let runId: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--keep-artifacts") {
      keepArtifacts = true;
      continue;
    }
    if (arg === "--dir") {
      outputDir = requireOptionValue(args[++index], "--dir");
      continue;
    }
    if (arg.startsWith("--dir=")) {
      outputDir = requireOptionValue(arg.slice("--dir=".length), "--dir");
      continue;
    }
    if (arg === "--max-age-minutes") {
      maxAgeMinutes = parsePositiveNumber(
        requireOptionValue(args[++index], "--max-age-minutes"),
        "--max-age-minutes",
      );
      continue;
    }
    if (arg.startsWith("--max-age-minutes=")) {
      maxAgeMinutes = parsePositiveNumber(
        requireOptionValue(
          arg.slice("--max-age-minutes=".length),
          "--max-age-minutes",
        ),
        "--max-age-minutes",
      );
      continue;
    }
    if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    }
    if (runId) throw new Error("Only one GitHub run id may be provided.");
    runId = arg;
  }
  if (!runId || !/^\d+$/.test(runId)) {
    throw new Error(
      "Usage: bun packages/scripts/validate-capability-router-github-live-artifacts.ts [--keep-artifacts] [--dir PATH] [--max-age-minutes N] <run-id>",
    );
  }
  return { keepArtifacts, maxAgeMinutes, outputDir, runId };
}

function requireOptionValue(value: string | undefined, option: string): string {
  if (!value) throw new Error(`${option} requires a value.`);
  return value;
}

function parsePositiveNumber(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${option} must be a positive number.`);
  }
  return parsed;
}

function runCommand(command: string, args: string[]): string {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
    throw new Error(
      `${command} ${args.join(" ")} failed with exit code ${result.status}: ${output}`,
    );
  }
  return result.stdout;
}

if (import.meta.main) {
  main();
}
