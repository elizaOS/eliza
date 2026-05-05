#!/usr/bin/env bun
import { spawn } from "node:child_process";
/**
 * elizaOS App Benchmark Orchestrator
 *
 * Loads task definitions, invokes the benchmark CLI for each task,
 * collects results, and produces a summary report.
 *
 * Usage:
 *   bun run benchmarks/app-eval/run-benchmarks.ts                    # run all
 *   bun run benchmarks/app-eval/run-benchmarks.ts --type research    # research only
 *   bun run benchmarks/app-eval/run-benchmarks.ts --type coding      # coding only
 *   bun run benchmarks/app-eval/run-benchmarks.ts --task code-001    # single task
 *   bun run benchmarks/app-eval/run-benchmarks.ts --dry-run          # show tasks without running
 *   bun run benchmarks/app-eval/run-benchmarks.ts --server           # use server mode (boot once)
 *   bun run benchmarks/app-eval/run-benchmarks.ts --timeout 60000    # custom timeout per task
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Resolve the app repo root. Accepts an explicit --root flag,
 * falls back to ELIZA_APP_ROOT env var, then
 * walks up from this file looking for a package.json with a
 * "benchmark" script.
 */
function resolveRepoRoot(rootArg?: string): string {
  if (rootArg) return resolve(rootArg);
  const fromEnv = process.env.ELIZA_APP_ROOT;
  if (fromEnv) return resolve(fromEnv);
  // Default: assume we're inside eliza/packages/benchmarks/app-eval/
  return resolve(__dirname, "../../..");
}

let REPO_ROOT = resolveRepoRoot();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TaskDefinition {
  id: string;
  type: string;
  prompt: string;
  expected_keywords?: string[];
  category?: string;
  difficulty?: string;
  max_score?: number;
  evaluation?: {
    criteria: Array<{
      name: string;
      weight: number;
      description: string;
    }>;
  };
}

interface BenchmarkResult {
  id: string;
  response: string;
  actions_taken: string[];
  duration_ms: number;
  success: boolean;
  error?: string;
}

interface TaskResultWithMeta extends BenchmarkResult {
  type: string;
  difficulty?: string;
  prompt: string;
}

interface RunSummary {
  run_id: string;
  started_at: string;
  completed_at: string;
  total_tasks: number;
  completed: number;
  failed: number;
  timed_out: number;
  scores: {
    research?: CategoryScore;
    coding?: CategoryScore;
  };
  overall_score: number;
  avg_duration_ms: number;
}

interface CategoryScore {
  avg: number;
  min: number;
  max: number;
  total: number;
  completed: number;
  failed: number;
  tasks: Array<{
    id: string;
    success: boolean;
    duration_ms: number;
    score: number;
    error?: string;
  }>;
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

interface CliArgs {
  type?: string;
  taskId?: string;
  dryRun: boolean;
  server: boolean;
  timeout: number;
  verbose: boolean;
  root?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    dryRun: false,
    server: false,
    timeout: 120_000,
    verbose: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--type" && argv[i + 1]) {
      args.type = argv[++i];
    } else if (arg === "--task" && argv[i + 1]) {
      args.taskId = argv[++i];
    } else if (arg === "--root" && argv[i + 1]) {
      args.root = argv[++i];
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--server") {
      args.server = true;
    } else if (arg === "--timeout" && argv[i + 1]) {
      args.timeout = Number.parseInt(argv[++i], 10);
    } else if (arg === "--verbose" || arg === "-v") {
      args.verbose = true;
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
  }

  return args;
}

function printUsage(): void {
  console.log(`
elizaOS App Benchmark Orchestrator

Usage:
  bun run app-eval/run-benchmarks.ts [options]

Options:
  --type <research|coding>  Run only tasks of this type
  --task <id>               Run a single task by ID
  --root <path>             App repo root (default: ELIZA_APP_ROOT env or auto-detect)
  --dry-run                 Show tasks without running them
  --server                  Use server mode (boot runtime once, stream tasks)
  --timeout <ms>            Timeout per task in milliseconds (default: 120000)
  --verbose, -v             Show detailed output
  --help, -h                Show this help
`);
}

