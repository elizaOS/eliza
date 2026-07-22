/** Exercises the Flatpak build driver as its real CLI subprocess boundary. */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./build-flatpak.mjs", import.meta.url));

describe("Flatpak build CLI contract", () => {
  it("reaches the platform boundary and reports its result observably", () => {
    const result = spawnSync(
      process.execPath,
      [SCRIPT, "--variant", "invalid"],
      {
        encoding: "utf8",
      },
    );

    if (process.platform === "linux") {
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "ELIZA_BUILD_VARIANT must be 'store' or 'direct'",
      );
      return;
    }

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("Flatpak only builds on Linux");
  });
});
