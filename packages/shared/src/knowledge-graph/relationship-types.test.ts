/**
 * RelationshipTypeRegistry contract against the real module: built-in
 * registrations are seeded exactly once, re-registering identical metadata is
 * a no-op while any divergence (label, symmetry, metadata-key order included)
 * throws without mutating state, unknown types fall back to asymmetric/false,
 * and list() returns a fresh alphabetically sorted copy.
 */
import { describe, expect, it } from "vitest";
import {
  BUILT_IN_RELATIONSHIP_TYPES,
  defaultRelationshipTypeRegistry,
  RelationshipTypeRegistry,
} from "./relationship-types";

describe("RelationshipTypeRegistry construction", () => {
  it("seeds exactly the built-in types", () => {
    const registry = new RelationshipTypeRegistry();
    expect(registry.list()).toHaveLength(BUILT_IN_RELATIONSHIP_TYPES.length);
    for (const type of BUILT_IN_RELATIONSHIP_TYPES) {
      expect(registry.has(type)).toBe(true);
    }
    expect(registry.has("mentor_of")).toBe(false);
  });

  it("marks the symmetric built-ins symmetric and the rest not", () => {
    const registry = new RelationshipTypeRegistry();
    const symmetric = [
      "colleague_of",
      "friend_of",
      "family_of",
      "partner_of",
      "ex_partner_of",
      "co_parent_of",
      "knows",
    ];
    for (const type of BUILT_IN_RELATIONSHIP_TYPES) {
      expect(registry.isSymmetric(type)).toBe(symmetric.includes(type));
    }
  });
});

describe("register", () => {
  it("accepts a brand-new type with defaulted metadata", () => {
    const registry = new RelationshipTypeRegistry();
    registry.register("mentor_of");
    expect(registry.has("mentor_of")).toBe(true);
    // Defaults: label falls back to the type name, empty keys, asymmetric.
    expect(registry.isSymmetric("mentor_of")).toBe(false);
    expect(registry.list()).toContain("mentor_of");
  });

  it("registers a symmetric type once and exposes the state transition", () => {
    const registry = new RelationshipTypeRegistry();
    const metadata = {
      label: "mentor of",
      metadataKeys: ["since", "team"],
      symmetric: true,
    };
    expect(registry.has("mentor_of")).toBe(false);
    expect(registry.isSymmetric("mentor_of")).toBe(false);
    registry.register("mentor_of", metadata);
    registry.register("mentor_of", metadata);
    expect(registry.has("mentor_of")).toBe(true);
    expect(registry.isSymmetric("mentor_of")).toBe(true);
    expect(registry.list().filter((type) => type === "mentor_of")).toHaveLength(
      1,
    );
  });

  it("re-accepts a built-in only when its canonical metadata matches", () => {
    const registry = new RelationshipTypeRegistry();
    expect(() =>
      registry.register("follows", {
        label: "follows",
        metadataKeys: ["cadenceDays"],
        symmetric: false,
      }),
    ).not.toThrow();
  });

  it.each([
    ["label", { label: "other" }],
    ["symmetry", { symmetric: false }],
    ["metadata keys", { metadataKeys: ["since", "team", "extra"] }],
    ["key order", { metadataKeys: ["team", "since"] }],
  ])(
    "rejects conflicting %s without changing the original",
    (_field, changed) => {
      const registry = new RelationshipTypeRegistry();
      const metadata = {
        label: "mentor of",
        metadataKeys: ["since", "team"],
        symmetric: true,
      };
      registry.register("mentor_of", metadata);
      expect(() =>
        registry.register("mentor_of", { ...metadata, ...changed }),
      ).toThrow(/already registered with different metadata/);
      expect(registry.has("mentor_of")).toBe(true);
      expect(registry.isSymmetric("mentor_of")).toBe(true);
      registry.register("mentor_of", metadata);
    },
  );
});

describe("list", () => {
  it("returns sorted copies that cannot mutate the registry", () => {
    const registry = new RelationshipTypeRegistry();
    registry.register("ally_of");
    const listed = registry.list();
    expect(listed).toEqual([...listed].sort());
    expect(listed).toContain("ally_of");
    listed.push("smuggled_type");
    expect(registry.has("smuggled_type")).toBe(false);
    expect(registry.list()).toEqual(listed.slice(0, -1));
  });
});

describe("defaultRelationshipTypeRegistry", () => {
  it("is a pre-seeded RelationshipTypeRegistry instance", () => {
    expect(defaultRelationshipTypeRegistry.has("follows")).toBe(true);
    expect(defaultRelationshipTypeRegistry.isSymmetric("knows")).toBe(true);
    expect(defaultRelationshipTypeRegistry.isSymmetric("manages")).toBe(false);
  });
});
