/**
 * Verifies safe sorting in local inference recommendation, assignments, and handler-registry when sizes, scores, or priorities contain NaN.
 */

import { describe, expect, it } from "vitest";
import { selectRecommendedModels } from "./recommendation.js";
import { buildRecommendedAssignments } from "./assignments.js";
import { handlerRegistry } from "./handler-registry.js";
import type { CatalogModel, HardwareProbe, InstalledModel } from "./types.js";

describe("local-inference safe sort", () => {
  it("safely ranks candidates when catalog download sizes contain NaN or non-finite values", () => {
    const mockHardware: HardwareProbe = {
      ramBytes: 32 * 1024 * 1024 * 1024,
      vramBytes: 16 * 1024 * 1024 * 1024,
      gpuVendors: ["apple"],
      cores: 8,
      platform: "darwin",
      arch: "arm64",
    };

    const mockCatalog: CatalogModel[] = [
      {
        id: "eliza-1-small",
        name: "Eliza 1 Small",
        quant: "Q4_K_M",
        sizeBytes: NaN,
        ramRequiredBytes: 2 * 1024 * 1024 * 1024,
        vramRequiredBytes: 2 * 1024 * 1024 * 1024,
        contextLength: 4096,
        type: "chat",
        recommended: true,
      } as unknown as CatalogModel,
      {
        id: "eliza-1-large",
        name: "Eliza 1 Large",
        quant: "Q4_K_M",
        sizeBytes: 8 * 1024 * 1024 * 1024,
        ramRequiredBytes: 4 * 1024 * 1024 * 1024,
        vramRequiredBytes: 4 * 1024 * 1024 * 1024,
        contextLength: 4096,
        type: "chat",
        recommended: true,
      } as unknown as CatalogModel,
    ];

    const recommended = selectRecommendedModels(mockHardware, mockCatalog);
    expect(recommended).toBeDefined();
    expect(recommended.TEXT_SMALL).toBeDefined();
    expect(recommended.TEXT_LARGE).toBeDefined();
  });

  it("safely handles installed models with NaN sizeBytes in buildRecommendedAssignments", () => {
    const installed: InstalledModel[] = [
      { id: "eliza-1-nan", sizeBytes: NaN, source: "eliza-download" } as unknown as InstalledModel,
      { id: "eliza-1-10g", sizeBytes: 10 * 1024 * 1024 * 1024, source: "eliza-download" } as unknown as InstalledModel,
      { id: "eliza-1-2g", sizeBytes: 2 * 1024 * 1024 * 1024, source: "eliza-download" } as unknown as InstalledModel,
    ];

    const assignments = buildRecommendedAssignments(installed);
    expect(assignments).toBeDefined();
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
});
