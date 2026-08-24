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

describe("BUILT_IN_RELATIONSHIP_TYPES", () => {
  it("declares the thirteen known planner shapes", () => {
    expect([...BUILT_IN_RELATIONSHIP_TYPES]).toEqual([
      "follows",
      "colleague_of",
      "friend_of",
      "family_of",
      "partner_of",
      "ex_partner_of",
      "co_parent_of",
      "manages",
      "managed_by",
      "lives_at",
      "works_at",
      "knows",
      "owns",
    ]);
  });
});

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

  it("stores explicit metadata on a new type", () => {
    const registry = new RelationshipTypeRegistry();
    registry.register("mentors", {
      label: "mentors",
      metadataKeys: ["since"],
      symmetric: true,
    });
    expect(registry.isSymmetric("mentors")).toBe(true);
  });

  it("treats an identical re-registration as a no-op", () => {
    const registry = new RelationshipTypeRegistry();
    registry.register("mentor_of", {
      label: "mentor of",
      metadataKeys: ["since", "cadenceDays"],
      symmetric: true,
    });
    expect(() =>
      registry.register("mentor_of", {
        label: "mentor of",
        metadataKeys: ["since", "cadenceDays"],
        symmetric: true,
      }),
    ).not.toThrow();
    const mentorEntries = registry.list().filter((t) => t === "mentor_of");
    expect(mentorEntries).toHaveLength(1);
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

  it("rejects a conflicting label without mutating the original", () => {
    const registry = new RelationshipTypeRegistry();
    expect(() =>
      registry.register("friend_of", { label: "bestie of" }),
    ).toThrow(
      '[RelationshipTypeRegistry] type "friend_of" already registered with different metadata',
    );
    // Original registration survives the failed attempt.
    expect(registry.has("friend_of")).toBe(true);
    expect(registry.list()).not.toContain("bestie of");
  });

  it("rejects a conflicting symmetry flag", () => {
    const registry = new RelationshipTypeRegistry();
    // Default symmetric=false diverges from the built-in symmetric=true.
    expect(() => registry.register("knows")).toThrow(
      '[RelationshipTypeRegistry] type "knows" already registered with different metadata',
    );
    expect(() =>
      registry.register("follows", { label: "follows", symmetric: true }),
    ).toThrow(/already registered with different metadata/);
  });

  it("rejects divergent metadata keys, including reordered ones", () => {
    const registry = new RelationshipTypeRegistry();
    expect(() =>
      registry.register("follows", {
        label: "follows",
        metadataKeys: ["cadenceDays", "since"],
        symmetric: false,
      }),
    ).toThrow(/already registered with different metadata/);
    registry.register("mentor_of", {
      label: "mentor of",
      metadataKeys: ["since", "team"],
      symmetric: false,
    });
    // Same keys in a different order count as different metadata.
    expect(() =>
      registry.register("mentor_of", {
        label: "mentor of",
        metadataKeys: ["team", "since"],
        symmetric: false,
      }),
    ).toThrow(/already registered with different metadata/);
    expect(registry.isSymmetric("mentor_of")).toBe(false);
  });
});

describe("has / isSymmetric lookups", () => {
  it("reports false for unregistered types", () => {
    const registry = new RelationshipTypeRegistry();
    expect(registry.has("never_registered")).toBe(false);
    expect(registry.isSymmetric("never_registered")).toBe(false);
  });

  it("reflects registration state transitions", () => {
    const registry = new RelationshipTypeRegistry();
    expect(registry.has("ally_of")).toBe(false);
    registry.register("ally_of", { symmetric: true });
    expect(registry.has("ally_of")).toBe(true);
    expect(registry.isSymmetric("ally_of")).toBe(true);
  });
});

describe("list", () => {
  it("returns entries in alphabetical order", () => {
    const registry = new RelationshipTypeRegistry();
    registry.register("ally_of");
    const listed = registry.list();
    expect(listed).toEqual([...listed].sort());
    expect(listed[0]).toBe("ally_of");
    // Default sort is code-unit order: "_" precedes letters, so
    // co_parent_of lands before colleague_of.
    expect(listed[1]).toBe("co_parent_of");
    expect(listed[2]).toBe("colleague_of");
    expect(listed[listed.length - 1]).toBe("works_at");
  });

  it("returns a fresh copy that callers cannot use to mutate the registry", () => {
    const registry = new RelationshipTypeRegistry();
    const first = registry.list();
    first.push("smuggled_type");
    expect(registry.has("smuggled_type")).toBe(false);
    expect(registry.list()).toHaveLength(first.length - 1);
  });
});

describe("defaultRelationshipTypeRegistry", () => {
  it("is a pre-seeded RelationshipTypeRegistry instance", () => {
    expect(defaultRelationshipTypeRegistry).toBeInstanceOf(
      RelationshipTypeRegistry,
    );
    expect(defaultRelationshipTypeRegistry.has("follows")).toBe(true);
    expect(defaultRelationshipTypeRegistry.isSymmetric("knows")).toBe(true);
    expect(defaultRelationshipTypeRegistry.isSymmetric("manages")).toBe(false);
    expect(defaultRelationshipTypeRegistry.list()).toHaveLength(
      BUILT_IN_RELATIONSHIP_TYPES.length,
    );
  });
});
