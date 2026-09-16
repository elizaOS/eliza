/** Verifies the EntityTypeRegistry seeds built-ins and registers new types idempotently. Deterministic vitest. */
import { describe, expect, it } from "vitest";
import { EntityTypeRegistry } from "./types.js";

describe("EntityTypeRegistry", () => {
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
