/**
 * Batch trajectory-quality review (#8795) — core logic.
 *
 * Samples recorded LifeOps trajectories per capability, scores each sample
 * against a per-capability rubric with an LLM judge (deterministic JSON
 * `{score, reason}`, fail-closed parse — a score is never fabricated), and
 * aggregates a per-capability scoreboard (mean/min/max + worst samples with
 * reasons and source file paths for hand review).
 *
 * The CLI wrapper lives in `scripts/trajectory-quality-review.ts`
 * (`bun run trajectories:review`). Everything here is pure/deterministic
 * given a judge function, so it is unit-testable without a model.
 */

import type { Trajectory } from "@elizaos/agent";
import {
  type ElizaNativeTrainingExample,
  extractTrajectoryExamplesByTask,
  LIFEOPS_TRAINING_TASKS,
  type LifeOpsTrainingTask,
} from "./trajectory-task-datasets.js";

/**
 * Per-capability judge rubrics. Each is phrased so the judge grades the
 * recorded model OUTPUT against the recorded INPUT — not the scenario as a
 * whole — because a sample is one model boundary call.
 */
export const LIFEOPS_QUALITY_RUBRICS: Record<LifeOpsTrainingTask, string> = {
  calendar_extract:
    "The output extracts the calendar event(s) actually described in the input: correct title, date/time, duration, attendees and location where stated. Nothing is fabricated; missing fields are left empty rather than guessed.",
  schedule_plan:
    "The output proposes a concrete, feasible scheduling plan or negotiation step that respects every constraint stated in the input (availability, priorities, working hours). It is unambiguous about times and next steps.",
  reminder_dispatch:
    "The output is the right reminder for the input's reminder record: it references the correct item and time, is phrased actionably for the owner, and does not invent details beyond the record.",
  inbox_triage:
    "The output triages the inbox item correctly: sensible category/priority for the content, justification grounded in the item itself, and a reasonable proposed next action.",
  meeting_prep:
    "The output is a useful pre-brief for the meeting in the input: correct meeting, relevant attendees/context, concise agenda-oriented preparation points, no fabricated facts.",
  morning_brief:
    "The output is a useful morning briefing for the data in the input: it covers the day's schedule and outstanding items, prioritizes what matters, stays concise, and invents nothing.",
  health_checkin:
    "The output is an appropriate health/sleep check-in for the input data: grounded in the numbers provided, empathetic but direct, with at most small actionable suggestions and no medical overreach.",
  screentime_recap:
    "The output accurately recaps the screen-time data in the input and proposes a proportionate focus adjustment. Numbers match the input; recommendations follow from them.",
  creative_draft:
    "The output drafts in the owner's voice from the supplied memos and style card: it preserves each memo's argument and affect, sounds like the owner rather than a consultant, respects any standing draft's accepted/vetoed edits, and invents no claims the memos do not support.",
};

/** One sampled model-boundary call queued for judging. */
export interface TrajectoryQualitySample {
  task: LifeOpsTrainingTask;
  trajectoryId: string;
  callId: string;
  /** Recorded trajectory file the sample came from (for hand review). */
  sourcePath?: string;
  system?: string;
  input: string;
  output: string;
}

export interface JudgedSample extends TrajectoryQualitySample {
  score: number;
  reason: string;
}

/** A judge output that could not be parsed — recorded, never scored. */
export interface FailedJudgment {
  sample: TrajectoryQualitySample;
  error: string;
}

export interface CapabilityScoreboard {
  task: LifeOpsTrainingTask;
  sampleCount: number;
  mean: number;
  min: number;
  max: number;
  /** Lowest-scoring samples (worst first) with reasons + source paths. */
  worst: Array<{
    trajectoryId: string;
    callId: string;
    sourcePath?: string;
    score: number;
    reason: string;
  }>;
}

export interface TrajectoryQualityReview {
  generatedAt: string;
  /** Human description of the judge backend (provider/model). */
  judgeModel: string;
  samplesPerTask: number;
  capabilities: CapabilityScoreboard[];
  totals: {
    sampled: number;
    judged: number;
    failedJudgments: number;
  };
  failedJudgments: Array<{
    task: LifeOpsTrainingTask;
    trajectoryId: string;
    callId: string;
    error: string;
  }>;
}

function textFromRow(row: ElizaNativeTrainingExample): {
  system?: string;
  input: string;
  output: string;
} | null {
  let system: string | undefined;
  let input = "";
  const messages = Array.isArray(row.request.messages)
    ? row.request.messages
    : [];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const { role, content } = message as { role?: unknown; content?: unknown };
    if (typeof content !== "string") continue;
    if (role === "system" && !system) system = content;
    if (role === "user") input = input ? `${input}\n${content}` : content;
  }
  if (!input && typeof row.request.prompt === "string") {
    input = row.request.prompt;
  }
  if (!system && typeof row.request.system === "string") {
    system = row.request.system;
  }
  const output =
    typeof row.response.text === "string" && row.response.text.length > 0
      ? row.response.text
      : Array.isArray(row.response.toolCalls) &&
          row.response.toolCalls.length > 0
        ? JSON.stringify({ toolCalls: row.response.toolCalls })
        : "";
  if (!input || !output) return null;
  return { system, input, output };
}

