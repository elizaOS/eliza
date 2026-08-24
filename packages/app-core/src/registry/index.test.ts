/**
 * Unit tests for the `@elizaos/app-core/registry` compatibility shim. Asserts
 * that the re-export surface delegates to the live first-party registry state
 * machine: cached loads and invalidation, runtime entry registration with
 * id-based replace and bundled-twin override, fail-loud entry validation,
 * legacy connector auth normalization, kind-narrowed lookups, curated-app
 * registration, and the runtime overlay merge — all exercised through the shim
 * exactly as plugin-registry and plugin-capacitor-bridge consume it.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConnectorEntry, RegistryEntry } from "./index";
import {
  clearRegistryCacheForTests,
  getApps,
  getConnectors,
  getEntry,
  getEntryByNpmName,
  getPlugins,
  getRegisteredCuratedApps,
  loadRegistry,
  mergeWithRuntime,
  registerCuratedApp,
  registerRegistryEntry,
  registryEntrySchema,
} from "./index";

// Unique prefix keeps these fixtures out of any real curated id namespace.
const ID_PREFIX = "compat-shim-test";

let nextId = 0;
function uniqueId(label: string): string {
  nextId += 1;
  return `${ID_PREFIX}-${label}-${nextId}`;
}

function appFixture(name: string, overrides?: Record<string, unknown>) {
  return registryEntrySchema.parse({
    kind: "app",
    id: uniqueId(name),
    name,
    subtype: "tool",
    launch: { type: "internal-tab" },
    render: { group: `${ID_PREFIX}-group` },
    ...overrides,
  }) as Extract<RegistryEntry, { kind: "app" }>;
}

function pluginFixture(name: string, overrides?: Record<string, unknown>) {
  return registryEntrySchema.parse({
    kind: "plugin",
    id: uniqueId(name),
    name,
    subtype: "feature",
    render: { group: `${ID_PREFIX}-group` },
    ...overrides,
  }) as Extract<RegistryEntry, { kind: "plugin" }>;
}

function connectorFixture(
  name: string,
  overrides?: Record<string, unknown>,
): Extract<RegistryEntry, { kind: "connector" }> {
  return registryEntrySchema.parse({
    kind: "connector",
    id: uniqueId(name),
    name,
    subtype: "messaging",
    render: { group: `${ID_PREFIX}-group` },
    ...overrides,
  }) as Extract<RegistryEntry, { kind: "connector" }>;
}

function expectConnector(entry: RegistryEntry): ConnectorEntry {
  if (entry.kind !== "connector") {
    throw new Error(`expected a connector entry, got kind "${entry.kind}"`);
  }
  return entry;
}

function mustLoad(entry: RegistryEntry | undefined): RegistryEntry {
  if (!entry) throw new Error("expected entry missing from loaded registry");
  return entry;
}

beforeEach(() => {
  clearRegistryCacheForTests();
});

afterEach(() => {
  clearRegistryCacheForTests();
});

describe("registry compatibility shim: loadRegistry", () => {
  it("returns the bundled catalog indexed by id, kind, group, and npm name", () => {
    const registry = loadRegistry();

    let bucketTotal = 0;
    for (const bucket of registry.byKind.values()) bucketTotal += bucket.length;
    expect(bucketTotal).toBe(registry.all.length);
    expect(registry.byId.size).toBe(registry.all.length);
    for (const [npmName, entry] of registry.byNpmName) {
      expect(npmName).toBe(entry.npmName);
      expect(registry.byId.get(entry.id)).toBe(entry);
    }
    for (const entry of registry.all) {
      expect(registry.byGroup.get(entry.render.group)).toContain(entry);
    }
  });

  it("partitions entries into the kind-narrowed accessors", () => {
    const registry = loadRegistry();

    expect(getApps(registry)).toEqual(registry.byKind.get("app"));
    expect(getPlugins(registry)).toEqual(registry.byKind.get("plugin"));
    expect(getConnectors(registry)).toEqual(registry.byKind.get("connector"));
    expect(getApps(registry)).toEqual(
      registry.all.filter((entry) => entry.kind === "app"),
    );
    expect(getPlugins(registry)).toEqual(
      registry.all.filter((entry) => entry.kind === "plugin"),
    );
    expect(getConnectors(registry)).toEqual(
      registry.all.filter((entry) => entry.kind === "connector"),
    );
  });

  it("serves repeat loads from the cache until a registration invalidates it", () => {
    const first = loadRegistry();
    expect(loadRegistry()).toBe(first);

    registerRegistryEntry(appFixture("cache-buster"));

    const second = loadRegistry();
    expect(second).not.toBe(first);
    expect(loadRegistry()).toBe(second);
  });
});

describe("registry compatibility shim: registerRegistryEntry", () => {
  it("contributes a new app observed by the next load", () => {
    const entry = appFixture("new-app");
    registerRegistryEntry(entry);

    const registry = loadRegistry();
    expect(getEntry(registry, entry.id)).toMatchObject({
      id: entry.id,
      name: entry.name,
      kind: "app",
    });
    expect(getApps(registry).map((e) => e.id)).toContain(entry.id);
  });

  it("replaces a same-id runtime registration instead of duplicating it", () => {
    const first = appFixture("replace-me");
    registerRegistryEntry(first);

    const second = registryEntrySchema.parse({
      ...first,
      name: `${first.name} v2`,
    });
    registerRegistryEntry(second);

    const registry = loadRegistry();
    const matches = getApps(registry).filter((e) => e.id === first.id);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.name).toBe(`${first.name} v2`);
  });

  it("lets a runtime entry win over a bundled twin with the same id", () => {
    const bundled = getApps(loadRegistry())[0];
    expect(bundled).toBeDefined();
    if (!bundled) throw new Error("bundled catalog has no app entries");

    try {
      registerRegistryEntry(
        registryEntrySchema.parse({
          ...bundled,
          name: "compat-shim override",
          description: "registered by the compat-shim suite",
        }),
      );

      const overridden = getEntry(loadRegistry(), bundled.id);
      expect(overridden?.name).toBe("compat-shim override");
      expect(overridden?.description).toBe(
        "registered by the compat-shim suite",
      );
      expect(overridden?.kind).toBe(bundled.kind);
    } finally {
      // Restore the bundled values so later loads see pristine catalog data.
      registerRegistryEntry(bundled);
    }
    expect(getEntry(loadRegistry(), bundled.id)?.name).toBe(bundled.name);
  });

  it("rejects malformed entries fail-loud without storing them", () => {
    expect(() =>
      registerRegistryEntry({
        kind: "app",
        id: "Rejected Uppercase Id",
        name: "malformed",
        subtype: "tool",
        // Missing the required `launch` block on purpose.
        render: { group: `${ID_PREFIX}-group` },
      } as unknown as RegistryEntry),
    ).toThrow(/failed validation/);

    expect(getEntry(loadRegistry(), "Rejected Uppercase Id")).toBeUndefined();
  });

  it("auto-maps legacy oauth auth onto accounts.agent", () => {
    const connector = connectorFixture("legacy-oauth", {
      auth: { kind: "oauth", credentialKeys: ["OAUTH_TOKEN"] },
    });
    registerRegistryEntry(connector);

    const stored = expectConnector(
      mustLoad(getEntry(loadRegistry(), connector.id)),
    );
    expect(stored.accounts?.agent).toEqual({
      supported: true,
      authKind: "oauth-cloud",
      credentialKeys: ["OAUTH_TOKEN"],
    });
  });

  it("coalesces token, credentials, and none onto their account auth kinds", () => {
    const tokenConnector = connectorFixture("legacy-token", {
      auth: { kind: "token", credentialKeys: ["API_TOKEN"] },
    });
    const credentialsConnector = connectorFixture("legacy-credentials", {
      auth: { kind: "credentials", credentialKeys: ["USER", "PASS"] },
    });
    const noneConnector = connectorFixture("legacy-none", {
      auth: { kind: "none", credentialKeys: [] },
    });
    registerRegistryEntry(tokenConnector);
    registerRegistryEntry(credentialsConnector);
    registerRegistryEntry(noneConnector);

    const registry = loadRegistry();
    expect(
      expectConnector(mustLoad(getEntry(registry, tokenConnector.id))).accounts
        ?.agent?.authKind,
    ).toBe("api-key");
    expect(
      expectConnector(mustLoad(getEntry(registry, credentialsConnector.id)))
        .accounts?.agent?.authKind,
    ).toBe("api-key");
    expect(
      expectConnector(mustLoad(getEntry(registry, noneConnector.id))).accounts
        ?.agent?.authKind,
    ).toBe("none");
  });

  it("keeps an explicit accounts.agent over the legacy auth mapping", () => {
    const connector = connectorFixture("explicit-agent", {
      auth: { kind: "oauth", credentialKeys: ["IGNORED"] },
      accounts: {
        agent: { supported: true, authKind: "qr", credentialKeys: ["QR"] },
      },
    });
    registerRegistryEntry(connector);

    const stored = expectConnector(
      mustLoad(getEntry(loadRegistry(), connector.id)),
    );
    expect(stored.accounts?.agent).toEqual({
      supported: true,
      authKind: "qr",
      credentialKeys: ["QR"],
    });
  });

  it("resolves registered entries by id and npm name and misses cleanly", () => {
    const entry = pluginFixture("lookup-target", {
      npmName: `@elizaos/${ID_PREFIX}-lookup-target`,
    });
    registerRegistryEntry(entry);

    const registry = loadRegistry();
    expect(getEntry(registry, entry.id)?.npmName).toBe(
      `@elizaos/${ID_PREFIX}-lookup-target`,
    );
    expect(getEntryByNpmName(registry, entry.npmName ?? "")?.id).toBe(entry.id);
    expect(getPlugins(registry).map((e) => e.id)).toContain(entry.id);

    expect(getEntry(registry, `${ID_PREFIX}-never-registered`)).toBeUndefined();
    expect(
      getEntryByNpmName(registry, `@elizaos/${ID_PREFIX}-missing`),
    ).toBeUndefined();
  });
});

describe("registry compatibility shim: curated apps", () => {
  it("registers curated apps keyed by slug and replaces on re-registration", () => {
    const slug = uniqueId("slug");
    registerCuratedApp({
      slug,
      canonicalName: "Compat Shim App",
      aliases: ["shim-app"],
    });

    let registered = getRegisteredCuratedApps();
    expect(registered.find((def) => def.slug === slug)).toEqual({
      slug,
      canonicalName: "Compat Shim App",
      aliases: ["shim-app"],
    });

    registerCuratedApp({
      slug,
      canonicalName: "Compat Shim App Renamed",
      aliases: [],
    });
    registered = getRegisteredCuratedApps();
    expect(registered.filter((def) => def.slug === slug)).toHaveLength(1);
    expect(registered.find((def) => def.slug === slug)?.canonicalName).toBe(
      "Compat Shim App Renamed",
    );
  });

  it("returns a defensive copy that callers cannot mutate the store through", () => {
    const slug = uniqueId("copy-check");
    registerCuratedApp({ slug, canonicalName: "Copy Check", aliases: [] });

    const snapshot = getRegisteredCuratedApps();
    const sizeBeforeMutation = snapshot.length;
    snapshot.push({ slug: "injected", canonicalName: "Injected", aliases: [] });

    const fresh = getRegisteredCuratedApps();
    expect(fresh).toHaveLength(sizeBeforeMutation);
    expect(fresh.find((def) => def.slug === "injected")).toBeUndefined();
  });
});

describe("registry compatibility shim: mergeWithRuntime", () => {
  it("applies matching overlays by id and defaults the rest to disabled", () => {
    const enabledEntry = appFixture("overlay-hit");
    const plainEntry = appFixture("overlay-miss");

    const merged = mergeWithRuntime(
      [enabledEntry, plainEntry],
      [
        {
          id: enabledEntry.id,
          enabled: true,
          configured: true,
          isActive: true,
          validationErrors: [{ field: "config", message: "stale key" }],
          validationWarnings: [],
        },
      ],
    );

    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({
      id: enabledEntry.id,
      name: enabledEntry.name,
      enabled: true,
      configured: true,
      isActive: true,
      validationErrors: [{ field: "config", message: "stale key" }],
      validationWarnings: [],
    });
    expect(merged[1]).toMatchObject({
      id: plainEntry.id,
      name: plainEntry.name,
      enabled: false,
      configured: false,
      isActive: false,
      validationErrors: [],
      validationWarnings: [],
    });
  });
});
