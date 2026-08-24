/**
 * Entity-type primitives. Built-in types are seeded into every registry,
 * registration is idempotent per identical metadata but conflicting metadata
 * throws, listing is sorted, and connector-account normalization trims outer
 * whitespace only before falling back to the legacy default partition.
 */
import { describe, expect, it } from "vitest";
import {
  BUILT_IN_ENTITY_TYPES,
  DEFAULT_CONNECTOR_ACCOUNT_ID,
  defaultEntityTypeRegistry,
  EntityTypeRegistry,
  normalizeEntityConnectorAccountId,
  SELF_ENTITY_ID,
} from "./entity-types";

describe("module constants", () => {
  it("exposes exactly the five built-in entity types", () => {
    expect([...BUILT_IN_ENTITY_TYPES]).toEqual([
      "person",
      "organization",
      "place",
      "project",
      "concept",
    ]);
  });

  it("uses the reserved self entity id", () => {
    expect(SELF_ENTITY_ID).toBe("self");
  });

  it("uses the legacy default connector account partition", () => {
    expect(DEFAULT_CONNECTOR_ACCOUNT_ID).toBe("default");
  });
});

describe("normalizeEntityConnectorAccountId", () => {
  it("falls back to the default partition for null and undefined", () => {
    expect(normalizeEntityConnectorAccountId(null)).toBe(
      DEFAULT_CONNECTOR_ACCOUNT_ID,
    );
    expect(normalizeEntityConnectorAccountId(undefined)).toBe(
      DEFAULT_CONNECTOR_ACCOUNT_ID,
    );
  });

  it("falls back to the default partition for empty and blank input", () => {
    expect(normalizeEntityConnectorAccountId("")).toBe(
      DEFAULT_CONNECTOR_ACCOUNT_ID,
    );
    expect(normalizeEntityConnectorAccountId("   ")).toBe(
      DEFAULT_CONNECTOR_ACCOUNT_ID,
    );
    expect(normalizeEntityConnectorAccountId("\t\n")).toBe(
      DEFAULT_CONNECTOR_ACCOUNT_ID,
    );
  });

  it("returns a non-empty value unchanged", () => {
    expect(normalizeEntityConnectorAccountId("acct-1")).toBe("acct-1");
  });

  it("trims surrounding whitespace but keeps interior spacing and case", () => {
    expect(normalizeEntityConnectorAccountId("  acct 1  ")).toBe("acct 1");
    expect(normalizeEntityConnectorAccountId(" ACC ")).toBe("ACC");
    expect(normalizeEntityConnectorAccountId("\tacc\n")).toBe("acc");
  });

  it("treats ids differing only by case as distinct opaque values", () => {
    expect(normalizeEntityConnectorAccountId("ACC")).toBe("ACC");
    expect(normalizeEntityConnectorAccountId("ACC")).not.toBe(
      normalizeEntityConnectorAccountId("acc"),
    );
  });
});

describe("EntityTypeRegistry", () => {
  it("seeds every built-in type with itself as label and admin-owner visibility", () => {
    const registry = new EntityTypeRegistry();
    for (const type of BUILT_IN_ENTITY_TYPES) {
      expect(registry.has(type)).toBe(true);
      expect(registry.metadataFor(type)).toEqual({
        label: type,
        defaultVisibility: "owner_agent_admin",
      });
    }
  });

  it("lists all registered types in sorted order", () => {
    const registry = new EntityTypeRegistry();
    registry.register("vehicle");
    const listed = registry.list();
    expect(listed).toEqual([...listed].sort());
    expect(listed).toContain("vehicle");
    expect(listed).toContain("person");
  });

  it("reports false for unknown types", () => {
    const registry = new EntityTypeRegistry();
    expect(registry.has("spaceship")).toBe(false);
    expect(registry.metadataFor("spaceship")).toBeNull();
  });

  it("registers a new type with defaults derived from its key", () => {
    const registry = new EntityTypeRegistry();
    registry.register("pet");
    expect(registry.has("pet")).toBe(true);
    expect(registry.metadataFor("pet")).toEqual({
      label: "pet",
      defaultVisibility: "owner_agent_admin",
    });
  });

  it("honours explicit label and default visibility", () => {
    const registry = new EntityTypeRegistry();
    registry.register("device", {
      label: "Device",
      defaultVisibility: "agent_and_admin",
    });
    expect(registry.metadataFor("device")).toEqual({
      label: "Device",
      defaultVisibility: "agent_and_admin",
    });
  });

  it("re-registering with identical metadata is an idempotent no-op", () => {
    const registry = new EntityTypeRegistry();
    registry.register("device", {
      label: "Device",
      defaultVisibility: "agent_and_admin",
    });
    registry.register("device", {
      label: "Device",
      defaultVisibility: "agent_and_admin",
    });
    expect(registry.metadataFor("device")).toEqual({
      label: "Device",
      defaultVisibility: "agent_and_admin",
    });
  });

  it("re-registering a built-in with equivalent derived metadata is a no-op", () => {
    const registry = new EntityTypeRegistry();
    expect(() => registry.register("person")).not.toThrow();
    expect(registry.metadataFor("person")).toEqual({
      label: "person",
      defaultVisibility: "owner_agent_admin",
    });
    expect(registry.list()).toHaveLength(BUILT_IN_ENTITY_TYPES.length);
  });

  it("throws when re-registering with a different label", () => {
    const registry = new EntityTypeRegistry();
    registry.register("device", { label: "Device" });
    expect(() => registry.register("device", { label: "Gadget" })).toThrowError(
      '[EntityTypeRegistry] type "device" already registered with different metadata',
    );
  });

  it("throws when re-registering with a different default visibility", () => {
    const registry = new EntityTypeRegistry();
    registry.register("device", {
      defaultVisibility: "owner_only",
    });
    expect(() =>
      registry.register("device", { defaultVisibility: "owner_agent_admin" }),
    ).toThrowError(/already registered with different metadata/);
    expect(registry.metadataFor("device")).toEqual({
      label: "device",
      defaultVisibility: "owner_only",
    });
  });
});

describe("defaultEntityTypeRegistry", () => {
  it("knows the built-ins and stays isolated from other instances", () => {
    expect(defaultEntityTypeRegistry.has("person")).toBe(true);

    const registry = new EntityTypeRegistry();
    registry.register("isolated-marker");
    expect(defaultEntityTypeRegistry.has("isolated-marker")).toBe(false);
  });
});