/**
 * Deterministic per-capability sampling: stable-sort each bucket by
 * (trajectoryId, callId), then pick `samplesPerTask` evenly spaced rows so a
 * time-ordered corpus is sampled across its whole span instead of only the
 * head. Same corpus + same N ⇒ same samples.
 */
export function collectQualitySamples(
  trajectories: Trajectory[],
  options: {
    samplesPerTask: number;
    tasks?: readonly LifeOpsTrainingTask[];
    sourcePathByTrajectoryId?: ReadonlyMap<string, string>;
  },
): Record<LifeOpsTrainingTask, TrajectoryQualitySample[]> {
  const tasks = options.tasks ?? LIFEOPS_TRAINING_TASKS;
  const buckets = extractTrajectoryExamplesByTask(trajectories, tasks);
  const out = {} as Record<LifeOpsTrainingTask, TrajectoryQualitySample[]>;
  for (const task of tasks) {
    const rows = [...buckets[task]].sort((a, b) => {
      const byTrajectory = String(a.trajectoryId).localeCompare(
        String(b.trajectoryId),
      );
      return byTrajectory !== 0
        ? byTrajectory
        : String(a.callId).localeCompare(String(b.callId));
    });
    const picked = pickEvenlySpaced(rows, options.samplesPerTask);
    const samples: TrajectoryQualitySample[] = [];
    for (const row of picked) {
      const text = textFromRow(row);
      if (!text) continue;
      samples.push({
        task,
        trajectoryId: String(row.trajectoryId),
        callId: String(row.callId),
        sourcePath: options.sourcePathByTrajectoryId?.get(
          String(row.trajectoryId),
        ),
        ...text,
      });
    }
    out[task] = samples;
  }
  return out;
}

function pickEvenlySpaced<T>(rows: T[], n: number): T[] {
  if (n <= 0 || rows.length === 0) return [];
  if (rows.length <= n) return rows;
  const picked: T[] = [];
  const seen = new Set<number>();
  for (let i = 0; i < n; i += 1) {
    const index = n === 1 ? 0 : Math.round((i * (rows.length - 1)) / (n - 1));
    if (seen.has(index)) continue;
    seen.add(index);
    const row = rows[index];
    if (row !== undefined) picked.push(row);
  }
  return picked;
}

/** Deterministic judge prompt: rubric + recorded input/output, JSON-only. */
export function buildJudgePrompt(sample: TrajectoryQualitySample): string {
  const rubric =
    LIFEOPS_QUALITY_RUBRICS[
      sample.task as (typeof LIFEOPS_TRAINING_TASKS)[number]
    ];
  return [
    `You are grading one recorded model call from the "${sample.task}" LifeOps capability.`,
    "",
    "Rubric:",
    rubric,
    "",
    ...(sample.system ? ["Recorded system prompt:", sample.system, ""] : []),
    "Recorded input:",
    sample.input,
    "",
    "Recorded output (the thing you are grading):",
    sample.output,
    "",
    'Respond with EXACTLY one JSON object and nothing else: {"score": <number 0..1>, "reason": "<one concise sentence>"}',
  ].join("\n");
}

/**
 * Fail-closed judge-output parse. Accepts an optional ```json fence, requires
 * a JSON object with a finite numeric `score` in [0, 1] and a non-empty
 * string `reason`. Anything else throws — a quality score is never guessed
 * from unparseable output.
 */
export function parseJudgeJson(raw: string): { score: number; reason: string } {
  const trimmed = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error(`judge output is not a JSON object: ${preview(raw)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed.slice(start, end + 1));
  } catch (err) {
    throw new Error(
      `judge output failed JSON.parse (${err instanceof Error ? err.message : String(err)}): ${preview(raw)}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`judge output is not a JSON object: ${preview(raw)}`);
  }
  const { score, reason } = parsed as { score?: unknown; reason?: unknown };
  if (typeof score !== "number" || !Number.isFinite(score)) {
    throw new Error(`judge output has no numeric score: ${preview(raw)}`);
  }
  if (score < 0 || score > 1) {
    throw new Error(`judge score ${score} outside [0, 1]: ${preview(raw)}`);
  }
  if (typeof reason !== "string" || reason.trim().length === 0) {
    throw new Error(`judge output has no reason string: ${preview(raw)}`);
  }
  return { score, reason: reason.trim() };
}

