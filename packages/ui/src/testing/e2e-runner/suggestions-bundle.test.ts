/**
 * Regression test for the proactive-suggestions browser fixture bundle. Runs
 * the REAL esbuild build with the exact options `run-suggestions-e2e.mjs`
 * phase 2 uses, so a new server-only edge in the fixture graph fails here
 * instead of in the UI Core Fixture E2E lane.
 *
 * The lane broke when `api/client` grew a value-import of `@elizaos/core`:
 * `eliza-source` outranks `browser`, esbuild resolved core to its Node barrel,
 * and the build died on 72 unresolved `node:*` imports. Asserting the bundle
 * builds and carries no unresolved builtin is the honest contract.
 */
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import { suggestionsFixtureBuildOptions } from "../../components/pages/__e2e__/suggestions-bundle";

describe("suggestions fixture browser bundle", () => {
  it("bundles for the browser with no unresolved node builtin", async () => {
    const result = await build(suggestionsFixtureBuildOptions());

    expect(result.errors).toEqual([]);
    const output = result.outputFiles?.[0]?.text;
    expect(typeof output).toBe("string");
    expect(output).not.toMatch(/require\(["']node:/);
  }, 120_000);
});
