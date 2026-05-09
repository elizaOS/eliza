import { describe, expect, it } from "vitest";
import {
  RelationshipTypeRegistry,
  BUILT_IN_RELATIONSHIP_TYPES,
} from "./types.js";

describe("RelationshipTypeRegistry", () => {
  it("includes all built-ins on construction", () => {
    const registry = new RelationshipTypeRegistry();
    for (const type of BUILT_IN_RELATIONSHIP_TYPES) {
      expect(registry.has(type)).toBe(true);
    }
  });

  it("knows symmetric vs asymmetric built-ins", () => {
    const registry = new RelationshipTypeRegistry();
    expect(registry.isSymmetric("partner_of")).toBe(true);
    expect(registry.isSymmetric("colleague_of")).toBe(true);
    expect(registry.isSymmetric("knows")).toBe(true);
    expect(registry.isSymmetric("manages")).toBe(false);
    expect(registry.isSymmetric("managed_by")).toBe(false);
    expect(registry.isSymmetric("works_at")).toBe(false);
  });

  it("registers a custom type and rejects conflicting re-registration", () => {
    const registry = new RelationshipTypeRegistry();
    registry.register("mentors", {
      label: "mentors",
      metadataKeys: ["since"],
      symmetric: false,
    });
    expect(registry.has("mentors")).toBe(true);
    // Idempotent.
    registry.register("mentors", {
      label: "mentors",
      metadataKeys: ["since"],
      symmetric: false,
    });
    // Conflicting metadata throws.
    expect(() =>
      registry.register("mentors", {
        label: "mentors",
        metadataKeys: ["since", "topic"],
        symmetric: false,
      }),
    ).toThrow(/already registered/);
  });
});
