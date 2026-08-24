/**
 * Unit harness for the first-party registry runtime entry point: the
 * disk-backed loadRegistry() over the committed generated.json, its module
 * cache contract, and the validated registerRegistryEntry() runtime overlay
 * (dedupe by id, cache invalidation, legacy connector-auth normalization).
 * Deterministic: real filesystem reads, no network, no mocks.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type ConnectorEntry,
  clearRegistryCacheForTests,
  getEntry,
  getEntryByNpmName,
  getPlugins,
  loadRegistry,
  type PluginEntry,
  type RegistryEntry,
  registerRegistryEntry,
} from "./index";

const RENDER_GROUP = "test-runtime-overlay";
const RUNTIME_ENTRIES_KEY = Symbol.for(
  "elizaos.first-party-registry.runtime-entries",
);

interface RuntimeEntryStore {
  entries: RegistryEntry[];
}

function runtimeStore(): RuntimeEntryStore | undefined {
  return (globalThis as Record<PropertyKey, unknown>)[RUNTIME_ENTRIES_KEY] as
    | RuntimeEntryStore
    | undefined;
}

function renderHints() {
  return {
    visible: true,
    pinTo: [],
    style: "card",
    group: RENDER_GROUP,
    actions: [],
  };
}

function pluginFixture(id: string, name: string): PluginEntry {
  return {
    kind: "plugin",
    id,
    name,
    description: "Runtime overlay fixture registered by index.test.ts",
    source: "bundled",
    tags: [],
    config: {},
    resources: {},
    dependsOn: [],
    channels: [],
    shortIds: [],
    render: renderHints(),
    subtype: "feature",
  };
}

function connectorFixture(
  id: string,
  name: string,
  auth: {
    kind: "token" | "oauth" | "credentials" | "none";
    credentialKeys: string[];
  },
): ConnectorEntry {
  return {
    kind: "connector",
    id,
    name,
    description: "Runtime overlay connector fixture from index.test.ts",
    source: "bundled",
    tags: [],
    config: {},
    resources: {},
    dependsOn: [],
    channels: [],
    shortIds: [],
    render: renderHints(),
    subtype: "messaging",
    auth,
  };
}

describe("first-party registry runtime entry point", () => {
  let savedEntries: RegistryEntry[] | null = null;

  beforeEach(() => {
    const store = runtimeStore();
    savedEntries = store ? store.entries : null;
    if (store) store.entries = [];
    clearRegistryCacheForTests();
  });

  afterEach(() => {
    const store = runtimeStore();
    if (store) store.entries = savedEntries ?? [];
    savedEntries = null;
    clearRegistryCacheForTests();
  });

  it("loads the committed generated.json into a fully indexed registry", () => {
    const registry = loadRegistry();

    expect(registry.all.length).toBeGreaterThan(0);

    const ids = new Set(registry.all.map((entry) => entry.id));
    expect(ids.size).toBe(registry.all.length);
    expect(registry.byId.size).toBe(registry.all.length);

    const kinded =
      (registry.byKind.get("app")?.length ?? 0) +
      (registry.byKind.get("plugin")?.length ?? 0) +
      (registry.byKind.get("connector")?.length ?? 0);
    expect(kinded).toBe(registry.all.length);
  });

  it("serves repeat loads from one cached object until the cache is cleared", () => {
    const first = loadRegistry();
    const second = loadRegistry();
    expect(second).toBe(first);

    clearRegistryCacheForTests();
    const third = loadRegistry();
    expect(third).not.toBe(first);
    expect(third.all.map((entry) => entry.id)).toEqual(
      first.all.map((entry) => entry.id),
    );
  });

  it("resolves entries by id and by npm name", () => {
    const registry = loadRegistry();
    const probe = registry.all[0];
    expect(getEntry(registry, probe.id)).toBe(probe);

    const withNpmName = registry.all.find((entry) => entry.npmName);
    expect(withNpmName).toBeDefined();
    if (!withNpmName?.npmName) {
      throw new Error("expected at least one bundled entry with an npmName");
    }
    expect(getEntryByNpmName(registry, withNpmName.npmName)?.id).toBe(
      withNpmName.id,
    );
    expect(getEntryByNpmName(registry, "@elizaos/not-a-real-package")).toBe(
      undefined,
    );
  });

  it("rejects malformed runtime entries without mutating the store", () => {
    const baseline = loadRegistry();

    expect(() =>
      registerRegistryEntry({
        kind: "plugin",
        id: "Not Kebab",
        name: "Broken Fixture",
        subtype: "feature",
        render: renderHints(),
      } as unknown as RegistryEntry),
    ).toThrow(/registerRegistryEntry: entry failed validation/);

    expect(() =>
      registerRegistryEntry({
        kind: "plugin",
        id: "missing-name-fixture",
        subtype: "feature",
        render: renderHints(),
      } as unknown as RegistryEntry),
    ).toThrow(/registerRegistryEntry: entry failed validation/);

    const after = loadRegistry();
    expect(after.all.length).toBe(baseline.all.length);
    expect(after.byId.has("Not Kebab")).toBe(false);
    expect(after.byId.has("missing-name-fixture")).toBe(false);
  });

  it("exposes a newly registered runtime entry to the next load", () => {
    const baseline = loadRegistry().all.length;
    registerRegistryEntry(
      pluginFixture("test-overlay-new-entry", "Overlay New Entry"),
    );

    const loaded = loadRegistry();
    expect(loaded.all.length).toBe(baseline + 1);
    expect(loaded.byId.has("test-overlay-new-entry")).toBe(true);
    expect(
      getPlugins(loaded).some((p) => p.id === "test-overlay-new-entry"),
    ).toBe(true);

    const stored = getEntry(loaded, "test-overlay-new-entry");
    expect(stored?.kind).toBe("plugin");
    expect(stored?.source).toBe("bundled");
  });

  it("overrides a bundled twin by id instead of duplicating it", () => {
    const before = loadRegistry();
    const plugins = getPlugins(before);
    expect(plugins.length).toBeGreaterThan(0);
    const twin = plugins[0];

    registerRegistryEntry(
      pluginFixture(twin.id, `${twin.name} (runtime override)`),
    );

    const after = loadRegistry();
    expect(after.all.length).toBe(before.all.length);
    const overridden = getEntry(after, twin.id);
    expect(overridden?.name).toBe(`${twin.name} (runtime override)`);
    expect(overridden?.id).toBe(twin.id);
  });

  it("invalidates the cache when an entry is registered", () => {
    const warm = loadRegistry();
    registerRegistryEntry(
      pluginFixture("test-cache-invalidate-entry", "Cache Invalidate Entry"),
    );
    const refreshed = loadRegistry();
    expect(refreshed).not.toBe(warm);
    expect(refreshed.byId.has("test-cache-invalidate-entry")).toBe(true);
  });

  it("normalizes legacy connector auth onto accounts.agent", () => {
    registerRegistryEntry(
      connectorFixture("test-connector-token", "Token Connector", {
        kind: "token",
        credentialKeys: ["TEST_TOKEN_KEY"],
      }),
    );
    registerRegistryEntry(
      connectorFixture("test-connector-oauth", "OAuth Connector", {
        kind: "oauth",
        credentialKeys: [],
      }),
    );

    const registry = loadRegistry();

    const token = getEntry(registry, "test-connector-token");
    expect(token?.accounts?.agent).toEqual({
      supported: true,
      authKind: "api-key",
      credentialKeys: ["TEST_TOKEN_KEY"],
    });
    expect(token?.accounts?.owner).toBeUndefined();

    const oauth = getEntry(registry, "test-connector-oauth");
    expect(oauth?.accounts?.agent?.authKind).toBe("oauth-cloud");
  });
});
