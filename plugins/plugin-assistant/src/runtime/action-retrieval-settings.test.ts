/** Verifies retrieval ordering is determined by explicit input, independent of process model presets. */
import { afterEach, expect, it } from "vitest";
import { buildActionCatalog } from "./action-catalog";
import { retrieveActions } from "./action-retrieval";

const originalTier = process.env.MODEL_TIER;
afterEach(() => {
  if (originalTier === undefined) delete process.env.MODEL_TIER;
  else process.env.MODEL_TIER = originalTier;
});

it("keeps all retrieval scores stable across retired model-tier presets", () => {
  const catalog = buildActionCatalog([
    {
      name: "CALENDAR",
      description: "Schedule a meeting",
      contexts: ["calendar"],
    },
    { name: "EMAIL", description: "Send email messages" },
    { name: "MUSIC", description: "Play music" },
  ]);
  const input = {
    catalog,
    messageText: "schedule a meeting",
    parentActionHints: ["EMAIL"],
    selectedContexts: ["calendar"],
    measurementMode: true,
  };
  delete process.env.MODEL_TIER;
  const baseline = retrieveActions(input);
  expect(baseline.results).toHaveLength(3);
  for (const tier of ["small", "mid", "large", "frontier"]) {
    process.env.MODEL_TIER = tier;
    expect(retrieveActions(input)).toEqual(baseline);
  }
});
