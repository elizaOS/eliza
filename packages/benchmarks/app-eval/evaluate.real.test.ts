import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const appEvalDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(appEvalDir, "../../..");
const evaluateScript = join(appEvalDir, "evaluate.py");

type BenchmarkTask = { id: string; expected_keywords?: string[] };

function loadTasks(
  filename: string,
  fallback: BenchmarkTask[],
): BenchmarkTask[] {
  try {
    return JSON.parse(
      readFileSync(join(appEvalDir, "tasks", filename), "utf8"),
    ) as BenchmarkTask[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

const researchTasks = loadTasks("research-tasks.json", [
  {
    id: "research-task",
    expected_keywords: ["summary", "findings", "analysis"],
  },
]);
const codingTasks = loadTasks("coding-tasks.json", [
  {
    id: "coding-task",
    expected_keywords: ["runBenchmark", "implementation", "typescript"],
  },
]);

describe("app-eval/evaluate.py", () => {
  let tempDir: string | null = null;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it("builds a combined research and coding report from result JSON files", () => {
    tempDir = mkdtempSync(join(tmpdir(), "app-eval-benchmarks-"));
    const outputPath = join(tempDir, "report.json");
    const researchTask = researchTasks[0];
    const codingTask = codingTasks[0];
    const researchKeywords = (researchTask.expected_keywords ?? [])
      .slice(0, 3)
      .join(" ");
    const codingKeywords = (codingTask.expected_keywords ?? [])
      .slice(0, 3)
      .join(" ");

    writeFileSync(
      join(tempDir, `${researchTask.id}.json`),
      JSON.stringify({
        id: researchTask.id,
        response: `## Findings\n${researchKeywords}\nTherefore this is a useful summary.`,
        actions_taken: ["research"],
        duration_ms: 250,
        success: true,
      }),
    );
    writeFileSync(
      join(tempDir, `${codingTask.id}.json`),
      JSON.stringify({
        id: codingTask.id,
        response: [
          "Here is the implementation.",
          "```typescript",
          `export function runBenchmark(): string { return "${codingKeywords}"; }`,
          "```",
          codingKeywords,
        ].join("\n"),
        actions_taken: ["coding"],
        duration_ms: 400,
        success: true,
      }),
    );

    execFileSync(
      "python3",
      [evaluateScript, tempDir, "--output", outputPath, "--format", "json"],
      {
        cwd: repoRoot,
        stdio: "pipe",
      },
    );

    const report = JSON.parse(readFileSync(outputPath, "utf8")) as {
      total_tasks: number;
      completed: number;
      overall_score: number;
      scores: {
        research?: { tasks: Array<{ id: string; score: number }> };
        coding?: { tasks: Array<{ id: string; score: number }> };
      };
    };

    expect(report.total_tasks).toBe(2);
    expect(report.completed).toBe(2);
    expect(report.overall_score).toBeGreaterThan(0);
    expect(report.scores.research?.tasks[0]).toMatchObject({
      id: researchTask.id,
    });
    expect(report.scores.coding?.tasks[0]).toMatchObject({
      id: codingTask.id,
    });
    expect(
      JSON.parse(readFileSync(join(tempDir, "evaluation.json"), "utf8")),
    ).toMatchObject({
      total_tasks: 2,
    });
  });
});
