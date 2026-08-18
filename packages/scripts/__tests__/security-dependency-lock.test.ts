/**
 * Guards security-sensitive transitive resolutions in the repository lockfile.
 * The assertions use advisory ranges rather than a single expected version so
 * safe upgrades remain possible while a routine lock refresh cannot silently
 * restore the vulnerable dependency graph.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import JSON5 from "json5";
import { satisfies } from "semver";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const lock = JSON5.parse(readFileSync(`${repoRoot}/bun.lock`, "utf8")) as {
  packages?: Record<string, unknown>;
};

function resolvedVersions(packageName: string): string[] {
  const prefix = `${packageName}@`;
  const versions = new Set<string>();
  for (const value of Object.values(lock.packages ?? {})) {
    if (!Array.isArray(value) || typeof value[0] !== "string") continue;
    if (value[0].startsWith(prefix))
      versions.add(value[0].slice(prefix.length));
  }
  return [...versions].sort();
}

describe("security-sensitive dependency resolutions", () => {
  it.each([
    {
      packageName: "js-yaml",
      vulnerableRange: ">=4.0.0 <4.3.1",
      expectedSafeVersion: "4.3.1",
    },
    {
      packageName: "brace-expansion",
      vulnerableRange: ">=4.0.0 <5.0.9",
      expectedSafeVersion: "5.0.9",
    },
    {
      packageName: "undici",
      vulnerableRange: ">=8.0.0 <8.10.0",
      expectedSafeVersion: "8.10.0",
    },
  ])(
    "$packageName has no resolution in its remediated advisory range",
    ({ packageName, vulnerableRange, expectedSafeVersion }) => {
      const versions = resolvedVersions(packageName);
      expect(versions).toContain(expectedSafeVersion);
      expect(
        versions.filter((version) => satisfies(version, vulnerableRange)),
      ).toEqual([]);
    },
  );
});
