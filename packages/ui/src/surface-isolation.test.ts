/**
 * Keeps the isolation catalogue (the durable isolation-level doc) honest: every
 * declared {@link SurfaceIsolationLevel} has an entry whose `level` matches its
 * key, and the levels the catalogue documents are exactly the ones the core type
 * declares — so the doc cannot silently omit or invent a level.
 */

import { SURFACE_ISOLATION_LEVELS } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  isolationEntry,
  SURFACE_ISOLATION_CATALOGUE,
} from "./surface-isolation";

describe("surface-isolation catalogue", () => {
  it("documents exactly the core-declared isolation levels", () => {
    expect(Object.keys(SURFACE_ISOLATION_CATALOGUE).sort()).toEqual(
      [...SURFACE_ISOLATION_LEVELS].sort(),
    );
  });

  it("every entry's level matches its key and carries a rationale", () => {
    for (const level of SURFACE_ISOLATION_LEVELS) {
      const entry = isolationEntry(level);
      expect(entry.level).toBe(level);
      expect(entry.rationale.length).toBeGreaterThan(20);
    }
  });

  it("the browser surface is documented native-webview (untrusted web content)", () => {
    expect(isolationEntry("native-webview").examples).toContain("browser");
  });

  it("trusted first-party shell pages are documented in-process", () => {
    const examples = isolationEntry("in-process").examples;
    expect(examples).toContain("chat");
    expect(examples).toContain("settings");
  });
});
