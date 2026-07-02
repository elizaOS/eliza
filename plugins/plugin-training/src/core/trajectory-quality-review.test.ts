/**
 * Batch trajectory-quality review (#8795) — aggregation/report logic.
 *
 * Everything the CLI (`scripts/trajectory-quality-review.ts`) does apart
 * from file IO and the live model call: deterministic sampling per LifeOps
 * capability, fail-closed judge-output parsing, scoreboard aggregation
 * (mean/min/max + worst-with-reasons) and markdown rendering — proven with
 * fixture trajectories and a deterministic judge.
 */

import type { Trajectory } from "@elizaos/agent";
import { describe, expect, it } from "vitest";
import {
  aggregateScoreboards,
  buildJudgePrompt,
  buildReview,
  collectQualitySamples,
  judgeSamples,
  LIFEOPS_QUALITY_RUBRICS,
  parseJudgeJson,
  renderReviewMarkdown,
} from "./trajectory-quality-review.js";
import { LIFEOPS_TRAINING_TASKS } from "./trajectory-task-datasets.js";

const lifeOpsTrajectory = (
  task: string,
  id: string,
  response: string,
): Trajectory => ({
  trajectoryId: id,
  agentId: "agent-1",
  startTime: 1,
  steps: [
    {
      stepId: "step-1",
      timestamp: 1,
      llmCalls: [
        {
          callId: `${id}-call-1`,
          purpose: task,
          systemPrompt: "Extract structured LifeOps output.",
          userPrompt: `handle ${id}`,
          response,
        },
      ],
    },
  ],
});

describe("collectQualitySamples", () => {
  it("samples deterministically per capability with source paths", () => {
    const trajectories = [
      lifeOpsTrajectory("calendar_extract", "tj-b", '{"title":"B"}'),
      lifeOpsTrajectory("calendar_extract", "tj-a", '{"title":"A"}'),
      lifeOpsTrajectory("inbox_triage", "tj-c", '{"priority":"high"}'),
    ];
    const sourcePathByTrajectoryId = new Map([
      ["tj-a", "/runs/tj-a.json"],
      ["tj-b", "/runs/tj-b.json"],
      ["tj-c", "/runs/tj-c.json"],
    ]);
    const samples = collectQualitySamples(trajectories, {
      samplesPerTask: 5,
      sourcePathByTrajectoryId,
    });
    // Stable (trajectoryId, callId) ordering — not corpus order.
    expect(samples.calendar_extract.map((s) => s.trajectoryId)).toEqual([
      "tj-a",
      "tj-b",
    ]);
    expect(samples.inbox_triage).toHaveLength(1);
    expect(samples.inbox_triage[0]).toMatchObject({
      task: "inbox_triage",
      trajectoryId: "tj-c",
      sourcePath: "/runs/tj-c.json",
      input: "handle tj-c",
      output: '{"priority":"high"}',
    });
    // Untouched capabilities stay empty, not undefined.
    expect(samples.morning_brief).toEqual([]);

    const again = collectQualitySamples(trajectories, {
      samplesPerTask: 5,
      sourcePathByTrajectoryId,
    });
    expect(again).toEqual(samples);
  });

  it("caps each capability at samplesPerTask, spanning the sorted corpus", () => {
    const trajectories = Array.from({ length: 10 }, (_, i) =>
      lifeOpsTrajectory(
        "reminder_dispatch",
        `tj-${String(i).padStart(2, "0")}`,
        '{"ok":true}',
      ),
    );
    const samples = collectQualitySamples(trajectories, { samplesPerTask: 3 });
    expect(samples.reminder_dispatch).toHaveLength(3);
    // Evenly spaced across the sorted bucket: first, middle, last.
    expect(samples.reminder_dispatch.map((s) => s.trajectoryId)).toEqual([
      "tj-00",
      "tj-05",
      "tj-09",
    ]);
  });
});

