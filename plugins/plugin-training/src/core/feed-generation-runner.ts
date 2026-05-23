import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { trainingStateRoot } from "./training-config.js";
import { defaultBunCommand, resolveWorkspaceRoot } from "./workspace-runtime.js";

export interface FeedGenerationRunOptions {
  workspaceRoot?: string;
  bun?: string;
  archetypes?: string;
  numAgents?: number;
  ticks?: number;
  parallel?: number;
  managerId?: string;
  cleanup?: boolean;
  dryRun?: boolean;
  outputDir?: string;
}

export interface FeedGenerationRunResult {
  workspaceRoot: string;
  feedCliRoot: string;
  outputDir: string;
  artifacts: FeedGenerationArtifact[];
  command: string[];
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface FeedGenerationArtifact {
  schema: string | null;
  manifestPath: string;
  exportPath: string | null;
  outputDir: string | null;
  sourceKind: string | null;
  trajectories: number | null;
  archetypes: unknown;
  generatedAt: string | null;
}

function safeTimestamp(value: string): string {
  return value.replace(/[:.]/g, "-");
}

function positiveInt(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(1, Math.floor(value))
    : fallback;
}

function collectProcess(
  command: string,
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseArchetypes(value: string | undefined): string[] {
  const archetypes = (value ?? "trader")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return archetypes.length > 0 ? archetypes : ["trader"];
}

async function writeDryRunFeedGenerationArtifact(input: {
  outputDir: string;
  options: FeedGenerationRunOptions;
}): Promise<void> {
  const generatedAt = new Date().toISOString();
  const archetypes = parseArchetypes(input.options.archetypes);
  const agentsPerArchetype = positiveInt(input.options.numAgents, 1);
  const ticks = positiveInt(input.options.ticks, 1);
  const trajectoryRows = archetypes.flatMap((archetype) =>
    Array.from({ length: agentsPerArchetype }, (_, index) => {
      const ordinal = index + 1;
      return {
        trajectory_id: `feed-dry-run-${archetype}-${ordinal}`,
        agent_id: `feed-dry-run-agent-${archetype}-${ordinal}`,
        archetype,
        scenario_id: "feed-dry-run",
        score: null,
        steps: [
          {
            action: "DRY_RUN",
            kind: "planned_tick",
            input: `${archetype} market observation for dry-run tick 1 of ${ticks}`,
            output: `planned ${archetype} feed decision`,
            tick: 1,
            ticks,
          },
        ],
        reasoning: `Dry-run feed generation preview for ${archetype}.`,
      };
    }),
  );
  const exportPath = join(input.outputDir, "feed-dry-run-trajectories.jsonl");
  const manifestPath = join(input.outputDir, "feed-dry-run.manifest.json");
  const trajectoryIds = trajectoryRows.map((row) => row.trajectory_id);
  const agentsCreated = trajectoryRows.map((row) => row.agent_id);
  const archetypeStats = Object.fromEntries(
    archetypes.map((archetype) => [
      archetype,
      {
        agents: agentsPerArchetype,
        trajectories: agentsPerArchetype,
        avgTicksPerAgent: ticks,
      },
    ]),
  );
  await writeFile(
    exportPath,
    `${trajectoryRows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    "utf8",
  );
  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        schema: "feed_parallel_generation",
        schemaVersion: 1,
        generatedAt,
        outputDir: input.outputDir,
        exportPath,
        manifestPath,
        source: {
          kind: "feed_train_parallel_generation",
          archetypes,
        },
        counts: {
          agentsCreated: agentsCreated.length,
          trajectories: trajectoryIds.length,
          totalTicks: agentsCreated.length * ticks,
          errors: 0,
        },
        durationMs: 0,
        cleanup: input.options.cleanup === true,
        dryRun: true,
        agentsCreated,
        trajectoryIds,
        archetypeStats,
        errors: [],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

async function discoverFeedGenerationArtifacts(
  outputDir: string,
): Promise<FeedGenerationArtifact[]> {
  const manifestPaths: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".manifest.json")) {
        manifestPaths.push(path);
      }
    }
  }
  await walk(outputDir);
  const artifacts: FeedGenerationArtifact[] = [];
  for (const manifestPath of manifestPaths) {
    try {
      const payload = asRecord(JSON.parse(await readFile(manifestPath, "utf8")));
      if (!payload) continue;
      const schema = stringOrNull(payload.schema);
      if (
        schema !== "feed_parallel_generation" &&
        schema !== "feed_training_trajectory_export"
      ) {
        continue;
      }
      const counts = asRecord(payload.counts) ?? {};
      const source = asRecord(payload.source) ?? {};
      artifacts.push({
        schema,
        manifestPath,
        exportPath: stringOrNull(payload.exportPath),
        outputDir: stringOrNull(payload.outputDir),
        sourceKind: stringOrNull(source.kind),
        trajectories: numberOrNull(counts.trajectories),
        archetypes: source.archetypes ?? source.archetype ?? null,
        generatedAt: stringOrNull(payload.generatedAt),
      });
    } catch {
      // Ignore malformed manifests; they will be visible in stdout/stderr.
    }
  }
  return artifacts.sort((left, right) =>
    left.manifestPath.localeCompare(right.manifestPath),
  );
}

export function buildFeedGenerationArgs(
  options: FeedGenerationRunOptions,
  resolved: { outputDir: string },
): string[] {
  const args = [
    "run",
    "src/index.ts",
    "train",
    "parallel",
    "--archetypes",
    options.archetypes?.trim() || "trader",
    "--num-agents",
    String(positiveInt(options.numAgents, 1)),
    "--ticks",
    String(positiveInt(options.ticks, 1)),
    "--parallel",
    String(positiveInt(options.parallel, 1)),
    "--output-dir",
    resolved.outputDir,
  ];
  if (options.managerId) args.push("--manager-id", options.managerId);
  if (options.cleanup) args.push("--cleanup");
  if (options.dryRun) args.push("--dry-run");
  return args;
}

export async function runFeedGeneration(
  options: FeedGenerationRunOptions = {},
): Promise<FeedGenerationRunResult> {
  const workspaceRoot = resolveWorkspaceRoot(options.workspaceRoot);
  const feedCliRoot = join(workspaceRoot, "packages", "feed", "apps", "cli");
  const stamp = safeTimestamp(new Date().toISOString());
  const outputDir =
    options.outputDir ?? join(trainingStateRoot(), "feed", "parallel", stamp);
  await mkdir(outputDir, { recursive: true });
  const args = buildFeedGenerationArgs(options, { outputDir });
  const command = options.bun ?? defaultBunCommand();
  const proc = await collectProcess(command, args, feedCliRoot);
  if (proc.exitCode !== 0) {
    throw new Error(
      `feed train parallel exited with code ${proc.exitCode}: ${proc.stderr || proc.stdout}`,
    );
  }
  let artifacts = await discoverFeedGenerationArtifacts(outputDir);
  if (options.dryRun === true && artifacts.length === 0) {
    await writeDryRunFeedGenerationArtifact({ outputDir, options });
    artifacts = await discoverFeedGenerationArtifacts(outputDir);
  }
  return {
    workspaceRoot,
    feedCliRoot,
    outputDir,
    artifacts,
    command: [command, ...args],
    stdout: proc.stdout,
    stderr: proc.stderr,
    exitCode: proc.exitCode,
  };
}