// ---------------------------------------------------------------------------
// Task loading
// ---------------------------------------------------------------------------

function loadTasks(args: CliArgs): TaskDefinition[] {
  const tasksDir = join(__dirname, "tasks");
  const files: Array<{ path: string; type: string }> = [];

  if (!args.type || args.type === "research") {
    const p = join(tasksDir, "research-tasks.json");
    if (existsSync(p)) files.push({ path: p, type: "research" });
  }
  if (!args.type || args.type === "coding") {
    const p = join(tasksDir, "coding-tasks.json");
    if (existsSync(p)) files.push({ path: p, type: "coding" });
  }

  const tasks: TaskDefinition[] = [];
  for (const file of files) {
    try {
      const raw = readFileSync(file.path, "utf-8");
      const parsed: TaskDefinition[] = JSON.parse(raw);
      for (const task of parsed) {
        if (!task.type) task.type = file.type;
        tasks.push(task);
      }
    } catch (err) {
      console.error(`[orchestrator] Failed to load ${file.path}: ${err}`);
    }
  }

  if (args.taskId) {
    const filtered = tasks.filter((t) => t.id === args.taskId);
    if (filtered.length === 0) {
      console.error(
        `[orchestrator] Task ${args.taskId} not found in loaded definitions`,
      );
      process.exit(1);
    }
    return filtered;
  }

  return tasks;
}

// ---------------------------------------------------------------------------
// Result directory management
// ---------------------------------------------------------------------------

function createResultsDir(): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const resultsBase = join(__dirname, "results");
  const runDir = join(resultsBase, timestamp);

  mkdirSync(runDir, { recursive: true });

  // Update "latest" symlink
  const latestLink = join(resultsBase, "latest");
  try {
    if (existsSync(latestLink)) {
      const stat = lstatSync(latestLink);
      if (stat.isSymbolicLink()) {
        unlinkSync(latestLink);
      }
    }
    symlinkSync(timestamp, latestLink);
  } catch {
    // Symlink creation may fail on some systems; non-critical
  }

  return runDir;
}

// ---------------------------------------------------------------------------
// Task execution — single process mode
// ---------------------------------------------------------------------------

