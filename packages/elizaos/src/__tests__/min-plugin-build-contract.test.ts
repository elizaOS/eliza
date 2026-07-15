/**
 * Minimal plugin build-contract coverage for both checkout and packaged
 * scaffolds, where runtime loading requires emitted JavaScript under dist.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = fileURLToPath(new URL(".", import.meta.url));
const templateDir = resolve(here, "../../templates/min-plugin");

describe("min-plugin build contract", () => {
  it("uses an emitting build config and requires the loadable build step", () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(templateDir, "package.json"), "utf8"),
    ) as {
      scripts?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const buildConfig = JSON.parse(
      readFileSync(resolve(templateDir, "tsconfig.build.json"), "utf8"),
    ) as { compilerOptions?: Record<string, unknown>; include?: string[] };
    const scaffold = readFileSync(resolve(templateDir, "SCAFFOLD.md"), "utf8");

    expect(packageJson.scripts?.build).toContain("tsconfig.build.json");
    expect(packageJson.scripts?.lint).toBe("biome check src/");
    expect(packageJson.scripts?.lint).not.toContain("||");
    expect(packageJson.devDependencies?.["@biomejs/biome"]).toBe("2.5.1");
    expect(buildConfig.compilerOptions).toMatchObject({
      noEmit: false,
      outDir: "dist",
      rootDir: "src",
    });
    expect(buildConfig.include).toContain("src/**/*.tsx");
    expect(scaffold).toContain("bun install");
    expect(scaffold).toContain("bun run build");
    expect(scaffold).toContain("bundlePath");
  });
});
