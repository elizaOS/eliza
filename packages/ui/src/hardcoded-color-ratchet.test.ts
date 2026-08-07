/** Ensures production components cannot add hardcoded colors above the reviewed baseline. */

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("hardcoded color ratchet", () => {
  it("rejects new production color literals", () => {
    const packageRoot = fileURLToPath(new URL("..", import.meta.url));
    expect(() =>
      execFileSync("node", ["scripts/scan-hardcoded-colors.mjs"], {
        cwd: packageRoot,
        stdio: "pipe",
      }),
    ).not.toThrow();
  });
});
