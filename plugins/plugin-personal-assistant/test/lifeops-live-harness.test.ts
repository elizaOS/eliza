/**
 * Deterministic contract for the LifeOps live harness repository boundary.
 * The live child must start in the monorepo root where the start:eliza script
 * is declared.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "./helpers/lifeops-live-harness.ts";

describe("LifeOps live harness repository boundary", () => {
  it("resolves the package that owns start:eliza", async () => {
    const manifest = JSON.parse(
      await readFile(path.join(REPO_ROOT, "package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };
    expect(manifest.scripts?.["start:eliza"]).toContain(
      "packages/app-core/src/entry.ts start",
    );
  });
});
