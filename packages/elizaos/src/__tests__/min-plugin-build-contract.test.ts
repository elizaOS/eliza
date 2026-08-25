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
const rootPackageJson = JSON.parse(
  readFileSync(resolve(templateDir, "../../../../package.json"), "utf8"),
) as { devDependencies: Record<string, string> };
const canonicalBiomeVersion = rootPackageJson.devDependencies["@biomejs/biome"];
const canonicalTsc6Version =
  rootPackageJson.devDependencies["@typescript/typescript6"];

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

    expect(packageJson.scripts?.build).toBe(
      "tsc6 --noCheck -p tsconfig.build.json",
    );
    // The tsc6 bin only exists when the scaffold itself depends on the
    // renamed-bin package; the monorepo root provides it here, but a
    // standalone `bun install` of the scaffold does not (#16655 gap).
    expect(packageJson.devDependencies?.["@typescript/typescript6"]).toBe(
      canonicalTsc6Version,
    );
    expect(packageJson.scripts?.lint).toBe("biome check src/");
    expect(packageJson.scripts?.["lint:check"]).toBe("biome check src/");
    expect(packageJson.scripts?.lint).not.toContain("||");
    expect(packageJson.scripts?.["lint:check"]).not.toContain("||");
    expect(packageJson.devDependencies?.["@biomejs/biome"]).toBe(
      canonicalBiomeVersion,
    );
    expect(buildConfig.compilerOptions).toMatchObject({
      noEmit: false,
      outDir: "dist",
      rootDir: "src",
    });
    expect(buildConfig.include).toContain("src/**/*.tsx");
    // Without a shipped biome config, a standalone `biome check src/` runs on
    // Biome defaults (tab indentation) and rejects the scaffold's own source.
    const biomeConfig = JSON.parse(
      readFileSync(resolve(templateDir, "biome.json"), "utf8"),
    ) as { $schema?: string; formatter?: { indentStyle?: string } };
    expect(biomeConfig.$schema).toContain(canonicalBiomeVersion);
    expect(biomeConfig.formatter?.indentStyle).toBe("space");
    expect(scaffold).toContain("bun install");
    expect(scaffold).toContain("bun run build");
    expect(scaffold).toContain("bundlePath");
  });
});
