import type { LifeOpsGoalDefinition } from "@elizaos/contracts";
import { describe, expect, it } from "vitest";
import { scoreGoalSimilarity } from "./index.ts";

function candidateGoal(title: string, description = ""): LifeOpsGoalDefinition {
  return {
    title,
    description,
    successCriteria: {},
  } as LifeOpsGoalDefinition;
}

function score(a: string, b: string, aDesc = "", bDesc = ""): number {
  return scoreGoalSimilarity({
    reference: { title: a, description: aDesc, successCriteria: {} },
    candidate: candidateGoal(b, bDesc),
  });
}

describe("scoreGoalSimilarity — non-Latin goal text", () => {
  it("scores an identical Korean goal as a duplicate", () => {
    expect(
      score("매일 아침 30분 달리기하기", "매일 아침 30분 달리기하기"),
    ).toBeGreaterThanOrEqual(0.85);
  });

  it("keeps an unrelated Korean goal below the match floor", () => {
    expect(
      score("매일 아침 30분 달리기하기", "주말마다 책 한 권 읽기"),
    ).toBeLessThan(0.34);
  });

  it("scores an identical Japanese goal as a duplicate", () => {
    expect(
      score("毎朝ジョギングする", "毎朝ジョギングする"),
    ).toBeGreaterThanOrEqual(0.85);
  });

  it("matches a Korean goal with two-character words", () => {
    expect(
      score("매일 운동", "매일 운동", "건강 유지", "건강 유지"),
    ).toBeGreaterThanOrEqual(0.85);
  });
});

describe("scoreGoalSimilarity — English goal text", () => {
  it.each([
    ["Meditate every morning", "Meditate every morning", "", "", 1],
    [
      "Meditate every morning",
      "Meditate every morning",
      "build a daily meditation habit",
      "daily meditation habit",
      (6 / 7) * 0.75 + 0.35,
    ],
    ["Meditate every morning", "Learn watercolor painting", "", "", 0],
    [
      "Run a marathon this year",
      "Run 5k this year",
      "",
      "",
      (2 / 3) * 0.75 + (2 / 3) * 0.35,
    ],
    ["Go to the gym", "Go to the gym", "", "", 1],
  ])("%s vs %s", (a, b, aDesc, bDesc, expected) => {
    expect(score(a, b, aDesc, bDesc)).toBeCloseTo(expected, 6);
  });
});
