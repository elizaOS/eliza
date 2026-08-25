/**
 * Keeps standalone app scaffolds on the repository's pinned, fail-closed Biome validation contract.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const templatesRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../templates",
);
const repositoryManifestPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../package.json",
);

function readJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(path.join(templatesRoot, relativePath), "utf8"),
  );
}

const repositoryManifest = JSON.parse(
  readFileSync(repositoryManifestPath, "utf8"),
) as {
  devDependencies?: Record<string, unknown>;
};
const pinnedBiomeVersion =
  repositoryManifest.devDependencies?.["@biomejs/biome"];
if (typeof pinnedBiomeVersion !== "string") {
  throw new TypeError("The repository must pin @biomejs/biome");
}

describe("standalone template Biome contract", () => {
  for (const templateRoot of ["min-project", "plugin", "project/apps/app"]) {
    it(`${templateRoot} pins Biome and exposes strict lint commands`, () => {
      const manifest = readJson(`${templateRoot}/package.json`) as {
        scripts: Record<string, string>;
        devDependencies: Record<string, string>;
      };
      const config = readJson(`${templateRoot}/biome.json`) as {
        $schema: string;
      };

      expect(manifest.devDependencies["@biomejs/biome"]).toBe(
        pinnedBiomeVersion,
      );
      expect(manifest.scripts.lint).toMatch(/^biome check\b/);
      expect(manifest.scripts["lint:check"]).toMatch(/^biome check\b/);
      expect(manifest.scripts.lint).not.toContain("||");
      expect(manifest.scripts["lint:check"]).not.toContain("||");
      expect(config.$schema).toBe(
        `https://biomejs.dev/schemas/${pinnedBiomeVersion}/schema.json`,
      );
    });
  }
});
