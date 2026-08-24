/**
 * Exercises the first-party registry loader against the real module and the
 * real Zod schemas (no mocks, no I/O): fail-loud validation naming the
 * offending file, duplicate-id rejection, index construction (byId, byKind,
 * sorted byGroup, byNpmName), the kind-narrowed accessors, and the runtime
 * overlay merge.
 */

import { describe, expect, it } from "vitest";
import {
  getApps,
  getConnectors,
  getEntry,
  getEntryByNpmName,
  getPlugins,
  indexEntries,
  type LoadedRegistry,
  loadRegistryFromRawEntries,
  mergeWithRuntime,
  RegistryValidationError,
} from "./loader";
import {
  type RegistryEntry,
  type RegistryRuntimeOverlay,
  registryEntrySchema,
} from "./schema";

function makePlugin(overrides: Record<string, unknown> = {}): RegistryEntry {
  return registryEntrySchema.parse({
    id: "test-plugin",
    name: "Test Plugin",
    kind: "plugin",
    subtype: "feature",
    npmName: "@elizaos/plugin-test",
    render: { group: "plugins" },
    ...overrides,
  });
}

function makeConnector(overrides: Record<string, unknown> = {}): RegistryEntry {
  return registryEntrySchema.parse({
    id: "test-connector",
    name: "Test Connector",
    kind: "connector",
    subtype: "messaging",
    render: { group: "connectors" },
    ...overrides,
  });
}

function makeApp(overrides: Record<string, unknown> = {}): RegistryEntry {
  return registryEntrySchema.parse({
    id: "test-app",
    name: "Test App",
    kind: "app",
    subtype: "tool",
    launch: { type: "internal-tab" },
    render: { group: "apps" },
    ...overrides,
  });
}

