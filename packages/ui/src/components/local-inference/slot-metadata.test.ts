/**
 * Tests for slot-metadata — LOCAL_INFERENCE_SLOT_DESCRIPTORS.
 */
import { describe, expect, it } from "vitest";
import { LOCAL_INFERENCE_SLOT_DESCRIPTORS } from "./slot-metadata.ts";

describe("slot-metadata", () => {
  it("has 5 descriptors", () => {
    expect(LOCAL_INFERENCE_SLOT_DESCRIPTORS).toHaveLength(5);
  });

  it("contains TEXT_SMALL", () => {
    const found = LOCAL_INFERENCE_SLOT_DESCRIPTORS.find(
      (d) => d.slot === "TEXT_SMALL",
    );
    expect(found).toBeDefined();
    expect(found?.label).toBe("Small text");
  });

  it("all have required fields", () => {
    for (const d of LOCAL_INFERENCE_SLOT_DESCRIPTORS) {
      expect(d.slot).toBeDefined();
      expect(d.modelType).toBeDefined();
      expect(d.label.length).toBeGreaterThan(0);
      expect(d.description.length).toBeGreaterThan(0);
    }
  });

  it("contains embeddings", () => {
    expect(
      LOCAL_INFERENCE_SLOT_DESCRIPTORS.some((d) => d.slot === "TEXT_EMBEDDING"),
    ).toBe(true);
  });

  it("slots are unique", () => {
    const slots = LOCAL_INFERENCE_SLOT_DESCRIPTORS.map((d) => d.slot);
    expect(new Set(slots).size).toBe(slots.length);
  });
});
