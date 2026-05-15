import { describe, expect, it } from "vitest";
import { BUILT_IN_ENTITY_TYPES, EntityTypeRegistry } from "./types.js";

describe("EntityTypeRegistry", () => {
  it("includes all built-ins on construction", () => {
    const registry = new EntityTypeRegistry();
    for (const type of BUILT_IN_ENTITY_TYPES) {
      expect(registry.has(type)).toBe(true);
    }
  });

  it("registers a new type idempotently with same metadata", () => {
    const registry = new EntityTypeRegistry();
    registry.register("vehicle", { label: "Vehicle" });
    expect(registry.has("vehicle")).toBe(true);
    // Idempotent re-register.
    registry.register("vehicle", { label: "Vehicle" });
    expect(registry.metadataFor("vehicle")?.label).toBe("Vehicle");
  });

  it("rejects re-registration with conflicting metadata", () => {
    const registry = new EntityTypeRegistry();
    registry.register("vehicle", { label: "Vehicle" });
    expect(() => registry.register("vehicle", { label: "Different" })).toThrow(
      /already registered/,
    );
  });
});
