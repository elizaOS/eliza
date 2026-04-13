import path from "node:path";
import process from "node:process";
import {
  getLifeOpsLiveSetupWarnings,
  selectLifeOpsLiveProvider,
} from "../../agent/test/helpers/lifeops-live-harness.ts";
import {
  loadLifeOpsScenarioCatalog,
  runLifeOpsScenarioMatrix,
} from "../../agent/test/helpers/lifeops-live-scenario-runner.ts";

type CliOptions = {
  isolate: "shared" | "per-scenario";
  listOnly: boolean;
  reportPath?: string;
  scenarioIds: string[];
};

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    isolate: "per-scenario",
    listOnly: false,
    scenarioIds: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--list") {
      options.listOnly = true;
      continue;
    }
    if (arg === "--scenario") {
      const value = argv[index + 1] ?? "";
      index += 1;
      options.scenarioIds.push(
        ...value
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean),
      );
      continue;
    }
    if (arg === "--report") {
      options.reportPath = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--isolate") {
      const value = argv[index + 1];
      if (value === "shared" || value === "per-scenario") {
        options.isolate = value;
      } else {
        throw new Error(`Unsupported --isolate value: ${String(value)}`);
      }
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const catalog = await loadLifeOpsScenarioCatalog();

  if (options.listOnly) {
    for (const scenario of catalog) {
      console.log(`${scenario.id}\t${scenario.domain}\t${scenario.title}`);
    }
    return;
  }

  const selectedProvider = await selectLifeOpsLiveProvider();
  if (!selectedProvider) {
    const warnings = getLifeOpsLiveSetupWarnings(selectedProvider);
    throw new Error(
      `LifeOps scenario runner is not configured for live execution: ${warnings.join(" | ")}`,
    );
  }

  const { report, reportPath } = await runLifeOpsScenarioMatrix({
    isolate: options.isolate,
    onProgress: (event) => {
      if (event.type === "runtime:start") {
        console.log(
          `[lifeops-scenarios] booting ${event.mode} runtime${event.scenarioId ? ` for ${event.scenarioId}` : ""}`,
        );
        return;
      }
      if (event.type === "runtime:ready") {
        console.log(
          `[lifeops-scenarios] ready ${event.mode} runtime${event.scenarioId ? ` for ${event.scenarioId}` : ""}`,
        );
        return;
      }
      if (event.type === "scenario:start") {
        console.log(
          `[lifeops-scenarios] START ${event.scenarioId} ${event.title}`,
        );
        return;
      }
      if (event.type === "turn:start") {
        console.log(
          `[lifeops-scenarios]   turn ${event.index}/${event.total} ${event.scenarioId} :: ${event.turnName}`,
        );
        return;
      }
      if (event.type === "scenario:complete") {
        console.log(
          `[lifeops-scenarios] ${event.status.toUpperCase()} ${event.scenarioId} (${event.durationMs}ms)${event.error ? ` :: ${event.error}` : ""}`,
        );
      }
    },
    reportPath: options.reportPath
      ? path.resolve(process.cwd(), options.reportPath)
      : undefined,
    scenarioIds: options.scenarioIds,
    selectedProvider,
  });

  const failed = report.scenarios.filter(
    (scenario) => scenario.status === "failed",
  );
  console.log(
    `[lifeops-scenarios] provider=${report.providerName} total=${report.totalCount} failed=${report.failedCount} report=${reportPath}`,
  );
  for (const scenario of report.scenarios) {
    console.log(
      `[lifeops-scenarios] ${scenario.status.toUpperCase()} ${scenario.id} (${scenario.durationMs}ms)`,
    );
    if (scenario.error) {
      console.log(`[lifeops-scenarios]   ${scenario.error}`);
    }
  }

  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

await main();
