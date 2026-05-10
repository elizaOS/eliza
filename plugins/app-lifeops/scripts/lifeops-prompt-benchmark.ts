import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  buildExecutiveAssistantPromptBenchmarkCases,
  buildLifeOpsPromptBenchmarkCases,
  buildSelfCarePromptBenchmarkCases,
  type PromptBenchmarkCase,
} from "../test/helpers/lifeops-prompt-benchmark-cases.ts";
import {
  buildAxOptimizationRows,
  formatPromptBenchmarkReportMarkdown,
  runLifeOpsPromptBenchmark,
  serializeAxOptimizationRows,
} from "../test/helpers/lifeops-prompt-benchmark-runner.ts";

type RunLifeOpsPromptBenchmarkOptions = NonNullable<
  Parameters<typeof runLifeOpsPromptBenchmark>[0]
>;
type LiveProviderName = RunLifeOpsPromptBenchmarkOptions["preferredProvider"];

type CliOptions = {
  axPath?: string;
  isolate: "shared" | "per-case";
  listOnly: boolean;
  markdownPath?: string;
  preferredProvider?: LiveProviderName;
  reportPath?: string;
  suite: "all" | "executive-assistant" | "self-care";
  variantIds: string[];
};

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    isolate: "shared",
    listOnly: false,
    suite: "all",
    variantIds: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--list") {
      options.listOnly = true;
      continue;
    }
    if (arg === "--suite") {
      const value = String(argv[index + 1] ?? "").trim();
      if (
        value === "all" ||
        value === "self-care" ||
        value === "executive-assistant"
      ) {
        options.suite = value;
        index += 1;
        continue;
      }
      throw new Error(`Unsupported --suite value: ${value}`);
    }
    if (arg === "--variant") {
      const value = String(argv[index + 1] ?? "").trim();
      options.variantIds.push(
        ...value
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean),
      );
      index += 1;
      continue;
    }
    if (arg === "--report") {
      options.reportPath = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--markdown") {
      options.markdownPath = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--ax") {
      options.axPath = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--provider") {
      options.preferredProvider = argv[index + 1] as
        | LiveProviderName
        | undefined;
      index += 1;
      continue;
    }
    if (arg === "--isolate") {
      const value = String(argv[index + 1] ?? "").trim();
      if (value === "shared" || value === "per-case") {
        options.isolate = value;
        index += 1;
        continue;
      }
      throw new Error(`Unsupported --isolate value: ${value}`);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

async function loadCases(
  suite: CliOptions["suite"],
): Promise<PromptBenchmarkCase[]> {
  if (suite === "self-care") {
    return buildSelfCarePromptBenchmarkCases();
  }
  if (suite === "executive-assistant") {
    return buildExecutiveAssistantPromptBenchmarkCases();
  }
  return buildLifeOpsPromptBenchmarkCases();
}

function filterCases(
  cases: PromptBenchmarkCase[],
  options: CliOptions,
): PromptBenchmarkCase[] {
  const selectedVariants = new Set(options.variantIds);
  if (selectedVariants.size === 0) {
    return cases;
  }
  return cases.filter((testCase) => selectedVariants.has(testCase.variantId));
}

function defaultArtifactBase(): string {
  return path.join(
    process.cwd(),
    ".tmp",
    `lifeops-prompt-benchmark-${Date.now()}`,
  );
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const basePath = defaultArtifactBase();
  const reportPath = options.reportPath
    ? path.resolve(process.cwd(), options.reportPath)
    : `${basePath}.json`;
  const markdownPath = options.markdownPath
    ? path.resolve(process.cwd(), options.markdownPath)
    : `${basePath}.md`;
  const axPath = options.axPath
    ? path.resolve(process.cwd(), options.axPath)
    : `${basePath}.jsonl`;

  const allCases = filterCases(await loadCases(options.suite), options);
  if (allCases.length === 0) {
    throw new Error("No prompt benchmark cases matched the requested filters.");
  }

  if (options.listOnly) {
    const bySuite = new Map<string, number>();
    const byVariant = new Map<string, number>();
    for (const testCase of allCases) {
      bySuite.set(testCase.suiteId, (bySuite.get(testCase.suiteId) ?? 0) + 1);
      byVariant.set(
        testCase.variantId,
        (byVariant.get(testCase.variantId) ?? 0) + 1,
      );
    }
    console.log(`[lifeops-prompt-benchmark] total=${allCases.length}`);
    for (const [suiteId, count] of Array.from(bySuite.entries()).sort()) {
      console.log(`[lifeops-prompt-benchmark] suite ${suiteId}: ${count}`);
    }
    for (const [variantId, count] of Array.from(byVariant.entries()).sort()) {
      console.log(`[lifeops-prompt-benchmark] variant ${variantId}: ${count}`);
    }
    return;
  }

  const report = await runLifeOpsPromptBenchmark({
    cases: allCases,
    isolate: options.isolate,
    preferredProvider: options.preferredProvider,
  });
  const markdown = formatPromptBenchmarkReportMarkdown(report);
  const axRows = buildAxOptimizationRows(report);

  await mkdir(path.dirname(reportPath), { recursive: true });
  await mkdir(path.dirname(markdownPath), { recursive: true });
  await mkdir(path.dirname(axPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, `${markdown}\n`, "utf8");
  await writeFile(axPath, serializeAxOptimizationRows(axRows), "utf8");

  console.log(
    `[lifeops-prompt-benchmark] provider=${report.providerName} total=${report.total} passed=${report.passed} failed=${report.failed} report=${reportPath}`,
  );
  console.log(
    `[lifeops-prompt-benchmark] markdown=${markdownPath} ax=${axPath}`,
  );

  for (const failure of report.failures.slice(0, 10)) {
    console.log(
      `[lifeops-prompt-benchmark] FAIL ${failure.case.caseId} expected=${failure.case.expectedAction ?? "null/REPLY"} actual=${failure.actualPrimaryAction ?? "null"}`,
    );
  }

  if (report.failed > 0) {
    process.exitCode = 1;
  }
}

await main();
