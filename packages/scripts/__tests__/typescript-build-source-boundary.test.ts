/**
 * Guards emitting TypeScript builds against following source aliases into sibling workspaces,
 * where rootDir-relative output paths can escape the package's dist directory.
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
const tscPackage = createRequire(import.meta.url).resolve(
  "typescript/package.json",
);
const tsc = path.resolve(path.dirname(tscPackage), "bin/tsc");

const emittingBuilds = [
  { name: "@elizaos/cloud-ui", directory: "packages/cloud-ui" },
  { name: "@elizaos/agent", directory: "packages/agent" },
  { name: "@elizaos/scenario-runner", directory: "packages/scenario-runner" },
  {
    name: "@elizaos/plugin-app-manager",
    directory: "plugins/plugin-app-manager",
  },
  { name: "@elizaos/plugin-pii-guard", directory: "plugins/plugin-pii-guard" },
] as const;

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function isWorkspaceTypeScriptSource(file: string): boolean {
  const relative = path.relative(repoRoot, file);
  if (relative === "" || relative.startsWith(`..${path.sep}`)) return false;

  const [workspaceRoot] = relative.split(path.sep);
  if (workspaceRoot !== "packages" && workspaceRoot !== "plugins") return false;
  if (!/\.(?:ts|tsx|mts|cts)$/u.test(file)) return false;
  return !/\.d\.(?:ts|mts|cts)$/u.test(file);
}

function workspaceOwner(file: string): string {
  return path.relative(repoRoot, file).split(path.sep).slice(0, 2).join("/");
}

describe("TypeScript emitting build boundaries", () => {
  it.each(
    emittingBuilds,
  )("$name keeps non-declaration workspace sources inside its package", ({
    name,
    directory,
  }) => {
    const packageRoot = path.resolve(repoRoot, directory);
    const result = spawnSync(
      process.execPath,
      [
        tsc,
        "--project",
        "tsconfig.build.json",
        "--noEmit",
        "--listFilesOnly",
        "--pretty",
        "false",
      ],
      {
        cwd: packageRoot,
        encoding: "utf8",
      },
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const externalSources = result.stdout
      .split(/\r?\n/u)
      .map((file) => file.trim())
      .filter(Boolean)
      .map((file) => path.resolve(packageRoot, file))
      .filter(isWorkspaceTypeScriptSource)
      .filter((file) => !isWithin(packageRoot, file));
    const owners = [...new Set(externalSources.map(workspaceOwner))].sort();

    expect(
      { count: externalSources.length, owners },
      `${name} build graph crosses its package boundary`,
    ).toEqual({ count: 0, owners: [] });
  });
});
