/**
 * Regression: the curated-app registry store is a Symbol.for global shared by
 * every loaded copy of this module, but the name-lookup map is module-local.
 * An app registered through one module instance must still resolve from a
 * second, freshly loaded instance (the live dual src/dist module graph), or
 * launch fails with "not found in the registry" for a registered app.
 */
import { describe, expect, it, vi } from "vitest";
import type { ElizaCuratedAppDefinition } from "./apps.ts";

describe("curated app registry across module instances", () => {
  it("resolves an app registered through a different copy of this module", async () => {
    vi.resetModules();
    const first = await import("./apps.ts");
    const def = {
      slug: "xinst-app",
      canonicalName: "xinst-app",
      aliases: [],
      directory: "/tmp/xinst-app",
      displayName: "XInst",
      isolation: "none",
      trust: "external",
    } as unknown as ElizaCuratedAppDefinition;
    first.registerCuratedApp(def);

    vi.resetModules();
    const second = await import("./apps.ts");
    expect(second.normalizeElizaCuratedAppName("xinst-app")).toBe("xinst-app");
    expect(
      second.getCuratedAppDefinitions().some((d) => d.slug === "xinst-app"),
    ).toBe(true);
  });
});