function preview(raw: string): string {
  const compact = raw.replace(/\s+/g, " ").trim();
  return compact.length <= 160 ? compact : `${compact.slice(0, 160)}…`;
}

export type JudgeFn = (prompt: string) => Promise<string>;

/**
 * Judge every sample. Parse failures are recorded (never scored) so the
 * scoreboard only contains real judge scores; callers surface
 * `failedJudgments` and exit non-zero.
 */
export async function judgeSamples(
  samplesByTask: Record<LifeOpsTrainingTask, TrajectoryQualitySample[]>,
  judge: JudgeFn,
): Promise<{ judged: JudgedSample[]; failed: FailedJudgment[] }> {
  const judged: JudgedSample[] = [];
  const failed: FailedJudgment[] = [];
  for (const samples of Object.values(samplesByTask)) {
    for (const sample of samples) {
      const raw = await judge(buildJudgePrompt(sample));
      try {
        const { score, reason } = parseJudgeJson(raw);
        judged.push({ ...sample, score, reason });
      } catch (err) {
        failed.push({
          sample,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  return { judged, failed };
}

export function aggregateScoreboards(
  judged: JudgedSample[],
  options: { worstCount?: number } = {},
): CapabilityScoreboard[] {
  const worstCount = options.worstCount ?? 3;
  const byTask = new Map<LifeOpsTrainingTask, JudgedSample[]>();
  for (const sample of judged) {
    const bucket = byTask.get(sample.task) ?? [];
    bucket.push(sample);
    byTask.set(sample.task, bucket);
  }
  const boards: CapabilityScoreboard[] = [];
  for (const [task, samples] of [...byTask.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const scores = samples.map((s) => s.score);
    const worst = [...samples]
      .sort(
        (a, b) =>
          a.score - b.score || a.trajectoryId.localeCompare(b.trajectoryId),
      )
      .slice(0, worstCount)
      .map((s) => ({
        trajectoryId: s.trajectoryId,
        callId: s.callId,
        ...(s.sourcePath ? { sourcePath: s.sourcePath } : {}),
        score: s.score,
        reason: s.reason,
      }));
    boards.push({
      task,
      sampleCount: samples.length,
      mean: scores.reduce((sum, s) => sum + s, 0) / scores.length,
      min: Math.min(...scores),
      max: Math.max(...scores),
      worst,
    });
  }
  return boards;
}

export function buildReview(input: {
  judgeModel: string;
  samplesPerTask: number;
  sampled: number;
  judged: JudgedSample[];
  failed: FailedJudgment[];
  worstCount?: number;
  now?: () => Date;
}): TrajectoryQualityReview {
  return {
    generatedAt: (input.now ?? (() => new Date()))().toISOString(),
    judgeModel: input.judgeModel,
    samplesPerTask: input.samplesPerTask,
    capabilities: aggregateScoreboards(input.judged, {
      worstCount: input.worstCount,
    }),
    totals: {
      sampled: input.sampled,
      judged: input.judged.length,
      failedJudgments: input.failed.length,
    },
    failedJudgments: input.failed.map(({ sample, error }) => ({
      task: sample.task,
      trajectoryId: sample.trajectoryId,
      callId: sample.callId,
      error,
    })),
  };
}

export function renderReviewMarkdown(review: TrajectoryQualityReview): string {
  const lines: string[] = [
    "# LifeOps trajectory quality review",
    "",
    `- Generated: ${review.generatedAt}`,
    `- Judge: ${review.judgeModel}`,
    `- Samples per capability: ${review.samplesPerTask}`,
    `- Sampled: ${review.totals.sampled} · judged: ${review.totals.judged} · failed judgments: ${review.totals.failedJudgments}`,
    "",
    "| Capability | Samples | Mean | Min | Max |",
    "| --- | ---: | ---: | ---: | ---: |",
  ];
  for (const board of review.capabilities) {
    lines.push(
      `| ${board.task} | ${board.sampleCount} | ${board.mean.toFixed(2)} | ${board.min.toFixed(2)} | ${board.max.toFixed(2)} |`,
    );
  }
  for (const board of review.capabilities) {
    if (board.worst.length === 0) continue;
    lines.push("", `## ${board.task} — worst samples`, "");
    for (const entry of board.worst) {
      lines.push(
        `- **${entry.score.toFixed(2)}** \`${entry.trajectoryId}\` / \`${entry.callId}\`${
          entry.sourcePath ? ` (\`${entry.sourcePath}\`)` : ""
        }: ${entry.reason}`,
      );
    }
  }
  if (review.failedJudgments.length > 0) {
    lines.push("", "## Failed judgments (unscored — fail-closed)", "");
    for (const failure of review.failedJudgments) {
      lines.push(
        `- ${failure.task} \`${failure.trajectoryId}\` / \`${failure.callId}\`: ${failure.error}`,
      );
    }
  }
  lines.push("");
  return lines.join("\n");
}
