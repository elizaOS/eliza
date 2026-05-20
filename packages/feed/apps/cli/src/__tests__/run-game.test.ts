/**
 * CLI game command tests.
 *
 * The public CLI no longer advertises simulation. These tests verify that the
 * help text stays honest and the legacy command fails with a clear message.
 */

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { spawnSync } from "bun";

const CLI_PATH = "src/index.ts";
const CLI_CWD = resolve(import.meta.dir, "..", "..");

describe("CLI Game Command", () => {
  test("omits simulate from game help", () => {
    const result = spawnSync(["bun", "run", CLI_PATH, "game", "--help"], {
      cwd: CLI_CWD,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).not.toContain("simulate");
  });

  test("fails clearly when the legacy simulate command is requested", () => {
    const result = spawnSync(
      ["bun", "run", CLI_PATH, "game", "simulate", "--fast"],
      {
        cwd: CLI_CWD,
      },
    );

    const output = `${result.stdout.toString()}\n${result.stderr.toString()}`;
    expect(result.exitCode).toBe(1);
    expect(output).toContain("Game simulation is not available in this CLI");
  });

  test("points users to supported alternatives", () => {
    const result = spawnSync(
      ["bun", "run", CLI_PATH, "game", "simulate", "--json"],
      {
        cwd: CLI_CWD,
      },
    );

    const output = `${result.stdout.toString()}\n${result.stderr.toString()}`;
    expect(output).toContain("feed game generate");
    expect(output).toContain("training/benchmark tooling");
  });
});
