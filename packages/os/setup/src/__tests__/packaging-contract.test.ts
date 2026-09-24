// Ensures the packaged setup app retains its fail-closed Android installer.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("setup packaging contract", () => {
  it("copies the canonical installer and both validators", () => {
    const config = readFileSync(
      resolve(process.cwd(), "electrobun.config.ts"),
      "utf8",
    );
    expect(config).toContain(
      '"../android/installer/install-elizaos-android.sh"',
    );
    expect(config).toContain(
      '"../android/installer/scripts/validate-release-manifest.mjs"',
    );
    expect(config).toContain(
      '"../android/installer/scripts/validate-post-flash.sh"',
    );
  });
});