describe("judge prompt + fail-closed parse", () => {
  it("has a rubric for every LifeOps capability and embeds it in the prompt", () => {
    for (const task of LIFEOPS_TRAINING_TASKS) {
      const rubric =
        LIFEOPS_QUALITY_RUBRICS[task as keyof typeof LIFEOPS_QUALITY_RUBRICS];
      expect(rubric, `rubric for ${task}`).toBeTruthy();
      const prompt = buildJudgePrompt({
        task,
        trajectoryId: "tj-1",
        callId: "call-1",
        input: "in",
        output: "out",
      });
      expect(prompt).toContain(rubric);
      expect(prompt).toContain('{"score": <number 0..1>');
    }
  });

  it("parses a plain JSON judge verdict", () => {
    expect(parseJudgeJson('{"score": 0.8, "reason": "solid"}')).toEqual({
      score: 0.8,
      reason: "solid",
    });
  });

  it("tolerates a ```json fence", () => {
    expect(
      parseJudgeJson('```json\n{"score": 0.5, "reason": "meh"}\n```'),
    ).toEqual({ score: 0.5, reason: "meh" });
  });

  it("fails closed on prose, missing score, out-of-range score and empty reason", () => {
    expect(() => parseJudgeJson("looks good to me")).toThrow(
      /not a JSON object/,
    );
    expect(() => parseJudgeJson('{"reason": "no score"}')).toThrow(
      /no numeric score/,
    );
    expect(() => parseJudgeJson('{"score": 1.4, "reason": "x"}')).toThrow(
      /outside \[0, 1\]/,
    );
    expect(() => parseJudgeJson('{"score": 0.4}')).toThrow(/no reason string/);
    expect(() => parseJudgeJson('{"score": "high", "reason": "x"}')).toThrow(
      /no numeric score/,
    );
  });
});

describe("judgeSamples + aggregation", () => {
  const samplesByTask = {
    calendar_extract: [
      {
        task: "calendar_extract" as const,
        trajectoryId: "tj-good",
        callId: "call-1",
        sourcePath: "/runs/tj-good.json",
        input: "in-good",
        output: "out-good",
      },
      {
        task: "calendar_extract" as const,
        trajectoryId: "tj-bad",
        callId: "call-1",
        sourcePath: "/runs/tj-bad.json",
        input: "in-bad",
        output: "out-bad",
      },
    ],
    inbox_triage: [
      {
        task: "inbox_triage" as const,
        trajectoryId: "tj-triage",
        callId: "call-1",
        input: "in-triage",
        output: "out-triage",
      },
    ],
  } as Parameters<typeof judgeSamples>[0];

  const deterministicJudge = async (prompt: string): Promise<string> => {
    if (prompt.includes("out-bad")) {
      return '{"score": 0.2, "reason": "fabricated attendees"}';
    }
    if (prompt.includes("out-triage")) return "cannot judge this";
    return '{"score": 0.9, "reason": "faithful extraction"}';
  };

  it("scores parseable verdicts and records unparseable ones as failures", async () => {
    const { judged, failed } = await judgeSamples(
      samplesByTask,
      deterministicJudge,
    );
    expect(judged).toHaveLength(2);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.sample.trajectoryId).toBe("tj-triage");
    expect(failed[0]?.error).toMatch(/not a JSON object/);
  });

  it("aggregates per-capability mean/min/max and worst-with-reasons", async () => {
    const { judged } = await judgeSamples(samplesByTask, deterministicJudge);
    const boards = aggregateScoreboards(judged, { worstCount: 3 });
    expect(boards).toHaveLength(1);
    const board = boards[0];
    expect(board).toMatchObject({
      task: "calendar_extract",
      sampleCount: 2,
      min: 0.2,
      max: 0.9,
    });
    expect(board?.mean).toBeCloseTo(0.55, 10);
    expect(board?.worst[0]).toEqual({
      trajectoryId: "tj-bad",
      callId: "call-1",
      sourcePath: "/runs/tj-bad.json",
      score: 0.2,
      reason: "fabricated attendees",
    });
  });

  it("builds a serializable review with totals and renders markdown", async () => {
    const { judged, failed } = await judgeSamples(
      samplesByTask,
      deterministicJudge,
    );
    const review = buildReview({
      judgeModel: "unit-test judge",
      samplesPerTask: 5,
      sampled: 3,
      judged,
      failed,
      now: () => new Date(0),
    });
    expect(review.totals).toEqual({
      sampled: 3,
      judged: 2,
      failedJudgments: 1,
    });
    expect(review.generatedAt).toBe("1970-01-01T00:00:00.000Z");
    // JSON round-trip keeps the numbers numeric.
    const parsed = JSON.parse(JSON.stringify(review));
    expect(parsed.capabilities[0].mean).toBeCloseTo(0.55, 10);

    const markdown = renderReviewMarkdown(review);
    expect(markdown).toContain("| calendar_extract | 2 | 0.55 | 0.20 | 0.90 |");
    expect(markdown).toContain("## calendar_extract — worst samples");
    expect(markdown).toContain("fabricated attendees");
    expect(markdown).toContain("/runs/tj-bad.json");
    expect(markdown).toContain("## Failed judgments (unscored — fail-closed)");
    expect(markdown).toContain("tj-triage");
  });
});
