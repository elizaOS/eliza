import { describe, expect, it } from "vitest";
import { findCatalogModel, MODEL_CATALOG } from "./catalog";
import { localInferenceService } from "./service";

describe("local inference catalog", () => {
  it("keeps DFlash drafter companions installable but hidden from the hub", () => {
    const visible = localInferenceService.getCatalog();
    expect(visible.some((model) => model.category === "drafter")).toBe(false);
    expect(
      MODEL_CATALOG.some(
        (model) => model.id === "qwen3.5-4b-dflash-drafter-q4",
      ),
    ).toBe(true);
    expect(
      findCatalogModel("qwen3.5-4b-dflash-drafter-q4")?.hiddenFromCatalog,
    ).toBe(true);
  });

  it("wires Qwen DFlash targets to their hidden drafter companions", () => {
    for (const id of [
      "qwen3.5-4b-dflash",
      "qwen3.5-9b-dflash",
      "qwen3.6-27b-dflash",
    ]) {
      const model = findCatalogModel(id);
      expect(model?.runtime?.preferredBackend).toBe("llama-server");
      const drafterId = model?.runtime?.dflash?.drafterModelId;
      expect(drafterId).toBeTruthy();
      expect(model?.companionModelIds).toContain(drafterId);
      const drafter = findCatalogModel(String(drafterId));
      expect(drafter?.runtimeRole).toBe("dflash-drafter");
      expect(drafter?.companionForModelId).toBe(id);
    }
  });
});