describe("loadRegistryFromRawEntries", () => {
  it("validates mixed-kind raw entries and indexes them by every axis", () => {
    const registry = loadRegistryFromRawEntries([
      { file: "a.json", data: makeApp() },
      { file: "b.json", data: makePlugin() },
      { file: "c.json", data: makeConnector() },
    ]);

    expect(registry.all).toHaveLength(3);
    expect(registry.byId.size).toBe(3);
    expect(registry.byKind.get("app")).toHaveLength(1);
    expect(registry.byKind.get("plugin")).toHaveLength(1);
    expect(registry.byKind.get("connector")).toHaveLength(1);
    expect(registry.byNpmName.get("@elizaos/plugin-test")?.id).toBe(
      "test-plugin",
    );
    expect(getEntry(registry, "test-app")?.name).toBe("Test App");
  });

  it("preserves the raw input order in `all` while indexing", () => {
    const registry = loadRegistryFromRawEntries([
      { file: "c.json", data: makeConnector() },
      { file: "a.json", data: makeApp({ id: "another-app" }) },
      { file: "b.json", data: makePlugin({ id: "another-plugin" }) },
    ]);
    expect(registry.all.map((entry) => entry.id)).toEqual([
      "test-connector",
      "another-app",
      "another-plugin",
    ]);
  });

  it("returns empty indexes for an empty raw list, with every kind key pre-seeded", () => {
    const registry = loadRegistryFromRawEntries([]);
    expect(registry.all).toEqual([]);
    expect(registry.byId.size).toBe(0);
    expect([...registry.byKind.keys()].sort()).toEqual([
      "app",
      "connector",
      "plugin",
    ]);
    expect(registry.byKind.get("app")).toEqual([]);
    expect(registry.byKind.get("plugin")).toEqual([]);
    expect(registry.byKind.get("connector")).toEqual([]);
    expect(registry.byGroup.size).toBe(0);
    expect(registry.byNpmName.size).toBe(0);
  });

  it("throws RegistryValidationError naming the offending file when an entry fails schema validation", () => {
    let caught: unknown;
    try {
      loadRegistryFromRawEntries([
        {
          file: "curated/plugins/broken.json",
          data: { id: "broken-entry", kind: "plugin" },
        },
      ]);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(RegistryValidationError);
    const validationError = caught as RegistryValidationError;
    expect(validationError.name).toBe("RegistryValidationError");
    expect(validationError.file).toBe("curated/plugins/broken.json");
    expect(validationError.message).toContain("curated/plugins/broken.json");
    expect(validationError.cause).toBeDefined();
  });

  it("blames the second file and names the duplicated id when two entries share an id", () => {
    let caught: unknown;
    try {
      loadRegistryFromRawEntries([
        { file: "one.json", data: makePlugin() },
        { file: "two.json", data: makePlugin() },
      ]);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(RegistryValidationError);
    const validationError = caught as RegistryValidationError;
    expect(validationError.file).toBe("two.json");
    expect(String(validationError.cause)).toContain(
      'duplicate id "test-plugin"',
    );
  });

  it("does not add the rejected entry to the index before throwing", () => {
    const entries: RegistryEntry[] = [];
    expect(() =>
      loadRegistryFromRawEntries([
        { file: "ok.json", data: makePlugin({ id: "good-plugin" }) },
        { file: "bad.json", data: { kind: "plugin" } },
        { file: "never.json", data: makePlugin({ id: "never-indexed" }) },
      ]),
    ).toThrow(RegistryValidationError);
    expect(entries).toEqual([]);
  });
});

describe("indexEntries", () => {
  it("indexes by id, kind, group, and npm name, keeping object identity", () => {
    const plugin = makePlugin();
    const connector = makeConnector();
    const registry = indexEntries([plugin, connector]);

    expect(registry.byId.get("test-plugin")).toBe(plugin);
    expect(registry.byKind.get("plugin")).toEqual([plugin]);
    expect(registry.byKind.get("connector")).toEqual([connector]);
    expect(registry.byGroup.get("plugins")).toEqual([plugin]);
    expect(registry.byGroup.get("connectors")).toEqual([connector]);
    expect(registry.byNpmName.get("@elizaos/plugin-test")).toBe(plugin);
  });

  it("leaves entries without an npmName out of byNpmName", () => {
    const named = makePlugin();
    const unnamed = makePlugin({
      id: "unnamed-plugin",
      name: "Unnamed Plugin",
      npmName: undefined,
    });
    const registry = indexEntries([named, unnamed]);

    expect(registry.byNpmName.size).toBe(1);
    expect(registry.byNpmName.has("@elizaos/plugin-test")).toBe(true);
    expect(getEntryByNpmName(registry, "unnamed-plugin")).toBeUndefined();
    expect(registry.byId.has("unnamed-plugin")).toBe(true);
  });

  it("resolves a shared npmName to the last indexed entry while keeping both ids", () => {
    const first = makePlugin({ id: "first-owner" });
    const second = makePlugin({
      id: "second-owner",
      name: "Second Owner",
    });
    const registry = indexEntries([first, second]);

    expect(registry.byId.size).toBe(2);
    expect(registry.byNpmName.get("@elizaos/plugin-test")).toBe(second);
  });

  it("keeps empty buckets for kinds with no entries", () => {
    const registry = indexEntries([makePlugin()]);
    expect(registry.byKind.get("app")).toEqual([]);
    expect(registry.byKind.get("connector")).toEqual([]);
    expect(registry.byKind.get("plugin")).toHaveLength(1);
  });

  it("sorts each group bucket by groupOrder, then name, with missing groupOrder last", () => {
    const midNoOrder = makePlugin({
      id: "mid-no-order",
      name: "mid",
      render: { group: "tools" },
    });
    const zetaOrderTwo = makePlugin({
      id: "zeta-order-two",
      name: "zeta",
      render: { group: "tools", groupOrder: 2 },
    });
    const alphaOrderTwo = makePlugin({
      id: "alpha-order-two",
      name: "alpha",
      render: { group: "tools", groupOrder: 2 },
    });
    const aaaOrderOne = makePlugin({
      id: "aaa-order-one",
      name: "aaa",
      render: { group: "tools", groupOrder: 1 },
    });
    const otherGroup = makePlugin({
      id: "other-group",
      name: "elsewhere",
      render: { group: "elsewhere" },
    });

    const registry = indexEntries([
      midNoOrder,
      zetaOrderTwo,
      otherGroup,
      aaaOrderOne,
      alphaOrderTwo,
    ]);

    expect(registry.byGroup.get("tools")?.map((entry) => entry.name)).toEqual([
      "aaa",
      "alpha",
      "zeta",
      "mid",
    ]);
    expect(registry.byGroup.get("elsewhere")?.map((entry) => entry.id)).toEqual(
      ["other-group"],
    );
  });

  it("does not reorder the caller's `all` list when sorting group buckets", () => {
    const late = makePlugin({
      id: "late",
      name: "late",
      render: { group: "tools", groupOrder: 9 },
    });
    const early = makePlugin({
      id: "early",
      name: "early",
      render: { group: "tools", groupOrder: 1 },
    });
    const input = [late, early];
    const registry = indexEntries(input);

    expect(registry.all.map((entry) => entry.id)).toEqual(["late", "early"]);
    expect(registry.byGroup.get("tools")?.map((entry) => entry.id)).toEqual([
      "early",
      "late",
    ]);
  });
});

describe("kind-narrowed accessors", () => {
  it("partitions a loaded registry by kind", () => {
    const registry = loadRegistryFromRawEntries([
      { file: "a.json", data: makeApp() },
      { file: "b.json", data: makePlugin() },
      { file: "c.json", data: makeConnector() },
    ]);

    expect(getApps(registry).map((entry) => entry.kind)).toEqual(["app"]);
    expect(getPlugins(registry).map((entry) => entry.kind)).toEqual(["plugin"]);
    expect(getConnectors(registry).map((entry) => entry.kind)).toEqual([
      "connector",
    ]);
  });

  it("returns empty arrays rather than undefined for absent kinds", () => {
    const registry: LoadedRegistry = loadRegistryFromRawEntries([]);
    expect(getApps(registry)).toEqual([]);
    expect(getPlugins(registry)).toEqual([]);
    expect(getConnectors(registry)).toEqual([]);
  });
});

describe("getEntry and getEntryByNpmName lookups", () => {
  const registry = loadRegistryFromRawEntries([
    { file: "p.json", data: makePlugin() },
  ]);

  it("resolves an existing id and returns undefined for a miss", () => {
    expect(getEntry(registry, "test-plugin")?.id).toBe("test-plugin");
    expect(getEntry(registry, "missing-id")).toBeUndefined();
  });

  it("resolves an existing npm name and returns undefined for a miss", () => {
    expect(getEntryByNpmName(registry, "@elizaos/plugin-test")?.id).toBe(
      "test-plugin",
    );
    expect(
      getEntryByNpmName(registry, "@elizaos/plugin-missing"),
    ).toBeUndefined();
  });
});

describe("mergeWithRuntime", () => {
  const overlayFor = (
    id: string,
    overrides: Partial<RegistryRuntimeOverlay> = {},
  ): RegistryRuntimeOverlay => ({
    id,
    enabled: false,
    configured: false,
    isActive: false,
    validationErrors: [],
    validationWarnings: [],
    ...overrides,
  });

  it("applies each overlay to the entry with the matching id, keeping static fields", () => {
    const plugin = makePlugin();
    const connector = makeConnector();
    const views = mergeWithRuntime(
      [plugin, connector],
      [
        overlayFor("test-connector", {
          enabled: true,
          configured: true,
          isActive: true,
          installedVersion: "1.2.3",
        }),
        overlayFor("test-plugin", { enabled: true }),
      ],
    );

    expect(views).toHaveLength(2);
    const pluginView = views[0];
    const connectorView = views[1];
    expect(pluginView.enabled).toBe(true);
    expect(pluginView.configured).toBe(false);
    expect(pluginView.isActive).toBe(false);
    expect(pluginView.name).toBe("Test Plugin");
    expect(pluginView.npmName).toBe("@elizaos/plugin-test");
    expect(connectorView.enabled).toBe(true);
    expect(connectorView.configured).toBe(true);
    expect(connectorView.isActive).toBe(true);
    expect(connectorView.installedVersion).toBe("1.2.3");
    expect(connectorView.subtype).toBe("messaging");
  });

  it("matches overlays by id regardless of array order", () => {
    const alpha = makePlugin({ id: "alpha-plugin", name: "Alpha" });
    const beta = makePlugin({ id: "beta-plugin", name: "Beta" });
    const views = mergeWithRuntime(
      [alpha, beta],
      [
        overlayFor("beta-plugin", { configured: true }),
        overlayFor("alpha-plugin", { isActive: true }),
      ],
    );

    const byId = new Map(views.map((view) => [view.id, view]));
    expect(byId.get("alpha-plugin")?.isActive).toBe(true);
    expect(byId.get("alpha-plugin")?.configured).toBe(false);
    expect(byId.get("beta-plugin")?.configured).toBe(true);
    expect(byId.get("beta-plugin")?.isActive).toBe(false);
  });

  it("substitutes a safe default overlay when an entry has no runtime state", () => {
    const orphan = makePlugin({ id: "orphan-plugin" });
    const views = mergeWithRuntime([orphan], []);

    expect(views).toHaveLength(1);
    expect(views[0].id).toBe("orphan-plugin");
    expect(views[0].enabled).toBe(false);
    expect(views[0].configured).toBe(false);
    expect(views[0].isActive).toBe(false);
    expect(views[0].validationErrors).toEqual([]);
    expect(views[0].validationWarnings).toEqual([]);
  });

  it("carries validation errors and warnings through the merged view", () => {
    const plugin = makePlugin();
    const views = mergeWithRuntime(
      [plugin],
      [
        overlayFor("test-plugin", {
          validationErrors: [{ field: "apiKey", message: "missing" }],
          validationWarnings: [{ field: "timeout", message: "low" }],
        }),
      ],
    );

    expect(views[0].validationErrors).toEqual([
      { field: "apiKey", message: "missing" },
    ]);
    expect(views[0].validationWarnings).toEqual([
      { field: "timeout", message: "low" },
    ]);
  });

  it("returns fresh view objects and leaves the input entries untouched", () => {
    const plugin = makePlugin();
    const input = [plugin];
    const views = mergeWithRuntime(input, [
      overlayFor("test-plugin", {
        enabled: true,
      }),
    ]);

    expect(views[0]).not.toBe(plugin);
    expect(views[0].enabled).toBe(true);
    expect((plugin as { enabled?: boolean }).enabled).toBeUndefined();
    expect(input).toEqual([plugin]);
  });
});
