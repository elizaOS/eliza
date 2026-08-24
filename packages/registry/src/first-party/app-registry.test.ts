/** Exercises the symbol-keyed curated-app store's register/replace/copy contract through its public functions against the real globalThis store. */
import { describe, expect, it } from "vitest";
import {
  type ElizaCuratedAppDefinition,
  getRegisteredCuratedApps,
  registerCuratedApp,
} from "./app-registry";

const REGISTRY_KEY = Symbol.for("elizaos.curated-app-registry");

function makeDef(
  slug: string,
  canonicalName = `Canonical ${slug}`,
  aliases: string[] = [],
): ElizaCuratedAppDefinition {
  return { slug, canonicalName, aliases };
}

describe("curated app registry", () => {
  it("registers a new definition and returns it from a later read", () => {
    const def = makeDef("app-registry-test-roundtrip", "Roundtrip App", [
      "rt-app",
    ]);
    const before = getRegisteredCuratedApps();

    registerCuratedApp(def);
    const after = getRegisteredCuratedApps();

    expect(after).toHaveLength(before.length + 1);
    expect(after[after.length - 1]).toBe(def);
    expect(after).toContainEqual({
      slug: "app-registry-test-roundtrip",
      canonicalName: "Roundtrip App",
      aliases: ["rt-app"],
    });
  });

  it("replaces an existing slug in place without disturbing neighbours", () => {
    const first = makeDef("app-registry-test-order-a");
    const second = makeDef("app-registry-test-order-b", "Original B", ["b"]);
    const third = makeDef("app-registry-test-order-c");

    registerCuratedApp(first);
    registerCuratedApp(second);
    registerCuratedApp(third);

    const beforeReplace = getRegisteredCuratedApps();
    expect(
      beforeReplace
        .filter((d) => d.slug.startsWith("app-registry-test-order"))
        .map((d) => d.slug),
    ).toEqual([
      "app-registry-test-order-a",
      "app-registry-test-order-b",
      "app-registry-test-order-c",
    ]);

    const replacement = makeDef("app-registry-test-order-b", "Replaced B", [
      "b2",
    ]);
    registerCuratedApp(replacement);

    const afterReplace = getRegisteredCuratedApps();
    expect(afterReplace).toHaveLength(beforeReplace.length);
    expect(
      afterReplace
        .filter((d) => d.slug.startsWith("app-registry-test-order"))
        .map((d) => d.slug),
    ).toEqual([
      "app-registry-test-order-a",
      "app-registry-test-order-b",
      "app-registry-test-order-c",
    ]);

    const bySlug = new Map(afterReplace.map((d) => [d.slug, d]));
    expect(bySlug.get("app-registry-test-order-b")).toBe(replacement);
    expect(bySlug.get("app-registry-test-order-b")).toMatchObject({
      canonicalName: "Replaced B",
      aliases: ["b2"],
    });
    expect(bySlug.get("app-registry-test-order-a")).toBe(first);
    expect(bySlug.get("app-registry-test-order-c")).toBe(third);
  });

  it("returns a defensive copy so caller mutations never reach the store", () => {
    const def = makeDef("app-registry-test-copy");
    registerCuratedApp(def);

    const snapshot = getRegisteredCuratedApps();
    snapshot.push(makeDef("app-registry-test-copy-intruder"));
    snapshot.pop();

    const fresh = getRegisteredCuratedApps();
    expect(fresh).not.toBe(snapshot);
    expect(fresh).toContain(def);
    expect(
      fresh.some((d) => d.slug === "app-registry-test-copy-intruder"),
    ).toBe(false);
  });

  it("shares one store with other consumers through the Symbol.for key", () => {
    const viaModule = makeDef("app-registry-test-global-module");
    registerCuratedApp(viaModule);

    const globalObject = globalThis as Record<PropertyKey, unknown>;
    const store = globalObject[REGISTRY_KEY] as {
      entries: ElizaCuratedAppDefinition[];
    };

    expect(Array.isArray(store.entries)).toBe(true);
    expect(store.entries).toContain(viaModule);

    const viaGlobal = makeDef("app-registry-test-global-direct");
    store.entries.push(viaGlobal);

    expect(getRegisteredCuratedApps()).toContain(viaGlobal);
  });

  it("lazily creates a fresh empty store when the global key is absent", () => {
    const globalObject = globalThis as Record<PropertyKey, unknown>;
    const previous = globalObject[REGISTRY_KEY];
    delete globalObject[REGISTRY_KEY];

    try {
      expect(getRegisteredCuratedApps()).toEqual([]);

      const def = makeDef("app-registry-test-fresh");
      registerCuratedApp(def);
      expect(getRegisteredCuratedApps()).toEqual([def]);
    } finally {
      if (previous === undefined) {
        delete globalObject[REGISTRY_KEY];
      } else {
        globalObject[REGISTRY_KEY] = previous;
      }
    }
  });
});
