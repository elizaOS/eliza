/**
 * Guards declaration emit against following workspace aliases back into source
 * trees, where TypeScript can leave ignored JavaScript beside TypeScript files.
 */

import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

interface BuildConfig {
  compilerOptions?: {
    paths?: Record<string, string[]>;
  };
}

describe("cloud UI build boundary", () => {
  test("resolves workspace dependencies through built declarations", () => {
    const config = JSON.parse(
      readFileSync(new URL("../tsconfig.build.json", import.meta.url), "utf8"),
    ) as BuildConfig;
    const targets = Object.values(config.compilerOptions?.paths ?? {}).flat();

    expect(targets).not.toHaveLength(0);
    expect(targets.every((target) => target.includes("/dist/"))).toBe(true);
    expect(targets.every((target) => !target.includes("/src/"))).toBe(true);
  });
});
