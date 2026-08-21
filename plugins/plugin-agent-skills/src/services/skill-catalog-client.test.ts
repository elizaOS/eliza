/** Deterministic regression coverage for catalog search result bounds. */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  _resetCatalogCache,
  getTrendingSkills,
  refreshCatalog,
  searchCatalogSkills,
} from "./skill-catalog-client";

describe("searchCatalogSkills", () => {
  let catalogDir: string;
  let previousCatalogPath: string | undefined;

  beforeEach(async () => {
    previousCatalogPath = process.env.ELIZA_SKILLS_CATALOG;
    catalogDir = await fs.mkdtemp(path.join(os.tmpdir(), "eliza-skill-catalog-"));
    process.env.ELIZA_SKILLS_CATALOG = path.join(catalogDir, "catalog.json");
    await fs.writeFile(
      process.env.ELIZA_SKILLS_CATALOG,
      JSON.stringify({
        data: [
          {
            slug: "alpha",
            displayName: "Alpha",
            summary: "alpha skill",
            tags: {},
            stats: { comments: 0, downloads: 1, installsAllTime: 0, installsCurrent: 0, stars: 0, versions: 1 },
            createdAt: 0,
            updatedAt: 0,
            latestVersion: null,
          },
          {
            slug: "beta",
            displayName: "Beta",
            summary: "beta skill",
            tags: {},
            stats: { comments: 0, downloads: 1, installsAllTime: 0, installsCurrent: 0, stars: 0, versions: 1 },
            createdAt: 0,
            updatedAt: 0,
            latestVersion: null,
          },
        ],
      }),
    );
    await refreshCatalog();
  });

  afterEach(async () => {
    _resetCatalogCache();
    if (previousCatalogPath === undefined) {
      delete process.env.ELIZA_SKILLS_CATALOG;
    } else {
      process.env.ELIZA_SKILLS_CATALOG = previousCatalogPath;
    }
    await fs.rm(catalogDir, { recursive: true, force: true });
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])(
    "rejects invalid search limit %s",
    async (limit) => {
      await expect(searchCatalogSkills("skill", limit)).rejects.toThrow(
        "searchCatalogSkills limit must be a non-negative safe integer",
      );
    },
  );

  it("accepts zero and positive safe-integer search limits", async () => {
    await expect(searchCatalogSkills("skill", 0)).resolves.toEqual([]);
    await expect(searchCatalogSkills("skill", 1)).resolves.toHaveLength(1);
  });

  it("applies the same bounds contract to trending results", async () => {
    await expect(getTrendingSkills(-1)).rejects.toThrow(
      "getTrendingSkills limit must be a non-negative safe integer",
    );
    await expect(getTrendingSkills(1)).resolves.toHaveLength(1);
  });
});
