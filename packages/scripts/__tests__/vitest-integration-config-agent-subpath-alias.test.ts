/**
 * Verifies the integration lane resolves the agent knowledge-graph directory
 * export to source without requiring a prebuilt agent distribution.
 */

import { existsSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import integrationConfig from "../vitest/integration.config.ts";

interface AliasEntry {
  find: string | RegExp;
  replacement: string;
}

function matches(find: string | RegExp, importee: string): boolean {
  if (find instanceof RegExp) return find.test(importee);
  return importee === find || importee.startsWith(`${find}/`);
}

describe("integration.config.ts agent directory export", () => {
  it("resolves the knowledge-graph subpath to its source index", () => {
    const aliases = (integrationConfig as { resolve?: { alias?: unknown } })
      .resolve?.alias;
    expect(Array.isArray(aliases)).toBe(true);

    const specifier = "@elizaos/agent/services/knowledge-graph";
    const entry = (aliases as AliasEntry[]).find(({ find }) =>
      matches(find, specifier),
    );
    const resolved = entry
      ? specifier.replace(entry.find, entry.replacement)
      : undefined;

    expect(resolved).toBeDefined();
    expect(
      existsSync(resolved as string) && statSync(resolved as string).isFile(),
    ).toBe(true);
    expect(resolved).toMatch(
      /packages\/agent\/src\/services\/knowledge-graph\/index\.ts$/,
    );
  });
});
