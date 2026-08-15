/**
 * Packaging contract for the executable eliza-code ACP entrypoint. The built
 * Bun-target bundle must launch through Bun when invoked from the package bin
 * link; Node cannot execute the bundle's Bun-generated require bridge.
 */
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("eliza-code ACP package entrypoint", () => {
  it("selects Bun in the source shebang carried into dist/acp.js", async () => {
    const source = await readFile(new URL("./acp.ts", import.meta.url), "utf8");
    expect(source.split("\n", 1)[0]).toBe(
      "#!/usr/bin/env -S bun --conditions=eliza-source",
    );
  });
});
