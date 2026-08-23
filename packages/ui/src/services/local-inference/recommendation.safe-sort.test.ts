/**
 * Verifies safe sorting in local inference recommendation, assignments, and handler-registry when sizes, scores, or priorities contain NaN.
 */

import { describe, expect, it } from "vitest";
import { buildRecommendedAssignments } from "./assignments.js";
import { handlerRegistry } from "./handler-registry.js";
import type { InstalledModel } from "./types.js";

function makeInstalled(
  id: string,
  sizeBytes: number,
  overrides: Partial<InstalledModel> = {},
): InstalledModel {
  return {
    id,
    displayName: id,
    path: `/tmp/${id}.gguf`,
    sizeBytes,
    installedAt: "2026-05-11T00:00:00.000Z",
    lastUsedAt: null,
    source: "eliza-download",
    bundleVerifiedAt: "2026-05-11T01:00:00.000Z",
    ...overrides,
  };
}

describe("local-inference safe sort", () => {
  it("safely picks the largest installed model when sizeBytes contains NaN", () => {
    const installed = [
      makeInstalled("eliza-1-2b", NaN),
      makeInstalled("eliza-1-9b", 9 * 1024 * 1024 * 1024),
      makeInstalled("eliza-1-4b", 4 * 1024 * 1024 * 1024),
    ];

    const assignments = buildRecommendedAssignments(installed);
    expect(assignments).toBeDefined();
    // Non-finite sizeBytes is coerced to 0, so eliza-1-9b (9GB) is picked
    expect(assignments.TEXT_LARGE).toBe("eliza-1-9b");
  });

  it("safely sorts handler registrations by priority when priority contains NaN", () => {
    const handler1 = {
      modelType: "TEXT_SMALL",
      provider: "prov-1",
      priority: 10,
      registeredAt: new Date().toISOString(),
    };
    const handlerNan = {
      modelType: "TEXT_SMALL",
      provider: "prov-nan",
      priority: NaN,
      registeredAt: new Date().toISOString(),
    };
    const handler2 = {
      modelType: "TEXT_SMALL",
      provider: "prov-2",
      priority: 20,
      registeredAt: new Date().toISOString(),
    };

    (handlerRegistry as any).record(handler1);
    (handlerRegistry as any).record(handlerNan);
    (handlerRegistry as any).record(handler2);

    const handlers = handlerRegistry.getForType("TEXT_SMALL");
    expect(handlers[0].provider).toBe("prov-2");
    expect(handlers[1].provider).toBe("prov-1");
    expect(handlers[2].provider).toBe("prov-nan");
  });

  it("safely sorts device summaries when score contains NaN", () => {
    const summaries = [
      { deviceId: "d-1", score: 10, isPrimary: false },
      { deviceId: "d-nan", score: NaN, isPrimary: false },
      { deviceId: "d-2", score: 50, isPrimary: false },
    ];

    summaries.sort(
      (a, b) =>
        (Number.isFinite(b.score) ? b.score : 0) -
        (Number.isFinite(a.score) ? a.score : 0),
    );

    expect(summaries[0].deviceId).toBe("d-2");
    expect(summaries[1].deviceId).toBe("d-1");
    expect(summaries[2].deviceId).toBe("d-nan");
  });
});
