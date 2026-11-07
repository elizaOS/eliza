/**
 * Duplicate maintenance over a real runtime with SQLite storage: a correction
 * that negates an earlier learning must stay a live, separate experience.
 */

import { ModelType } from "@elizaos/core";
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { ExperienceService } from "./service.ts";
import { ExperienceType, OutcomeType } from "./types.ts";

const DIMENSIONS = 8;
const services: ExperienceService[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.stop()));
});

async function startService(): Promise<ExperienceService> {
  const runtime = createSQLiteTestRuntime({
    character: { name: "Eliza", bio: ["test"], settings: {} },
    logLevel: "fatal",
  });
  await runtime.adapter.initialize();
  await runtime.adapter.ensureEmbeddingDimension(DIMENSIONS);
  runtime.registerModel(
    ModelType.TEXT_EMBEDDING,
    async () => Array.from({ length: DIMENSIONS }, (_, i) => (i + 1) / 10),
    "test-embedding",
    100,
  );
  const service = await ExperienceService.start(runtime);
  services.push(service);
  return service;
}

describe("ExperienceService duplicate maintenance", () => {
  it("keeps a correction that negates an earlier learning", async () => {
    const service = await startService();
    const learning = await service.recordExperience({
      type: ExperienceType.LEARNING,
      outcome: OutcomeType.POSITIVE,
      domain: "shell",
      action: "start_api",
      context: "Starting the API server in this repo",
      result: "Server started",
      learning: "Run the database migrations before starting the API server",
      confidence: 0.9,
      importance: 0.9,
    });
    const correction = await service.recordExperience({
      type: ExperienceType.CORRECTION,
      outcome: OutcomeType.NEGATIVE,
      domain: "shell",
      action: "start_api",
      context: "Starting the API server after the schema change",
      result: "Migrations wiped the staging data",
      learning:
        "Do not run the database migrations before starting the API server",
      confidence: 0.8,
      importance: 0.8,
    });

    const result = await service.dedupeDuplicateExperiences({
      deleteDuplicates: false,
    });

    expect(result.groups).toEqual([]);
    const correctionAfter = await service.getExperience(correction.id);
    expect(correctionAfter?.supersedes).toBeUndefined();
    expect(correctionAfter?.confidence).toBe(0.8);
    const learningAfter = await service.getExperience(learning.id);
    expect(learningAfter?.supersedes).toBeUndefined();
    expect(learningAfter?.confidence).toBe(0.9);
  });

  it("still merges a reworded copy of the same learning", async () => {
    const service = await startService();
    await service.recordExperience({
      type: ExperienceType.LEARNING,
      outcome: OutcomeType.POSITIVE,
      domain: "shell",
      action: "start_api",
      context: "Starting the API server in this repo",
      result: "Server started",
      learning: "Run the database migrations before starting the API server",
      confidence: 0.9,
      importance: 0.9,
    });
    await service.recordExperience({
      type: ExperienceType.LEARNING,
      outcome: OutcomeType.POSITIVE,
      domain: "shell",
      action: "start_api",
      context: "Starting the API server on a fresh checkout",
      result: "Server started",
      learning:
        "Always run the database migrations before starting the API server.",
      confidence: 0.7,
      importance: 0.7,
    });

    const result = await service.dedupeDuplicateExperiences({
      deleteDuplicates: false,
    });

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]?.reason).toBe("duplicate learning text");
  });
});
