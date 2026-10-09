/** Shared authoring defaults; each case retains its full prompts and rubric. */
import { type ScenarioDefinition, scenario } from "@elizaos/testing";
export function personalityScenario(
  definition: ScenarioDefinition,
): ScenarioDefinition {
  return scenario({
    isolation: "per-scenario",
    scope: "user",
    rooms: [
      {
        id: "main",
        source: "dashboard",
        channelType: "DM",
        title: "Personality Benchmark",
      },
    ],
    ...definition,
  });
}
