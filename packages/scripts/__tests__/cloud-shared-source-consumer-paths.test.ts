/**
 * Guards workspace resolution for packages that typecheck Cloud Shared source.
 * Each consumer must resolve core and Worker-safe plugin entrypoints from source
 * instead of depending on a concurrently generated dist directory.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import JSON5 from "json5";

const repoRoot = resolve(import.meta.dir, "../../..");
const cloudRoot = resolve(repoRoot, "packages/cloud");
const edgeModules = [
  "@elizaos/plugin-scheduling/edge",
  "@elizaos/plugin-todos/edge",
  "@elizaos/plugin-web-search/edge",
] as const;
const coreModules = {
  "@elizaos/core": "src/index.node.ts",
  "@elizaos/core/*": "src/*",
  "@elizaos/core/edge": "src/index.edge.ts",
} as const;

type Tsconfig = {
  compilerOptions?: {
    paths?: Record<string, string[]>;
  };
};

function collectTsconfigs(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (["dist", "node_modules", ".turbo"].includes(entry.name)) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTsconfigs(path));
    } else if (/^tsconfig.*\.json$/.test(entry.name)) {
      files.push(path);
    }
  }
  return files;
}

describe("Cloud Shared source-consumer edge paths", () => {
  test("resolves every edge import from tracked source", () => {
    const sharedTsconfig = resolve(cloudRoot, "shared/tsconfig.json");
    const consumers = [
      ...new Set([
        ...collectTsconfigs(cloudRoot).filter((path) =>
          readFileSync(path, "utf8").includes("shared/src"),
        ),
        sharedTsconfig,
      ]),
    ];

    expect(consumers.map((path) => relative(repoRoot, path)).sort()).toEqual([
      "packages/cloud/api/tsconfig.json",
      "packages/cloud/e2e/tsconfig.json",
      "packages/cloud/services/container-control-plane/tsconfig.json",
      "packages/cloud/shared/tsconfig.json",
    ]);

    for (const path of consumers) {
      const config = JSON5.parse(readFileSync(path, "utf8")) as Tsconfig;
      for (const [moduleName, expectedSuffix] of Object.entries(coreModules)) {
        const targets = config.compilerOptions?.paths?.[moduleName];
        expect(
          targets,
          `${relative(repoRoot, path)} maps ${moduleName}`,
        ).toHaveLength(1);
        const target = resolve(dirname(path), targets?.[0] ?? "");
        expect(target.endsWith(expectedSuffix)).toBe(true);
      }
      for (const moduleName of edgeModules) {
        const targets = config.compilerOptions?.paths?.[moduleName];
        expect(
          targets,
          `${relative(repoRoot, path)} maps ${moduleName}`,
        ).toHaveLength(1);
        const target = resolve(dirname(path), targets?.[0] ?? "");
        expect(target.endsWith("/src/edge.ts")).toBe(true);
        expect(existsSync(target)).toBe(true);
      }
    }
  });
});
