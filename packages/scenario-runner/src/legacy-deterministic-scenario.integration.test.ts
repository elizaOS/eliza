/** Runs a pre-manifest deterministic scenario through the real runtime migration bridge. */

import { ModelType } from "@elizaos/core";
import type { ScenarioDefinition } from "@elizaos/scenario-runner/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import legacyScenario from "../test/scenarios/deterministic-pr-smoke.scenario.ts";
import { runScenario } from "./executor.ts";
import { beginScenarioModelFixtureAttempt } from "./model-fixtures.ts";
import {
  createScenarioRuntime,
  type RuntimeFactoryResult,
} from "./runtime-factory.ts";

describe("legacy deterministic scenario compatibility", () => {
  let runtimeResult: RuntimeFactoryResult | undefined;

  beforeAll(async () => {
    runtimeResult = await createScenarioRuntime({
      useDeterministicModel: true,
      requiredPlugins: legacyScenario.requires?.plugins,
    });
  }, 120_000);

  afterAll(async () => {
    await runtimeResult?.cleanup();
  });

  it("keeps an undeclared corpus scenario working while reporting legacy mode", async () => {
    if (!runtimeResult) throw new Error("scenario runtime was not created");
    const report = await runScenario(legacyScenario, runtimeResult.runtime, {
      providerName: runtimeResult.providerName,
      minJudgeScore: 0.8,
      turnTimeoutMs: 30_000,
      attemptId: "legacy-compatibility-test",
    });

    expect(report.status).toBe("passed");
    expect(report.modelFixtureMode).toBe("legacy-fallback");
    expect(report.modelFixtureDiagnostics?.scope).toMatchObject({
      scenarioId: legacyScenario.id,
      attemptId: "legacy-compatibility-test",
    });
  }, 120_000);

  it("does not expose the migration fallback to a declared strict attempt", async () => {
    if (!runtimeResult) throw new Error("scenario runtime was not created");
    const scenario = {
      id: "strict-no-fallback",
      title: "Strict no fallback",
      domain: "scenario-runner",
      turns: [],
      modelFixtures: { mode: "fixtures", fixtures: [] },
    } satisfies ScenarioDefinition;
    beginScenarioModelFixtureAttempt(
      runtimeResult.runtime,
      scenario,
      "strict-no-fallback-attempt",
    );

    await expect(
      runtimeResult.runtime.useModel(ModelType.TEXT_LARGE, {
        prompt: [
          "You are the owner's personal assistant. A scheduled task just fired and you must now write the message to send to the owner.",
          "Instruction:",
          "Remind the owner to stretch.",
          "",
          "Message:",
        ].join("\n"),
      }),
    ).rejects.toThrow(/no fixture matched/);
  });
});
