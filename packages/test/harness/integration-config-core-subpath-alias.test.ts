/**
 * Regression test for #11047 — the integration lane's `@elizaos/core` alias
 * must be subpath-aware.
 *
 * A bare-string `resolve.alias` entry is prefix-matched by Vite/rollup
 * (`importee === find || importee.startsWith(find + "/")`), so a string
 * "@elizaos/core" alias rewrote "@elizaos/core/node" (imported by plugin
 * dists), "@elizaos/core/testing" (imported by this harness), and
 * "@elizaos/core/connectors" (imported by connector plugins) into
 * "<core entry file>/<subpath>" — a path nested under a *file*, which fails
 * with ENOTDIR and killed every plugins/*\/test integration test in the lane.
 *
 * This test replays rollup's documented alias-matching semantics against the
 * config's actual alias list and asserts each core specifier lands on a real
 * file on disk.
 */
import { existsSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import integrationConfig from "../vitest/integration.config.ts";

interface AliasEntry {
  find: string | RegExp;
  replacement: string;
}

function getIntegrationAliases(): AliasEntry[] {
  const alias = (integrationConfig as { resolve?: { alias?: unknown } }).resolve
    ?.alias;
  if (!Array.isArray(alias)) {
    throw new Error(
      "integration.config.ts must define resolve.alias as an array",
    );
  }
  return alias as AliasEntry[];
}

/**
 * @rollup/plugin-alias matching: a RegExp `find` matches via test(); a string
 * `find` matches the exact importee or any subpath under it. The first
 * matching entry wins and the importee is rewritten with String.replace —
 * exactly how the ENOTDIR rewrite in #11047 was produced.
 */
function matches(find: string | RegExp, importee: string): boolean {
  if (find instanceof RegExp) {
    return find.test(importee);
  }
  if (importee.length < find.length) {
    return false;
  }
  if (importee === find) {
    return true;
  }
  return importee.startsWith(`${find}/`);
}

function resolveThroughAliases(
  aliases: AliasEntry[],
  importee: string,
): string | undefined {
  const entry = aliases.find(({ find }) => matches(find, importee));
  return entry ? importee.replace(entry.find, entry.replacement) : undefined;
}

describe("integration.config.ts @elizaos/core alias (#11047)", () => {
  const coreSpecifiers = [
    "@elizaos/core",
    "@elizaos/core/node",
    "@elizaos/core/testing",
    "@elizaos/core/connectors",
  ] as const;

  it.each(coreSpecifiers)("resolves %s to a real file", (specifier) => {
    const resolved = resolveThroughAliases(getIntegrationAliases(), specifier);
    expect(
      resolved,
      `${specifier} must be handled by the alias list`,
    ).toBeDefined();
    const target = resolved as string;
    expect(
      existsSync(target) && statSync(target).isFile(),
      `${specifier} resolved to "${target}", which is not a file — a ` +
        "prefix-matching alias rewrote the subpath under the core entry file " +
        "(ENOTDIR, #11047)",
    ).toBe(true);
  });

  it("source-aliases other @elizaos/core subpaths to a real sibling file, never ENOTDIR", () => {
    // The lane's generic source alias maps every remaining `@elizaos/core/<x>`
    // to its `src/<x>.ts` sibling — Vite's SSR resolver ignores the package's
    // `eliza-source` export condition and would otherwise pick unbuilt dist.
    // The #11047 guarantee still holds: the rewrite lands on a real FILE, never
    // an ENOTDIR path nested under the core entry file. `@elizaos/core/roles`
    // (a real export since #14904) is the representative subpath.
    const resolved = resolveThroughAliases(
      getIntegrationAliases(),
      "@elizaos/core/roles",
    );
    expect(resolved, "@elizaos/core/roles must resolve").toBeDefined();
    const target = resolved as string;
    expect(
      existsSync(target) && statSync(target).isFile(),
      `@elizaos/core/roles resolved to "${target}", which is not a file (ENOTDIR, #11047)`,
    ).toBe(true);
  });
});
