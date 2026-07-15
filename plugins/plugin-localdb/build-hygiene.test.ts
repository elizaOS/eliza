import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = dirname(fileURLToPath(import.meta.url));
const dependencyRoot = resolve(packageRoot, "../plugin-inmemorydb");
const tscPackage = createRequire(import.meta.url).resolve(
  "typescript/package.json",
);
const tsc = resolve(dirname(tscPackage), "bin/tsc");

function leakedDependencyDeclarations(): string[] {
  return readdirSync(dependencyRoot)
    .filter((name) => /\.d\.ts(?:\.map)?$/.test(name))
    .sort();
}

describe("plugin-localdb declaration build", () => {
  it("keeps workspace dependency declarations out of their source tree", () => {
    expect(leakedDependencyDeclarations()).toEqual([]);

    const result = spawnSync(
      process.execPath,
      [tsc, "--project", "tsconfig.build.json", "--noCheck"],
      {
        cwd: packageRoot,
        encoding: "utf8",
      },
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(leakedDependencyDeclarations()).toEqual([]);
  });
});
