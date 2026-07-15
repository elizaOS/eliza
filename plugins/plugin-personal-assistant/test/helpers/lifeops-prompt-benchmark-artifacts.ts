/**
 * Writes the review bundle for a LifeOps prompt benchmark: scored case rows,
 * human-readable summary, full report, native trajectories, and file digests.
 * CI uploads the directory intact so every terminal outcome is inspectable.
 */
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildAxOptimizationRows,
  formatPromptBenchmarkReportMarkdown,
  type PromptBenchmarkReport,
  serializeAxOptimizationRows,
} from "./lifeops-prompt-benchmark-runner.ts";

type ArtifactFile = {
  path: string;
  bytes: number;
  sha256: string;
};

export type PromptBenchmarkArtifactManifest = {
  schemaVersion: 1;
  generatedAt: string;
  providerName: string;
  capabilityProfile: PromptBenchmarkReport["capabilityProfile"];
  selectedCases: number;
  completedCases: number;
  unavailableCases: number;
  failedCases: number;
  cases: Array<{
    caseId: string;
    terminalOutcome: PromptBenchmarkReport["results"][number]["terminalOutcome"];
    nativeTrajectoryRelativePath?: string;
  }>;
  files: ArtifactFile[];
};

async function collectArtifactFiles(args: {
  artifactDir: string;
  currentDir: string;
}): Promise<ArtifactFile[]> {
  const entries = await readdir(args.currentDir, { withFileTypes: true });
  const files: ArtifactFile[] = [];
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const absolutePath = path.join(args.currentDir, entry.name);
    if (entry.isDirectory()) {
      files.push(
        ...(await collectArtifactFiles({
          artifactDir: args.artifactDir,
          currentDir: absolutePath,
        })),
      );
      continue;
    }
    if (!entry.isFile() || entry.name === "manifest.json") {
      continue;
    }
    const contents = await readFile(absolutePath);
    files.push({
      path: path.relative(args.artifactDir, absolutePath),
      bytes: contents.byteLength,
      sha256: createHash("sha256").update(contents).digest("hex"),
    });
  }
  return files;
}

export async function writePromptBenchmarkArtifacts(args: {
  artifactDir: string;
  report: PromptBenchmarkReport;
}): Promise<PromptBenchmarkArtifactManifest> {
  await mkdir(args.artifactDir, { recursive: true });
  const rows = buildAxOptimizationRows(args.report);
  await Promise.all([
    writeFile(
      path.join(args.artifactDir, "report.json"),
      `${JSON.stringify(args.report, null, 2)}\n`,
      "utf8",
    ),
    writeFile(
      path.join(args.artifactDir, "report.md"),
      `${formatPromptBenchmarkReportMarkdown(args.report)}\n`,
      "utf8",
    ),
    writeFile(
      path.join(args.artifactDir, "cases.jsonl"),
      serializeAxOptimizationRows(rows),
      "utf8",
    ),
  ]);

  const manifest: PromptBenchmarkArtifactManifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    providerName: args.report.providerName,
    capabilityProfile: args.report.capabilityProfile,
    selectedCases: args.report.total,
    completedCases: args.report.completed,
    unavailableCases: args.report.unavailable,
    failedCases: args.report.terminalFailed,
    cases: args.report.results.map((result) => ({
      caseId: result.case.caseId,
      terminalOutcome: result.terminalOutcome,
      ...(result.nativeTrajectoryRelativePath
        ? {
            nativeTrajectoryRelativePath: path.join(
              "native-trajectories",
              result.nativeTrajectoryRelativePath,
            ),
          }
        : {}),
    })),
    files: await collectArtifactFiles({
      artifactDir: args.artifactDir,
      currentDir: args.artifactDir,
    }),
  };
  await writeFile(
    path.join(args.artifactDir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  return manifest;
}
