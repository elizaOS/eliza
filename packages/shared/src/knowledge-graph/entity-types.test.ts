/**
 * Entity-type primitives. Built-in types are seeded into every registry,
 * registration is idempotent per identical metadata but conflicting metadata
 * throws, listing is sorted, and connector-account normalization trims outer
 * whitespace only before falling back to the legacy default partition.
 */
import { describe, expect, it } from "vitest";
import {
  BUILT_IN_ENTITY_TYPES,
  defaultEntityTypeRegistry,
  EntityTypeRegistry,
  normalizeEntityConnectorAccountId,
} from "./entity-types";

describe("normalizeEntityConnectorAccountId", () => {
  it("preserves the legacy partition and opaque account spelling", () => {
    for (const input of [null, undefined, "", "   ", "\t\n"]) {
      expect(normalizeEntityConnectorAccountId(input)).toBe("default");
    }
    for (const [input, expected] of [
      ["acct-1", "acct-1"],
      ["  acct 1  ", "acct 1"],
      [" ACC ", "ACC"],
      ["\tacc\n", "acc"],
    ]) {
      expect(normalizeEntityConnectorAccountId(input)).toBe(expected);
    }
  });
});

describe("EntityTypeRegistry", () => {
  it("seeds built-ins idempotently with derived labels and admin-owner visibility", () => {
    const registry = new EntityTypeRegistry();
    for (const type of BUILT_IN_ENTITY_TYPES) {
      expect(registry.has(type)).toBe(true);
      expect(registry.metadataFor(type)).toEqual({
        label: type,
        defaultVisibility: "owner_agent_admin",
      });
      registry.register(type);
    }
    expect(registry.list()).toEqual([...BUILT_IN_ENTITY_TYPES].sort());
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

  it("retains explicit metadata across identical registration", () => {
    const registry = new EntityTypeRegistry();
    const metadata = {
      label: "Device",
      defaultVisibility: "agent_and_admin" as const,
    };
    registry.register("device", metadata);
    registry.register("device", metadata);
    expect(registry.metadataFor("device")).toEqual(metadata);
  });

  it("throws when re-registering with a different label", () => {
    const registry = new EntityTypeRegistry();
    registry.register("device", { label: "Device" });
    expect(() => registry.register("device", { label: "Gadget" })).toThrowError(
      /already registered with different metadata/,
    );
    expect(registry.metadataFor("device")?.label).toBe("Device");
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
