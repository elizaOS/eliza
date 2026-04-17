import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  scoreSkill,
  type ScoreableTrajectory,
} from "../src/core/replay-validator.js";
import {
  applyScoreToSkillFile,
  runSkillScoringBatch,
} from "../src/core/skill-scoring-cron.js";

let stateDir: string;
let prevState: string | undefined;
let prevElizaState: string | undefined;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "skill-score-"));
  prevState = process.env.MILADY_STATE_DIR;
  prevElizaState = process.env.ELIZA_STATE_DIR;
  process.env.MILADY_STATE_DIR = stateDir;
  delete process.env.ELIZA_STATE_DIR;
});

afterEach(() => {
  if (prevState === undefined) delete process.env.MILADY_STATE_DIR;
  else process.env.MILADY_STATE_DIR = prevState;
  if (prevElizaState !== undefined)
    process.env.ELIZA_STATE_DIR = prevElizaState;
  rmSync(stateDir, { recursive: true, force: true });
});

function makeTrajectory(
  status: string,
  usedSkills: string[],
): ScoreableTrajectory {
  return {
    trajectoryId: `traj-${Math.random()}`,
    metrics: { finalStatus: status },
    steps: [{ usedSkills }],
    metadata: {},
  };
}

describe("scoreSkill", () => {
  it("returns 0 when no trajectory references the skill", async () => {
    const score = await scoreSkill({ name: "demo" }, [
      makeTrajectory("completed", ["other"]),
    ]);
    expect(score).toBe(0);
  });

  it("returns the success rate across referencing trajectories", async () => {
    const trajectories = [
      makeTrajectory("completed", ["demo"]),
      makeTrajectory("completed", ["demo"]),
      makeTrajectory("failed", ["demo"]),
      makeTrajectory("completed", ["other"]),
    ];
    const score = await scoreSkill({ name: "demo" }, trajectories);
    expect(score).toBeCloseTo(2 / 3, 5);
  });

  it("matches metadata.usedSkills as well as step.usedSkills", async () => {
    const trajectory: ScoreableTrajectory = {
      metrics: { finalStatus: "completed" },
      steps: [{ usedSkills: [] }],
      metadata: { usedSkills: ["demo"] },
    };
    const score = await scoreSkill({ name: "demo" }, [trajectory]);
    expect(score).toBe(1);
  });
});

describe("applyScoreToSkillFile", () => {
  it("rewrites lastEvalScore in an existing provenance block", () => {
    const file = join(stateDir, "SKILL.md");
    writeFileSync(
      file,
      `---\nname: demo\ndescription: demo\nprovenance:\n  source: agent-generated\n  createdAt: 2025-01-01T00:00:00Z\n  refinedCount: 0\n  lastEvalScore: 0.1234\n---\n## body\n`,
    );
    expect(applyScoreToSkillFile(file, 0.875)).toBe(true);
    const text = readFileSync(file, "utf-8");
    expect(text).toMatch(/lastEvalScore: 0\.8750/);
    expect(text).not.toMatch(/0\.1234/);
  });

  it("inserts lastEvalScore when missing", () => {
    const file = join(stateDir, "SKILL.md");
    writeFileSync(
      file,
      `---\nname: demo\ndescription: demo\nprovenance:\n  source: agent-generated\n  createdAt: 2025-01-01T00:00:00Z\n  refinedCount: 0\n---\n## body\n`,
    );
    expect(applyScoreToSkillFile(file, 0.5)).toBe(true);
    const text = readFileSync(file, "utf-8");
    expect(text).toMatch(/lastEvalScore: 0\.5000/);
  });
});

describe("runSkillScoringBatch", () => {
  it("scores every active curated skill", async () => {
    const activeDir = join(stateDir, "skills", "curated", "active");
    mkdirSync(join(activeDir, "skill-success"), { recursive: true });
    writeFileSync(
      join(activeDir, "skill-success", "SKILL.md"),
      `---\nname: skill-success\ndescription: success\nprovenance:\n  source: agent-generated\n  createdAt: 2025-01-01T00:00:00Z\n  refinedCount: 0\n---\nbody\n`,
    );
    mkdirSync(join(activeDir, "skill-fail"), { recursive: true });
    writeFileSync(
      join(activeDir, "skill-fail", "SKILL.md"),
      `---\nname: skill-fail\ndescription: fail\nprovenance:\n  source: agent-generated\n  createdAt: 2025-01-01T00:00:00Z\n  refinedCount: 0\n---\nbody\n`,
    );

    const trajectoryDetails: Record<string, ScoreableTrajectory> = {
      "t-1": {
        trajectoryId: "t-1",
        metrics: { finalStatus: "completed" },
        steps: [{ usedSkills: ["skill-success"] }],
      },
      "t-2": {
        trajectoryId: "t-2",
        metrics: { finalStatus: "completed" },
        steps: [{ usedSkills: ["skill-success"] }],
      },
      "t-3": {
        trajectoryId: "t-3",
        metrics: { finalStatus: "failed" },
        steps: [{ usedSkills: ["skill-fail"] }],
      },
    };

    const runtime = {
      getService: (name: string) => {
        if (name !== "trajectories") return null;
        return {
          listTrajectories: async () => ({
            trajectories: Object.keys(trajectoryDetails).map((id) => ({ id })),
          }),
          getTrajectoryDetail: async (id: string) =>
            trajectoryDetails[id] ?? null,
        };
      },
      logger: { info() {}, warn() {}, error() {} },
    };

    const results = await runSkillScoringBatch(runtime);
    const map = new Map(results.map((r) => [r.name, r.score]));
    expect(map.get("skill-success")).toBe(1);
    expect(map.get("skill-fail")).toBe(0);

    const successText = readFileSync(
      join(activeDir, "skill-success", "SKILL.md"),
      "utf-8",
    );
    expect(successText).toMatch(/lastEvalScore: 1\.0000/);
  });
});
