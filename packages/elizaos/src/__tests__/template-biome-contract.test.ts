/**
 * Keeps standalone app scaffolds on the repository's pinned, fail-closed Biome validation contract.
 * The expected version is derived from the monorepo root package.json pin so a routine Biome bump
 * cannot break this contract, while a template that drifts from the root pin still fails.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const templatesRoot = path.resolve(testDir, "../../templates");

// Walk up from the test file to the monorepo root (the first package.json declaring
// workspaces) so the contract follows the canonical pin wherever the repo is checked out.
function findRepoRootPackageJson(startDir: string): Record<string, unknown> {
  let dir = startDir;
  while (true) {
    const candidate = path.join(dir, "package.json");
    if (existsSync(candidate)) {
      const parsed = JSON.parse(readFileSync(candidate, "utf8")) as Record<
        string,
        unknown
      >;
      if (parsed.workspaces !== undefined) {
        return parsed;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(
        `Could not locate monorepo root package.json above ${startDir}`,
      );
    }
    dir = parent;
  }
}

function canonicalBiomeVersion(): string {
  const rootManifest = findRepoRootPackageJson(testDir) as {
    devDependencies?: Record<string, string>;
  };
  const version = rootManifest.devDependencies?.["@biomejs/biome"];
  if (version === undefined) {
    throw new Error(
      "Root package.json is missing the @biomejs/biome devDependency pin",
    );
  }
  // The root pin must be an exact version; a range would make the contract ambiguous.
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(
      `Root @biomejs/biome pin must be an exact version, got "${version}"`,
    );
  }
  return version;
}

function readJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(path.join(templatesRoot, relativePath), "utf8"),
  );
}

describe("standalone template Biome contract", () => {
  const biomeVersion = canonicalBiomeVersion();

  for (const templateRoot of ["min-project", "plugin", "project/apps/app"]) {
    it(`${templateRoot} pins Biome and exposes strict lint commands`, () => {
      const manifest = readJson(`${templateRoot}/package.json`) as {
        scripts: Record<string, string>;
        devDependencies: Record<string, string>;
      };
      const config = readJson(`${templateRoot}/biome.json`) as {
        $schema: string;
      };

      expect(manifest.devDependencies["@biomejs/biome"]).toBe(biomeVersion);
      expect(manifest.scripts.lint).toMatch(/^biome check\b/);
      expect(manifest.scripts["lint:check"]).toMatch(/^biome check\b/);
      expect(manifest.scripts.lint).not.toContain("||");
      expect(manifest.scripts["lint:check"]).not.toContain("||");
      expect(config.$schema).toBe(
        `https://biomejs.dev/schemas/${biomeVersion}/schema.json`,
      );
    });
  }
});
