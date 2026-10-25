/**
 * Regression coverage for the experience record processor. The suite drives
 * the real `recordExperiences` processor with an in-memory EXPERIENCE service
 * boundary and verifies that non-Latin learnings are recorded, not skipped
 * as duplicates of an empty normalized key.
 */

import type { IAgentRuntime, UUID } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { experiencePatternEvaluator } from "./experience-items.ts";

const KOREAN_LEARNING_1 = "사용자는 회의 전에 녹차를 마시는 습관이 있다";
const KOREAN_LEARNING_2 = "배포 전에 백업을 먼저 확인해야 한다";
const ENGLISH_LEARNING =
  "The user drinks green tea before the morning meeting every day";

function makeExperience(learning: string) {
  return {
    type: "learning",
    outcome: "positive",
    domain: "habits",
    learning,
    context: "context",
    confidence: 0.9,
    importance: 0.5,
    reasoning: "test",
  };
}

async function runProcessor(learnings: string[]) {
  const recorded: string[] = [];
  const runtime = {
    agentId: "00000000-0000-0000-0000-000000000001" as UUID,
    getSetting: () => undefined,
    redactSecrets: (text: string) => text,
  } as unknown as IAgentRuntime;
  const prepared = {
    experienceService: {
      recordExperience: async (exp: { learning: string }) => {
        recorded.push(exp.learning);
      },
    },
    existingExperiences: [],
    provenance: {
      sourceMessageIds: [],
      associatedEntityIds: [],
    },
  };
  const processor = experiencePatternEvaluator.processors?.[0];
  if (!processor) throw new Error("recordExperiences processor missing");
  const result = await processor.process({
    runtime,
    prepared,
    output: { experiences: learnings.map(makeExperience) },
    options: {},
  } as never);
  return { recorded, result };
}

describe("experience record processor non-Latin learnings", () => {
  it("records a Korean learning instead of skipping it as a duplicate", async () => {
    const { recorded, result } = await runProcessor([KOREAN_LEARNING_1]);
    expect(recorded).toEqual([KOREAN_LEARNING_1]);
    expect(result?.data).toMatchObject({ recordedCount: 1 });
  });

  it("records two different Korean learnings as two records", async () => {
    const { recorded } = await runProcessor([
      KOREAN_LEARNING_1,
      KOREAN_LEARNING_2,
    ]);
    expect(recorded).toEqual([KOREAN_LEARNING_1, KOREAN_LEARNING_2]);
  });

  it("still skips a true duplicate of the same Korean learning", async () => {
    const { recorded, result } = await runProcessor([
      KOREAN_LEARNING_1,
      KOREAN_LEARNING_1,
    ]);
    expect(recorded).toEqual([KOREAN_LEARNING_1]);
    expect(result?.data).toMatchObject({
      recordedCount: 1,
      skippedDuplicateCount: 1,
    });
  });

  it("keeps the English recording behavior unchanged", async () => {
    const { recorded } = await runProcessor([ENGLISH_LEARNING]);
    expect(recorded).toEqual([ENGLISH_LEARNING]);
  });
});
