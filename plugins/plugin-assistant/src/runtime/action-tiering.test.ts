/**
 * The planner's action surface keeps retrieval's order for parents whose
 * relevance saturates at 1. Drives the real catalog, retrieval and tiering
 * with no doubles.
 */
import { describe, expect, it } from "vitest";
import { buildActionCatalog } from "./action-catalog";
import { retrieveActions } from "./action-retrieval";
import { tierActionResults } from "./action-tiering";

describe("tierActionResults", () => {
  it("orders a saturated tie by retrieval rank, not by name", () => {
    const catalog = buildActionCatalog([
      { name: "ARCHIVE", description: "Archive old files and folders" },
      { name: "WEATHER", description: "Get the weather forecast for a city" },
    ]);
    const retrieval = retrieveActions({
      catalog,
      messageText: "What is the weather forecast for Paris tomorrow?",
      parentActionHints: ["ARCHIVE", "WEATHER"],
    });
    // Both hinted parents saturate; message evidence ranks WEATHER first,
    // against the alphabetical fallback.
    expect(
      retrieval.results.map(({ name, score, rank }) => ({ name, score, rank })),
    ).toEqual([
      { name: "WEATHER", score: 1, rank: 1 },
      { name: "ARCHIVE", score: 1, rank: 2 },
    ]);

    const surface = tierActionResults({ catalog, results: retrieval.results });

    expect(surface.exposedParentNames).toEqual(["WEATHER", "ARCHIVE"]);
  });
});
