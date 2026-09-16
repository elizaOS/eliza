/**
 * Runs the planted-conversation recall scenario once per supported horizon in
 * isolated child processes, then writes one auditable aggregate JSON report.
 */

import { spawn } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MEMORY_HORIZON_SIZES, type MemoryHorizonSize } from "./memory-horizon";

interface MatrixCell {
  messageCount: MemoryHorizonSize;
  exitCode: number;
  status: string;
  durationMs: number | null;
  providerName: string | null;
  executionProfile: string | null;
  scannedRows: number[];
  totalMatches: number[];
  response: string | null;
  reportPath: string;
}

interface MatrixReport {
  schemaVersion: 1;
  generatedAt: string;
  status: "passed" | "failed";
  sizes: readonly MemoryHorizonSize[];
  cells: MatrixCell[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringField(
  record: Record<string, unknown>,
  key: string,
): string | null {
  return typeof record[key] === "string" ? record[key] : null;
}

function numberField(
  record: Record<string, unknown>,
  key: string,
): number | null {
  return typeof record[key] === "number" && Number.isFinite(record[key])
    ? record[key]
    : null;
}

function parseSizes(value: string | undefined): MemoryHorizonSize[] {
  if (!value) return [...MEMORY_HORIZON_SIZES];
  const requested = value.split(",").map((entry) => Number(entry.trim()));
  const sizes = requested.filter((candidate): candidate is MemoryHorizonSize =>
    MEMORY_HORIZON_SIZES.some((supported) => supported === candidate),
  );
  if (
    sizes.length !== requested.length ||
    new Set(sizes).size !== sizes.length
  ) {
    throw new Error(
      `--sizes must contain unique values from ${MEMORY_HORIZON_SIZES.join(", ")}`,
    );
  }
  return sizes;
}

function argumentValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv
    .slice(2)
    .find((arg) => arg.startsWith(prefix))
    ?.slice(prefix.length);
}

function actionMetric(
  action: Record<string, unknown>,
  key: "scanned" | "totalMatches",
): number | null {
  const result = isRecord(action.result) ? action.result : null;
  const values = result && isRecord(result.values) ? result.values : null;
  return values ? numberField(values, key) : null;
}

function parseCell(
  messageCount: MemoryHorizonSize,
  exitCode: number,
  reportPath: string,
  input: unknown,
): MatrixCell {
  if (!isRecord(input) || !Array.isArray(input.scenarios)) {
    throw new Error(`${reportPath} is not a scenario aggregate report`);
  }
  const scenario = input.scenarios[0];
  if (!isRecord(scenario)) {
    throw new Error(`${reportPath} has no scenario result`);
  }
  const actions = Array.isArray(scenario.actionsCalled)
    ? scenario.actionsCalled.filter(isRecord)
    : [];
  const searches = actions.filter(
    (action) => stringField(action, "actionName") === "MEMORY_SEARCH",
  );
  const turns = Array.isArray(scenario.turns)
    ? scenario.turns.filter(isRecord)
    : [];
  return {
    messageCount,
    exitCode,
    status: stringField(scenario, "status") ?? "invalid",
    durationMs: numberField(scenario, "durationMs"),
    providerName: stringField(scenario, "providerName"),
    executionProfile: stringField(scenario, "executionProfile"),
    scannedRows: searches
      .map((action) => actionMetric(action, "scanned"))
      .filter((value): value is number => value !== null),
    totalMatches: searches
      .map((action) => actionMetric(action, "totalMatches"))
      .filter((value): value is number => value !== null),
    response:
      turns.length > 0 ? stringField(turns.at(-1) ?? {}, "responseText") : null,
    reportPath,
  };
}

async function runCell(args: {
  packageRoot: string;
  outputRoot: string;
  provider: string;
  size: MemoryHorizonSize;
}): Promise<MatrixCell> {
  const cellDirectory = path.join(args.outputRoot, String(args.size));
  await mkdir(cellDirectory, { recursive: true });
  const child = spawn(
    process.execPath,
    [
      "--conditions",
      "eliza-source",
      "--tsconfig-override",
      "../../tsconfig.json",
      "src/cli.ts",
      "run",
      "test/scenarios",
      "--scenario",
      "live-planted-conversation-memory-horizon",
      "--provider",
      args.provider,
      "--run-dir",
      cellDirectory,
      "--report-dir",
      cellDirectory,
    ],
    {
      cwd: args.packageRoot,
      env: {
        ...process.env,
        ELIZA_MEMORY_HORIZON_MESSAGES: String(args.size),
      },
      stdio: "inherit",
    },
  );
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code !== null) {
        resolve(code);
        return;
      }
      reject(
        new Error(`${args.size}-message cell exited from signal ${signal}`),
      );
    });
  });
  const reportPath = path.join(cellDirectory, "matrix.json");
  const parsed: unknown = JSON.parse(await readFile(reportPath, "utf8"));
  return parseCell(args.size, exitCode, reportPath, parsed);
}

async function writeAtomicJson(
  filePath: string,
  value: unknown,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, filePath);
}

async function main(): Promise<void> {
  const packageRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const sizes = parseSizes(argumentValue("sizes"));
  const provider = argumentValue("provider") ?? "cli";
  const outputRoot = path.resolve(
    packageRoot,
    argumentValue("output-dir") ?? "../../reports/memory-horizon",
  );
  const cells: MatrixCell[] = [];
  for (const size of sizes) {
    cells.push(await runCell({ packageRoot, outputRoot, provider, size }));
  }
  const report: MatrixReport = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    status: cells.every((cell) => cell.status === "passed")
      ? "passed"
      : "failed",
    sizes,
    cells,
  };
  await writeAtomicJson(path.join(outputRoot, "matrix.json"), report);
  if (report.status === "failed") process.exitCode = 1;
}

await main();
