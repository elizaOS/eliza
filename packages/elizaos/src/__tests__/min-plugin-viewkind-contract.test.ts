/**
 * Minimal plugin scaffold contract test that reads SCAFFOLD.md directly and
 * verifies the view-kind guidance copied into generated plugin repos.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = fileURLToPath(new URL(".", import.meta.url));

describe("min-plugin VIEW_KIND_CONTRACT (#8917)", () => {
  it("documents all four view kinds and reserves system for built-ins", () => {
    const scaffold = readFileSync(
      resolve(here, "../../templates/min-plugin/SCAFFOLD.md"),
      "utf8",
    );

    expect(scaffold).toContain("VIEW_KIND_CONTRACT");
    expect(scaffold).toContain("`system`");
    expect(scaffold).toContain("`release`");
    expect(scaffold).toContain("`developer`");
    expect(scaffold).toContain("`preview`");
    expect(scaffold.toLowerCase()).toContain("reserved for built-ins");
  });
});
