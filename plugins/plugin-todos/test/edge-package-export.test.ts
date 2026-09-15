/** Proves the published package exposes a loadable Worker-safe Todo runtime. */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(pluginRoot, "../..");
const temporaryDirectories: string[] = [];

function run(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result.stdout;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Todo edge package export", () => {
  test("loads the packed edge entry under the worker condition", () => {
    // Pack the complete distributable. A JS-only build clears dist, including
    // the dashboard bundle, and used to leave the local view unavailable.
    run("bun", ["run", "build"], pluginRoot);

    const temporaryDirectory = mkdtempSync(
      join(repositoryRoot, ".tmp-plugin-todos-pack-"),
    );
    temporaryDirectories.push(temporaryDirectory);
    const packJson = run(
      "npm",
      [
        "pack",
        "--json",
        "--ignore-scripts",
        "--pack-destination",
        temporaryDirectory,
        pluginRoot,
      ],
      pluginRoot,
    );
    const [{ filename }] = JSON.parse(packJson) as Array<{ filename: string }>;
    expect(filename).toBeTruthy();

    const packageDirectory = join(
      temporaryDirectory,
      "node_modules",
      "@elizaos",
      "plugin-todos",
    );
    mkdirSync(packageDirectory, { recursive: true });
    symlinkSync(
      join(pluginRoot, "node_modules", "drizzle-orm"),
      join(temporaryDirectory, "node_modules", "drizzle-orm"),
      "dir",
    );
    run(
      "tar",
      [
        "-xzf",
        join(temporaryDirectory, filename),
        "-C",
        packageDirectory,
        "--strip-components=1",
      ],
      temporaryDirectory,
    );

    expect(existsSync(join(packageDirectory, "dist/views/bundle.js"))).toBe(
      true,
    );

    const output = run(
      "node",
      [
        "--conditions=worker",
        "--input-type=module",
        "--eval",
        'const edge = await import("@elizaos/plugin-todos/edge"); process.stdout.write(JSON.stringify({ converge: typeof edge.convergeTodoScopesInTransaction, plugin: typeof edge.createTodosEdgePlugin, store: typeof edge.createTodosSqlStore }));',
      ],
      temporaryDirectory,
    );
    expect(JSON.parse(output)).toEqual({
      converge: "function",
      plugin: "function",
      store: "function",
    });
  }, 180_000);
});