function runSingleTask(
  task: TaskDefinition,
  timeoutMs: number,
): Promise<BenchmarkResult> {
  return new Promise((resolvePromise) => {
    const taskJson = JSON.stringify({
      id: task.id,
      type: task.type,
      prompt: task.prompt,
    });
    const binPath = join(REPO_ROOT, "packages", "agent", "src", "bin.ts");

    const child = spawn(
      "bun",
      ["run", binPath, "benchmark", "--timeout", String(timeoutMs)],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          ELIZA_HEADLESS: "1",
          LOG_LEVEL: "error",
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    // Send task via stdin
    child.stdin.write(taskJson);
    child.stdin.end();

    // Outer timeout (startup + task timeout + buffer)
    const outerTimeout = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000);
    }, timeoutMs + 60_000);

    child.on("close", (code) => {
      clearTimeout(outerTimeout);

      // Parse the last JSON line from stdout
      const lines = stdout.trim().split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (line.startsWith("{")) {
          try {
            resolvePromise(JSON.parse(line));
            return;
          } catch {}
        }
      }

      resolvePromise({
        id: task.id,
        response: "",
        actions_taken: [],
        duration_ms: 0,
        success: false,
        error:
          code !== 0
            ? `Process exited with code ${code}. stderr: ${stderr.slice(0, 500)}`
            : "No JSON result found in output",
      });
    });

    child.on("error", (err) => {
      clearTimeout(outerTimeout);
      resolvePromise({
        id: task.id,
        response: "",
        actions_taken: [],
        duration_ms: 0,
        success: false,
        error: `Spawn error: ${err.message}`,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Task execution — server mode (boot once, stream tasks)
// ---------------------------------------------------------------------------

async function runTasksServerMode(
  tasks: TaskDefinition[],
  timeoutMs: number,
  verbose: boolean,
): Promise<BenchmarkResult[]> {
  const binPath = join(REPO_ROOT, "packages", "agent", "src", "bin.ts");

  return new Promise((resolvePromise) => {
    const child = spawn(
      "bun",
      ["run", binPath, "benchmark", "--server", "--timeout", String(timeoutMs)],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          ELIZA_HEADLESS: "1",
          LOG_LEVEL: "error",
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    const results: BenchmarkResult[] = [];
    let stdoutBuffer = "";
    let taskIndex = 0;

    child.stdout.on("data", (data: Buffer) => {
      stdoutBuffer += data.toString();

      // Process complete lines
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() ?? ""; // Keep incomplete line in buffer

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("{")) continue;
        try {
          const result: BenchmarkResult = JSON.parse(trimmed);
          results.push(result);
          if (verbose) {
            const status = result.success ? "PASS" : "FAIL";
            console.log(`  [${status}] ${result.id} (${result.duration_ms}ms)`);
          }

          // Send next task
          taskIndex++;
          if (taskIndex < tasks.length) {
            const nextTask = tasks[taskIndex];
            child.stdin.write(
              JSON.stringify({
                id: nextTask.id,
                type: nextTask.type,
                prompt: nextTask.prompt,
              }) + "\n",
            );
          } else {
            // All tasks sent and results received
            child.stdin.end();
          }
        } catch {
          // Not valid JSON, skip
        }
      }
    });

    if (verbose) {
      child.stderr.on("data", (data: Buffer) => {
        process.stderr.write(data);
      });
    }

    // Total timeout: startup + all tasks
    const totalTimeout = setTimeout(
      () => {
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 5_000);
      },
      90_000 + timeoutMs * tasks.length,
    );

    child.on("close", () => {
      clearTimeout(totalTimeout);

      // Process remaining buffered output
      if (stdoutBuffer.trim().startsWith("{")) {
        try {
          results.push(JSON.parse(stdoutBuffer.trim()));
        } catch {
          // ignore
        }
      }

      // Fill in missing results for tasks that didn't get responses
      const resultIds = new Set(results.map((r) => r.id));
      for (const task of tasks) {
        if (!resultIds.has(task.id)) {
          results.push({
            id: task.id,
            response: "",
            actions_taken: [],
            duration_ms: 0,
            success: false,
            error: "No result received (server may have exited early)",
          });
        }
      }

      resolvePromise(results);
    });

    child.on("error", (err) => {
      clearTimeout(totalTimeout);
      resolvePromise(
        tasks.map((t) => ({
          id: t.id,
          response: "",
          actions_taken: [],
          duration_ms: 0,
          success: false,
          error: `Server spawn error: ${err.message}`,
        })),
      );
    });

    // Send first task
    if (tasks.length > 0) {
      const firstTask = tasks[0];
      child.stdin.write(
        JSON.stringify({
          id: firstTask.id,
          type: firstTask.type,
          prompt: firstTask.prompt,
        }) + "\n",
      );
    } else {
      child.stdin.end();
    }
  });
}

// ---------------------------------------------------------------------------
// Keyword-based scoring (deterministic, no LLM needed)
// ---------------------------------------------------------------------------

function scoreResult(task: TaskDefinition, result: BenchmarkResult): number {
  if (!result.success || !result.response) return 0;

  const maxScore = task.max_score ?? 10;
  let score = 0;

  // 1. Base score for successful completion (40% of max)
  score += maxScore * 0.4;

  // 2. Keyword coverage (30% of max)
  if (task.expected_keywords && task.expected_keywords.length > 0) {
    const responseLower = result.response.toLowerCase();
    const matched = task.expected_keywords.filter((kw) =>
      responseLower.includes(kw.toLowerCase()),
    );
    const coverage = matched.length / task.expected_keywords.length;
    score += maxScore * 0.3 * coverage;
  } else {
    // No keywords defined — give full keyword score if response is substantial
    score += result.response.length > 200 ? maxScore * 0.3 : maxScore * 0.15;
  }

  // 3. Response length heuristic (15% of max)
  const wordCount = result.response.split(/\s+/).length;
  if (wordCount >= 300) {
    score += maxScore * 0.15;
  } else if (wordCount >= 100) {
    score += maxScore * 0.15 * (wordCount / 300);
  }

  // 4. Structure bonus (15% of max) — headers, lists, code blocks
  const hasStructure =
    /^#{1,4}\s/m.test(result.response) ||
    /^[-*]\s/m.test(result.response) ||
    /^```/m.test(result.response) ||
    /^\d+\.\s/m.test(result.response);
  if (hasStructure) {
    score += maxScore * 0.15;
  }

  return Math.round(score * 10) / 10;
}

// ---------------------------------------------------------------------------
// Summary generation
// ---------------------------------------------------------------------------

function generateSummary(
  tasks: TaskDefinition[],
  results: TaskResultWithMeta[],
  startedAt: Date,
): RunSummary {
  const completedAt = new Date();
  const completed = results.filter((r) => r.success);
  const failed = results.filter(
    (r) => !r.success && !r.error?.includes("Timeout"),
  );
  const timedOut = results.filter((r) => r.error?.includes("Timeout"));

  const buildCategoryScore = (type: string): CategoryScore | undefined => {
    const categoryResults = results.filter((r) => r.type === type);
    if (categoryResults.length === 0) return undefined;

    const taskDefs = new Map(tasks.map((t) => [t.id, t]));
    const taskScores = categoryResults.map((r) => {
      const def = taskDefs.get(r.id);
      const score = def ? scoreResult(def, r) : 0;
      return {
        id: r.id,
        success: r.success,
        duration_ms: r.duration_ms,
        score,
        error: r.error,
      };
    });

    const scores = taskScores.map((t) => t.score);
    const successCount = taskScores.filter((t) => t.success).length;

    return {
      avg:
        scores.length > 0
          ? Math.round(
              (scores.reduce((a, b) => a + b, 0) / scores.length) * 10,
            ) / 10
          : 0,
      min: scores.length > 0 ? Math.min(...scores) : 0,
      max: scores.length > 0 ? Math.max(...scores) : 0,
      total: categoryResults.length,
      completed: successCount,
      failed: categoryResults.length - successCount,
      tasks: taskScores,
    };
  };

  const researchScores = buildCategoryScore("research");
  const codingScores = buildCategoryScore("coding");

  const allScores = [
    ...(researchScores?.tasks.map((t) => t.score) ?? []),
    ...(codingScores?.tasks.map((t) => t.score) ?? []),
  ];
  const overallScore =
    allScores.length > 0
      ? Math.round(
          (allScores.reduce((a, b) => a + b, 0) / allScores.length) * 10,
        ) / 10
      : 0;

  const durations = results.map((r) => r.duration_ms).filter((d) => d > 0);
  const avgDuration =
    durations.length > 0
      ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
      : 0;

  return {
    run_id: startedAt.toISOString(),
    started_at: startedAt.toISOString(),
    completed_at: completedAt.toISOString(),
    total_tasks: results.length,
    completed: completed.length,
    failed: failed.length,
    timed_out: timedOut.length,
    scores: {
      ...(researchScores ? { research: researchScores } : {}),
      ...(codingScores ? { coding: codingScores } : {}),
    },
    overall_score: overallScore,
    avg_duration_ms: avgDuration,
  };
}

// ---------------------------------------------------------------------------
// Console report
// ---------------------------------------------------------------------------

function printReport(summary: RunSummary): void {
  console.log("\n" + "=".repeat(60));
  console.log("  APP BENCHMARK RESULTS");
  console.log("=".repeat(60));
  console.log(`  Run ID:     ${summary.run_id}`);
  console.log(
    `  Duration:   ${((new Date(summary.completed_at).getTime() - new Date(summary.started_at).getTime()) / 1000).toFixed(1)}s`,
  );
  console.log(
    `  Tasks:      ${summary.total_tasks} total, ${summary.completed} passed, ${summary.failed} failed, ${summary.timed_out} timed out`,
  );
  console.log(
    `  Avg time:   ${(summary.avg_duration_ms / 1000).toFixed(1)}s per task`,
  );
  console.log("-".repeat(60));

  for (const [category, scores] of Object.entries(summary.scores)) {
    if (!scores) continue;
    console.log(`\n  ${category.toUpperCase()}`);
    console.log(
      `  Score: avg=${scores.avg} min=${scores.min} max=${scores.max}`,
    );
    console.log(`  Tasks: ${scores.completed}/${scores.total} passed`);

    for (const task of scores.tasks) {
      const status = task.success ? "PASS" : "FAIL";
      const dur =
        task.duration_ms > 0
          ? `${(task.duration_ms / 1000).toFixed(1)}s`
          : "N/A";
      const err = task.error ? ` (${task.error.slice(0, 60)})` : "";
      console.log(
        `    [${status}] ${task.id.padEnd(16)} score=${task.score.toFixed(1).padStart(4)}  ${dur.padStart(6)}${err}`,
      );
    }
  }

  console.log("\n" + "-".repeat(60));
  console.log(`  OVERALL SCORE: ${summary.overall_score}`);
  console.log("=".repeat(60) + "\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  REPO_ROOT = resolveRepoRoot(args.root);
  const tasks = loadTasks(args);

  if (tasks.length === 0) {
    console.error(
      "[orchestrator] No tasks found. Check app-eval/tasks/ directory.",
    );
    process.exit(1);
  }

  console.log(`[orchestrator] Loaded ${tasks.length} task(s)`);

  if (args.dryRun) {
    console.log("\n  DRY RUN — tasks that would be executed:\n");
    for (const task of tasks) {
      console.log(
        `  ${task.id.padEnd(16)} type=${task.type.padEnd(10)} difficulty=${(task.difficulty ?? "?").padEnd(8)} prompt="${task.prompt.slice(0, 80)}..."`,
      );
    }
    console.log(`\n  Total: ${tasks.length} tasks`);
    process.exit(0);
  }

  const startedAt = new Date();
  const runDir = createResultsDir();
  console.log(`[orchestrator] Results directory: ${runDir}`);

  let allResults: BenchmarkResult[];

  if (args.server) {
    console.log("[orchestrator] Using server mode (single runtime boot)");
    allResults = await runTasksServerMode(tasks, args.timeout, args.verbose);
  } else {
    console.log(
      "[orchestrator] Using single-task mode (separate process per task)",
    );
    allResults = [];
    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i];
      console.log(
        `[orchestrator] Running ${task.id} (${i + 1}/${tasks.length})...`,
      );
      const result = await runSingleTask(task, args.timeout);
      allResults.push(result);

      const status = result.success ? "PASS" : "FAIL";
      console.log(
        `  [${status}] ${result.id} (${result.duration_ms}ms)${result.error ? ` — ${result.error.slice(0, 80)}` : ""}`,
      );

      // Persist individual result immediately
      const resultPath = join(runDir, `${task.id}.json`);
      writeFileSync(resultPath, JSON.stringify(result, null, 2));
    }
  }

  // Enrich results with task metadata
  const taskMap = new Map(tasks.map((t) => [t.id, t]));
  const enrichedResults: TaskResultWithMeta[] = allResults.map((r) => {
    const def = taskMap.get(r.id);
    return {
      ...r,
      type: def?.type ?? "unknown",
      difficulty: def?.difficulty,
      prompt: def?.prompt ?? "",
    };
  });

  // If server mode, write individual results now
  if (args.server) {
    for (const result of allResults) {
      const resultPath = join(runDir, `${result.id}.json`);
      writeFileSync(resultPath, JSON.stringify(result, null, 2));
    }
  }

  // Generate and write summary
  const summary = generateSummary(tasks, enrichedResults, startedAt);
  const summaryPath = join(runDir, "summary.json");
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2));

  // Print report to console
  printReport(summary);

  console.log(`[orchestrator] Results written to ${runDir}`);
  console.log(
    `[orchestrator] Run evaluator: python3 app-eval/evaluate.py ${runDir}`,
  );

  // Exit non-zero when tasks failed or timed out
  process.exit(summary.failed > 0 || summary.timed_out > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("[orchestrator] Fatal error:", err);
  process.exit(2);
});
